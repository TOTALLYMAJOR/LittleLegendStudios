import { type JobType, type ScriptPayload, assertOrderTransition, type OrderStatus } from '@little/shared';
import { QueueEvents, Worker } from 'bullmq';

import {
  buildJsonBytes,
  buildStubJpegBytes,
  buildStubMp3Bytes,
  buildStubMp4Bytes,
  createSignedDownloadUrl,
  uploadAssetBytes
} from './assets.js';
import { query } from './db.js';
import { env } from './env.js';
import type { WorkerUpload } from './providers.js';
import { buildProviderRegistry } from './providers.js';
import { createRefund, isStripeRefundEnabled } from './stripe.js';

const QUEUE_NAME = 'render-orders';
const providers = buildProviderRegistry();

interface OrderRow {
  id: string;
  status: OrderStatus;
  user_id: string;
  stripe_payment_intent_id: string | null;
}

interface ScriptRow {
  script_json: ScriptPayload;
}

interface UploadRow {
  kind: 'photo' | 'voice';
  s3_key: string;
  content_type: string;
  bytes: number;
  sha256: string | null;
}

type ArtifactKind =
  | 'voice_clone_meta'
  | 'audio_narration'
  | 'audio_dialogue'
  | 'character_refs'
  | 'shot_video'
  | 'final_video'
  | 'thumbnail';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getOrder(orderId: string): Promise<OrderRow | null> {
  const rows = await query<OrderRow>('SELECT id, status, user_id, stripe_payment_intent_id FROM orders WHERE id = $1', [orderId]);
  return rows[0] ?? null;
}

async function setOrderStatus(orderId: string, nextStatus: OrderStatus): Promise<void> {
  const order = await getOrder(orderId);
  if (!order) {
    throw new Error('Order not found');
  }

  assertOrderTransition(order.status, nextStatus);

  await query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [orderId, nextStatus]);
}

async function transitionIfCurrent(
  orderId: string,
  allowedCurrentStatuses: OrderStatus[],
  nextStatus: OrderStatus
): Promise<boolean> {
  const order = await getOrder(orderId);
  if (!order) {
    throw new Error('Order not found');
  }

  if (!allowedCurrentStatuses.includes(order.status)) {
    return false;
  }

  await setOrderStatus(orderId, nextStatus);
  return true;
}

async function runStepWithInput(
  orderId: string,
  type: JobType,
  attempt: number,
  input: Record<string, unknown>,
  output?: Record<string, unknown>,
  provider = 'stub_provider'
): Promise<void> {
  const [jobRow] = await query<{ id: string }>(
    `
    INSERT INTO jobs (order_id, type, status, attempt, provider, started_at, input_json)
    VALUES ($1, $2, 'running', $3, $4, now(), $5::jsonb)
    RETURNING id
    `,
    [orderId, type, attempt, provider, JSON.stringify(input)]
  );

  await sleep(1200);

  await query(
    `
    UPDATE jobs
    SET status = 'succeeded',
        output_json = $2::jsonb,
        finished_at = now()
    WHERE id = $1
    `,
    [jobRow.id, JSON.stringify(output ?? { ok: true, step: type, completedAt: new Date().toISOString() })]
  );
}

async function loadUploads(orderId: string): Promise<UploadRow[]> {
  return query<UploadRow>(
    `
    SELECT kind, s3_key, content_type, bytes, sha256
    FROM uploads
    WHERE order_id = $1
    ORDER BY created_at ASC
    `,
    [orderId]
  );
}

function toWorkerUpload(upload: UploadRow): WorkerUpload {
  return {
    kind: upload.kind,
    s3Key: upload.s3_key,
    contentType: upload.content_type,
    bytes: upload.bytes,
    sha256: upload.sha256
  };
}

async function createArtifact(
  orderId: string,
  kind: ArtifactKind,
  s3Key: string,
  meta: Record<string, unknown>
): Promise<void> {
  await query(
    `
    INSERT INTO artifacts (order_id, kind, s3_key, meta_json)
    VALUES ($1, $2, $3, $4::jsonb)
    `,
    [orderId, kind, s3Key, JSON.stringify(meta)]
  );
}

async function materializeArtifactFile(args: {
  kind: ArtifactKind;
  assetKey: string;
  payload: Record<string, unknown>;
}): Promise<{ contentType: string; bytesWritten: number; placeholderAsset: boolean; materializedAt: string }> {
  let contentType: string;
  let bytes: Uint8Array;

  switch (args.kind) {
    case 'voice_clone_meta':
    case 'character_refs': {
      contentType = 'application/json';
      bytes = buildJsonBytes(args.payload);
      break;
    }
    case 'audio_narration':
    case 'audio_dialogue': {
      contentType = 'audio/mpeg';
      const label = JSON.stringify({
        kind: args.kind,
        key: args.assetKey,
        summary: String(args.payload.scriptTitle ?? args.payload.voiceCloneId ?? '')
      });
      bytes = buildStubMp3Bytes(label);
      break;
    }
    case 'shot_video':
    case 'final_video': {
      contentType = 'video/mp4';
      const label = JSON.stringify({
        kind: args.kind,
        key: args.assetKey,
        shot: args.payload.shotNumber ?? null,
        characterId: args.payload.characterId ?? null
      });
      bytes = buildStubMp4Bytes(label);
      break;
    }
    case 'thumbnail': {
      contentType = 'image/jpeg';
      bytes = buildStubJpegBytes();
      break;
    }
    default: {
      contentType = 'application/octet-stream';
      bytes = buildJsonBytes(args.payload);
      break;
    }
  }

  await uploadAssetBytes({
    assetKey: args.assetKey,
    contentType,
    bytes
  });

  return {
    contentType,
    bytesWritten: bytes.byteLength,
    placeholderAsset: true,
    materializedAt: new Date().toISOString()
  };
}

function fallbackShotPlan(): ScriptPayload['shots'] {
  return [
    {
      shotNumber: 1,
      durationSec: 7,
      shotType: 'narration',
      sceneId: 'fallback_intro',
      camera: 'wide_establishing_pan',
      lighting: 'golden_hour_volumetric',
      environmentMotion: ['ambient particles'],
      soundDesignCues: ['ambient swell'],
      action: 'Fallback intro shot',
      dialogue: 'Narration only.',
      narration: 'A cinematic opening begins.'
    },
    {
      shotNumber: 2,
      durationSec: 6,
      shotType: 'dialogue',
      sceneId: 'fallback_dialogue',
      camera: 'hero_low_angle_push',
      lighting: 'hero_key_fill',
      environmentMotion: ['subtle light flicker'],
      soundDesignCues: ['dialogue focus'],
      action: 'Fallback dialogue shot',
      dialogue: "I've got this. Let's go!",
      narration: ''
    },
    {
      shotNumber: 3,
      durationSec: 9,
      shotType: 'narration',
      sceneId: 'fallback_action',
      camera: 'tracking_action_orbit',
      lighting: 'cinematic_contrast',
      environmentMotion: ['drifting mist'],
      soundDesignCues: ['whoosh transition'],
      action: 'Fallback action shot',
      dialogue: 'Narration only.',
      narration: 'The adventure reaches its peak.'
    },
    {
      shotNumber: 4,
      durationSec: 8,
      shotType: 'dialogue',
      sceneId: 'fallback_closing',
      camera: 'emotional_pullback',
      lighting: 'warm_emotional_glow',
      environmentMotion: ['ambient particles'],
      soundDesignCues: ['soft resolve'],
      action: 'Fallback closing shot',
      dialogue: "That was amazing. I can't wait for my next adventure!",
      narration: ''
    }
  ];
}

function fallbackScriptPayload(): ScriptPayload {
  return {
    title: 'Fallback Cinematic Story',
    narration: ['A cinematic opening begins.', 'The adventure reaches its peak.', 'A joyful ending closes the story.'],
    totalDurationSec: 30,
    shots: fallbackShotPlan()
  };
}

async function loadScriptPayload(orderId: string): Promise<ScriptPayload> {
  const rows = await query<ScriptRow>(
    `
    SELECT script_json
    FROM scripts
    WHERE order_id = $1
    ORDER BY approved_at DESC NULLS LAST, version DESC
    LIMIT 1
    `,
    [orderId]
  );

  const script = rows[0]?.script_json;
  if (!script || !Array.isArray(script.shots) || script.shots.length === 0) {
    return fallbackScriptPayload();
  }

  return script;
}

async function writeJobEvent(args: {
  orderId: string;
  type: JobType | 'refund';
  status: 'succeeded' | 'failed';
  attempt: number;
  provider: string;
  output: Record<string, unknown>;
  errorText?: string;
}): Promise<void> {
  await query(
    `
    INSERT INTO jobs (order_id, type, status, attempt, provider, started_at, finished_at, output_json, error_text)
    VALUES ($1, $2, $3, $4, $5, now(), now(), $6::jsonb, $7)
    `,
    [
      args.orderId,
      args.type,
      args.status,
      args.attempt,
      args.provider,
      JSON.stringify(args.output),
      args.errorText ?? null
    ]
  );
}

function isTransientErrorMessage(message: string): boolean {
  return /(timeout|temporar|try again|rate limit|network|unavailable|econnreset|etimedout)/i.test(message);
}

async function markFailedSoft(orderId: string, errorMessage: string, attempt: number): Promise<void> {
  const moved = await transitionIfCurrent(orderId, ['running'], 'failed_soft');
  if (!moved) {
    return;
  }

  await writeJobEvent({
    orderId,
    type: 'final_render',
    status: 'failed',
    attempt,
    provider: 'stub_provider',
    output: { phase: 'failed_soft', willRetry: true },
    errorText: errorMessage
  });
}

async function markFailedHard(orderId: string, errorMessage: string, attempt: number): Promise<void> {
  const movedHard = await transitionIfCurrent(orderId, ['running', 'failed_soft'], 'failed_hard');
  if (!movedHard) {
    return;
  }

  await writeJobEvent({
    orderId,
    type: 'final_render',
    status: 'failed',
    attempt,
    provider: 'stub_provider',
    output: { phase: 'failed_hard', autoRefundEnabled: env.AUTO_REFUND_ON_FAILURE },
    errorText: errorMessage
  });

  if (!env.AUTO_REFUND_ON_FAILURE) {
    return;
  }

  const queued = await transitionIfCurrent(orderId, ['failed_hard'], 'refund_queued');
  if (!queued) {
    return;
  }

  try {
    const orderForRefund = await getOrder(orderId);
    if (!orderForRefund) {
      throw new Error('Order not found during refund processing');
    }

    const paymentIntentId = orderForRefund.stripe_payment_intent_id;
    if (!paymentIntentId) {
      throw new Error('Missing Stripe payment intent for refund');
    }

    const shouldUseStripeRefund = isStripeRefundEnabled() && !paymentIntentId.startsWith('pi_dev_');
    let refundId: string | null = null;
    let refundMode: 'stripe' | 'stub' = 'stub';

    if (shouldUseStripeRefund) {
      const refund = await createRefund({
        paymentIntentId,
        orderId,
        reason: errorMessage
      });
      refundId = refund.id;
      refundMode = 'stripe';
    }

    await writeJobEvent({
      orderId,
      type: 'refund',
      status: 'succeeded',
      attempt,
      provider: refundMode === 'stripe' ? 'stripe' : 'stripe_stub',
      output: { refunded: true, reason: errorMessage, refundMode, refundId, paymentIntentId }
    });
    await setOrderStatus(orderId, 'refunded');
  } catch (refundError) {
    await writeJobEvent({
      orderId,
      type: 'refund',
      status: 'failed',
      attempt,
      provider: 'stripe_stub',
      output: { refunded: false },
      errorText: (refundError as Error).message
    });
    await transitionIfCurrent(orderId, ['refund_queued'], 'manual_review');
  }
}

async function runPipeline(orderId: string, attempt: number): Promise<void> {
  const order = await getOrder(orderId);
  if (!order) {
    throw new Error(`Order ${orderId} not found`);
  }

  if (order.status !== 'paid' && order.status !== 'failed_soft') {
    throw new Error(`Order ${orderId} must be paid or retryable before rendering`);
  }

  if (order.status === 'paid' || order.status === 'failed_soft') {
    await setOrderStatus(orderId, 'running');
  }

  const uploads = await loadUploads(orderId);
  const photoUploads = uploads.filter((upload) => upload.kind === 'photo');
  const voiceUpload = uploads.find((upload) => upload.kind === 'voice') ?? null;
  const scriptPayload = await loadScriptPayload(orderId);
  const shotPlan = [...scriptPayload.shots].sort((a, b) => a.shotNumber - b.shotNumber);
  const dialogueLines = shotPlan
    .filter((shot) => shot.shotType === 'dialogue' && shot.dialogue.trim().length > 0 && shot.dialogue !== 'Narration only.')
    .map((shot) => shot.dialogue);
  const totalDurationSec = shotPlan.reduce((sum, shot) => sum + shot.durationSec, 0);

  await runStepWithInput(
    orderId,
    'moderation',
    attempt,
    {
      orderId,
      photoCount: photoUploads.length,
      voiceCount: voiceUpload ? 1 : 0
    },
    {
      ok: true,
      checks: {
        faceDetect: 'pass_stub',
        nsfw: 'pass_stub',
        audioQuality: 'pass_stub'
      }
    }
  );

  const voiceClone = await providers.voice.createVoiceClone({
    orderId,
    userId: order.user_id,
    voiceUpload: voiceUpload ? toWorkerUpload(voiceUpload) : null
  });
  await runStepWithInput(
    orderId,
    'voice_clone',
    attempt,
    {
      orderId,
      sourceVoiceKey: voiceUpload?.s3_key ?? null
    },
    {
      ok: true,
      provider: voiceClone.provider,
      voiceCloneId: voiceClone.voiceCloneId
    },
    voiceClone.provider
  );

  const voiceCloneMaterialization = await materializeArtifactFile({
    kind: 'voice_clone_meta',
    assetKey: voiceClone.voiceCloneArtifactKey,
    payload: {
      ...voiceClone.voiceCloneMeta,
      provider: voiceClone.provider,
      voiceCloneId: voiceClone.voiceCloneId
    }
  });

  await createArtifact(orderId, 'voice_clone_meta', voiceClone.voiceCloneArtifactKey, {
    ...voiceClone.voiceCloneMeta,
    ...voiceCloneMaterialization,
    signedDownloadUrl: createSignedDownloadUrl(voiceClone.voiceCloneArtifactKey)
  });

  const voiceTracks = await providers.voice.renderVoiceTracks({
    orderId,
    userId: order.user_id,
    voiceCloneId: voiceClone.voiceCloneId,
    scriptTitle: scriptPayload.title,
    narrationLines: scriptPayload.narration,
    dialogueLines
  });

  await runStepWithInput(
    orderId,
    'voice_render',
    attempt,
    {
      orderId,
      narrationLineCount: scriptPayload.narration.length,
      dialogueLineCount: dialogueLines.length
    },
    {
      ok: true,
      provider: voiceTracks.provider,
      narrationTrackKey: voiceTracks.narrationArtifactKey,
      dialogueTrackKey: voiceTracks.dialogueArtifactKey
    },
    voiceTracks.provider
  );

  const narrationMaterialization = await materializeArtifactFile({
    kind: 'audio_narration',
    assetKey: voiceTracks.narrationArtifactKey,
    payload: {
      ...voiceTracks.narrationMeta,
      provider: voiceTracks.provider,
      scriptTitle: scriptPayload.title
    }
  });

  await createArtifact(orderId, 'audio_narration', voiceTracks.narrationArtifactKey, {
    ...voiceTracks.narrationMeta,
    ...narrationMaterialization,
    signedDownloadUrl: createSignedDownloadUrl(voiceTracks.narrationArtifactKey)
  });

  const dialogueMaterialization = await materializeArtifactFile({
    kind: 'audio_dialogue',
    assetKey: voiceTracks.dialogueArtifactKey,
    payload: {
      ...voiceTracks.dialogueMeta,
      provider: voiceTracks.provider,
      voiceCloneId: voiceClone.voiceCloneId
    }
  });

  await createArtifact(orderId, 'audio_dialogue', voiceTracks.dialogueArtifactKey, {
    ...voiceTracks.dialogueMeta,
    ...dialogueMaterialization,
    signedDownloadUrl: createSignedDownloadUrl(voiceTracks.dialogueArtifactKey)
  });

  const characterPack = await providers.scene.createCharacterPack({
    orderId,
    userId: order.user_id,
    photoUploads: photoUploads.map(toWorkerUpload),
    voiceCloneId: voiceClone.voiceCloneId
  });

  const characterProfile = characterPack.characterProfile;
  await runStepWithInput(
    orderId,
    'character_pack',
    attempt,
    {
      orderId,
      sourcePhotos: photoUploads.length,
      style: characterProfile.modelStyle
    },
    {
      ok: true,
      provider: characterPack.provider,
      characterId: characterProfile.characterId,
      faceEmbeddingRef: characterProfile.faceEmbeddingRef
    },
    characterPack.provider
  );

  const characterMaterialization = await materializeArtifactFile({
    kind: 'character_refs',
    assetKey: characterPack.refsArtifactKey,
    payload: {
      ...characterPack.refsMeta,
      provider: characterPack.provider,
      characterId: characterProfile.characterId
    }
  });

  await createArtifact(orderId, 'character_refs', characterPack.refsArtifactKey, {
    ...characterPack.refsMeta,
    ...characterMaterialization,
    signedDownloadUrl: createSignedDownloadUrl(characterPack.refsArtifactKey)
  });

  const shotArtifactKeys: string[] = [];

  for (const shot of shotPlan) {
    const shotRender = await providers.scene.renderShot({
      orderId,
      userId: order.user_id,
      shot,
      characterProfile
    });

    await runStepWithInput(orderId, 'shot_render', attempt, {
      orderId,
      shot,
      characterId: characterProfile.characterId,
      voiceCloneId: voiceClone.voiceCloneId
    }, {
      ok: true,
      provider: shotRender.provider,
      shotArtifactKey: shotRender.shotArtifactKey
    }, shotRender.provider);

    const shotMaterialization = await materializeArtifactFile({
      kind: 'shot_video',
      assetKey: shotRender.shotArtifactKey,
      payload: {
        ...shotRender.shotMeta,
        provider: shotRender.provider
      }
    });

    shotArtifactKeys.push(shotRender.shotArtifactKey);
    await createArtifact(orderId, 'shot_video', shotRender.shotArtifactKey, {
      ...shotRender.shotMeta,
      ...shotMaterialization,
      signedDownloadUrl: createSignedDownloadUrl(shotRender.shotArtifactKey)
    });
  }

  const finalCompose = await providers.scene.composeFinal({
    orderId,
    userId: order.user_id,
    shotArtifactKeys,
    totalDurationSec,
    characterProfile
  });

  await runStepWithInput(orderId, 'final_render', attempt, {
    orderId,
    shotCount: shotPlan.length,
    totalDurationSec,
    characterId: characterProfile.characterId
  }, {
    ok: true,
    provider: finalCompose.provider,
    finalVideoArtifactKey: finalCompose.finalVideoArtifactKey,
    thumbnailArtifactKey: finalCompose.thumbnailArtifactKey
  }, finalCompose.provider);

  const finalVideoMaterialization = await materializeArtifactFile({
    kind: 'final_video',
    assetKey: finalCompose.finalVideoArtifactKey,
    payload: {
      ...finalCompose.finalVideoMeta,
      provider: finalCompose.provider
    }
  });

  const thumbnailMaterialization = await materializeArtifactFile({
    kind: 'thumbnail',
    assetKey: finalCompose.thumbnailArtifactKey,
    payload: {
      ...finalCompose.thumbnailMeta,
      provider: finalCompose.provider
    }
  });

  await createArtifact(orderId, 'final_video', finalCompose.finalVideoArtifactKey, {
    ...finalCompose.finalVideoMeta,
    ...finalVideoMaterialization,
    signedDownloadUrl: createSignedDownloadUrl(finalCompose.finalVideoArtifactKey)
  });
  await createArtifact(orderId, 'thumbnail', finalCompose.thumbnailArtifactKey, {
    ...finalCompose.thumbnailMeta,
    ...thumbnailMaterialization,
    signedDownloadUrl: createSignedDownloadUrl(finalCompose.thumbnailArtifactKey)
  });

  await setOrderStatus(orderId, 'delivered');
  process.stdout.write(`Notification stub: delivery email queued for order ${orderId}\n`);
}

async function main(): Promise<void> {
  const redisUrl = new URL(env.REDIS_URL);
  const connection = {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || '6379'),
    password: redisUrl.password || undefined,
    username: redisUrl.username || undefined,
    maxRetriesPerRequest: null
  };

  const queueEvents = new QueueEvents(QUEUE_NAME, { connection });
  queueEvents.on('completed', ({ jobId }) => {
    process.stdout.write(`Queue completed job ${jobId}\n`);
  });

  queueEvents.on('failed', ({ jobId, failedReason }) => {
    process.stdout.write(`Queue failed job ${jobId}: ${failedReason}\n`);
  });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const orderId = String(job.data.orderId);
      const attempt = job.attemptsStarted;

      try {
        await runPipeline(orderId, attempt);
      } catch (error) {
        const message = (error as Error).message;
        process.stderr.write(`Worker pipeline error for order ${orderId}: ${message}\n`);
        const maxAttempts = job.opts.attempts ?? 1;
        const transient = isTransientErrorMessage(message);

        if (transient && attempt < maxAttempts) {
          await markFailedSoft(orderId, message, attempt);
        } else {
          job.discard();
          await markFailedHard(orderId, message, attempt);
        }
        throw error;
      }
    },
    {
      connection,
      concurrency: 2
    }
  );

  worker.on('ready', () => {
    process.stdout.write(`Worker listening on queue ${QUEUE_NAME}\n`);
  });

  worker.on('error', (error) => {
    process.stderr.write(`Worker error: ${error.message}\n`);
  });

  const cleanup = async (): Promise<void> => {
    await worker.close();
    await queueEvents.close();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((error) => {
  process.stderr.write(`Worker startup failed: ${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});

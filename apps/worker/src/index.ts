import { createHash } from 'node:crypto';

import { type JobType, type SceneRenderSpec, type ScriptPayload, type ThemeManifest, assertOrderTransition, type OrderStatus } from '@little/shared';
import { QueueEvents, Worker } from 'bullmq';

import {
  buildJsonBytes,
  buildStubJpegBytes,
  buildStubMp3Bytes,
  buildStubMp4Bytes,
  createSignedDownloadUrl,
  downloadAssetBytes,
  fetchRemoteAssetBytes,
  uploadAssetBytes
} from './assets.js';
import { query } from './db.js';
import { sendTransactionalEmail } from './email.js';
import { env } from './env.js';
import type { CharacterProfile, WorkerUpload } from './providers.js';
import { buildProviderRegistry } from './providers.js';
import { createRefund, isStripeRefundEnabled } from './stripe.js';

const QUEUE_NAME = 'render-orders';
const providers = buildProviderRegistry();

class ModerationFailure extends Error {
  constructor(
    message: string,
    readonly output: Record<string, unknown>,
    readonly provider: string
  ) {
    super(message);
  }
}

interface OrderRow {
  id: string;
  status: OrderStatus;
  user_id: string;
  stripe_payment_intent_id: string | null;
}

interface OrderRecipientRow {
  email: string;
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

interface OrderThemeRow {
  theme_name: string;
  template_manifest_json: unknown;
}

interface OrderRenderContext {
  themeName: string;
  manifest: ThemeManifest;
}

interface CharacterIdentityRow {
  id: string;
  version: number;
  source_photo_fingerprint: string;
  source_photo_count: number;
  character_profile_json: CharacterProfile;
  refs_meta_json: Record<string, unknown>;
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function getOrder(orderId: string): Promise<OrderRow | null> {
  const rows = await query<OrderRow>('SELECT id, status, user_id, stripe_payment_intent_id FROM orders WHERE id = $1', [orderId]);
  return rows[0] ?? null;
}

async function getOrderRecipientEmail(orderId: string): Promise<string | null> {
  const rows = await query<OrderRecipientRow>(
    `
    SELECT u.email
    FROM orders o
    JOIN users u ON u.id = o.user_id
    WHERE o.id = $1
    LIMIT 1
    `,
    [orderId]
  );

  return rows[0]?.email ?? null;
}

async function recordEmailNotification(args: {
  orderId: string;
  recipientEmail: string;
  notificationType: 'delivery_ready' | 'render_failed' | 'gift_redeem_link';
  provider: string;
  providerMessageId: string | null;
  status: 'sent' | 'failed' | 'stub';
  subject: string;
  errorText: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  await query(
    `
    INSERT INTO email_notifications (
      order_id,
      recipient_email,
      notification_type,
      provider,
      provider_message_id,
      status,
      subject,
      error_text,
      payload_json
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    `,
    [
      args.orderId,
      args.recipientEmail,
      args.notificationType,
      args.provider,
      args.providerMessageId,
      args.status,
      args.subject,
      args.errorText,
      JSON.stringify(args.payload)
    ]
  );
}

async function sendOrderNotificationEmail(args: {
  orderId: string;
  notificationType: 'delivery_ready' | 'render_failed';
  subject: string;
  text: string;
  html: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    const recipientEmail = await getOrderRecipientEmail(args.orderId);
    if (!recipientEmail) {
      return;
    }

    const sendResult = await sendTransactionalEmail({
      to: recipientEmail,
      subject: args.subject,
      html: args.html,
      text: args.text
    });

    await recordEmailNotification({
      orderId: args.orderId,
      recipientEmail,
      notificationType: args.notificationType,
      provider: sendResult.provider,
      providerMessageId: sendResult.providerMessageId,
      status: sendResult.status,
      subject: args.subject,
      errorText: sendResult.errorText,
      payload: args.payload
    });
  } catch (error) {
    process.stderr.write(`Email notification write failed for order ${args.orderId}: ${(error as Error).message}\n`);
  }
}

async function sendDeliveryReadyNotification(orderId: string, finalVideoAssetKey: string): Promise<void> {
  const orderUrl = `${env.WEB_APP_BASE_URL}/orders/${orderId}`;
  const downloadUrl = createSignedDownloadUrl(finalVideoAssetKey);
  const subject = 'Your Little Legend video is ready';

  await sendOrderNotificationEmail({
    orderId,
    notificationType: 'delivery_ready',
    subject,
    text: [
      'Your Little Legend cinematic keepsake is ready.',
      `View order: ${orderUrl}`,
      `Download video: ${downloadUrl}`
    ].join('\n'),
    html: `
      <p>Your Little Legend cinematic keepsake is ready.</p>
      <p><a href="${orderUrl}">View order status</a></p>
      <p><a href="${downloadUrl}">Download final video</a></p>
    `,
    payload: {
      orderUrl,
      downloadUrl,
      finalVideoAssetKey
    }
  });
}

async function sendRenderFailureNotification(orderId: string, failureMessage: string): Promise<void> {
  const orderUrl = `${env.WEB_APP_BASE_URL}/orders/${orderId}`;
  const subject = 'We hit a rendering issue with your Little Legend order';
  const safeFailureMessage = escapeHtml(failureMessage);

  await sendOrderNotificationEmail({
    orderId,
    notificationType: 'render_failed',
    subject,
    text: [
      'A rendering issue occurred while producing your video.',
      `Order status page: ${orderUrl}`,
      `Reason: ${failureMessage}`,
      'You can use the "Retry Render" button on the order page (retry limits apply).'
    ].join('\n'),
    html: `
      <p>A rendering issue occurred while producing your video.</p>
      <p>Reason: ${safeFailureMessage}</p>
      <p><a href="${orderUrl}">Open order status</a></p>
      <p>You can use the "Retry Render" action on that page (retry limits apply).</p>
      <p>If retries are exhausted, contact <a href="mailto:${env.SUPPORT_EMAIL}">${env.SUPPORT_EMAIL}</a>.</p>
    `,
    payload: {
      orderUrl,
      failureMessage
    }
  });
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
  provider = 'stub_provider',
  providerTaskId: string | null = null
): Promise<void> {
  const [jobRow] = await query<{ id: string }>(
    `
    INSERT INTO jobs (order_id, type, status, attempt, provider, provider_task_id, started_at, input_json)
    VALUES ($1, $2, 'running', $3, $4, $5, now(), $6::jsonb)
    RETURNING id
    `,
    [orderId, type, attempt, provider, providerTaskId, JSON.stringify(input)]
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

async function runFailedStepWithInput(
  orderId: string,
  type: JobType,
  attempt: number,
  input: Record<string, unknown>,
  errorText: string,
  output?: Record<string, unknown>,
  provider = 'local_moderation'
): Promise<void> {
  const [jobRow] = await query<{ id: string }>(
    `
    INSERT INTO jobs (order_id, type, status, attempt, provider, started_at, input_json)
    VALUES ($1, $2, 'running', $3, $4, now(), $5::jsonb)
    RETURNING id
    `,
    [orderId, type, attempt, provider, JSON.stringify(input)]
  );

  await query(
    `
    UPDATE jobs
    SET status = 'failed',
        output_json = $2::jsonb,
        error_text = $3,
        finished_at = now()
    WHERE id = $1
    `,
    [
      jobRow.id,
      JSON.stringify(output ?? { ok: false, step: type, failedAt: new Date().toISOString() }),
      errorText
    ]
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

function parseManifest(value: unknown): ThemeManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('Theme manifest missing for order.');
  }

  const manifest = value as ThemeManifest;
  if (!Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
    throw new Error('Theme manifest must include at least one scene.');
  }

  return manifest;
}

async function loadOrderRenderContext(orderId: string): Promise<OrderRenderContext> {
  const rows = await query<OrderThemeRow>(
    `
    SELECT
      t.name AS theme_name,
      t.template_manifest_json
    FROM orders o
    JOIN themes t ON t.id = o.theme_id
    WHERE o.id = $1
    LIMIT 1
    `,
    [orderId]
  );

  const row = rows[0];
  if (!row) {
    throw new Error(`Order ${orderId} theme context not found`);
  }

  return {
    themeName: row.theme_name,
    manifest: parseManifest(row.template_manifest_json)
  };
}

function resolveSceneRenderSpec(args: {
  shot: ScriptPayload['shots'][number];
  context: OrderRenderContext;
}): SceneRenderSpec {
  const indexedFallbackScene =
    args.context.manifest.scenes[(Math.max(args.shot.shotNumber, 1) - 1) % args.context.manifest.scenes.length];
  const scene = args.context.manifest.scenes.find((entry) => entry.id === args.shot.sceneId) ?? indexedFallbackScene;

  return {
    shotNumber: args.shot.shotNumber,
    sceneId: scene.id,
    sceneName: args.shot.sceneName || scene.name,
    sceneArchitecture: args.context.manifest.sceneArchitecture,
    camera: args.shot.camera || scene.cameraPreset,
    lighting: args.shot.lighting || scene.lightingPreset,
    environmentMotion:
      args.shot.overrides?.environmentMotion && args.shot.overrides.environmentMotion.length > 0
        ? args.shot.overrides.environmentMotion
        : args.shot.environmentMotion.length > 0
          ? args.shot.environmentMotion
          : scene.environmentMotionDefaults,
    soundBed: scene.soundBed,
    assets: scene.assets,
    anchors: scene.anchors,
    palette: scene.palette ?? args.context.manifest.palette ?? [],
    globalFx: scene.globalFx ?? args.context.manifest.globalFx ?? [],
    audio: scene.audio ?? { musicBed: null, sfx: [] },
    cameraMove: scene.cameraMove,
    parallaxStrength: scene.parallaxStrength,
    grade: scene.grade ?? { lut: scene.assets.lut },
    modelProfile: {
      avatarModel: args.shot.shotType === 'dialogue' ? 'avatar_speech_v1' : 'avatar_idle_v1',
      compositorModel: env.SCENE_PROVIDER_MODE === 'http' ? 'provider_scene_compositor_v1' : 'scene_parallax_compositor_v1_stub'
    }
  };
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

function computePhotoSetFingerprint(photoUploads: UploadRow[]): string {
  const sourceMaterial = photoUploads
    .map((upload) => upload.sha256 ?? `${upload.s3_key}:${upload.bytes}:${upload.content_type}`)
    .sort()
    .join('|');

  return createHash('sha256').update(sourceMaterial).digest('hex');
}

async function loadReusableCharacterIdentity(args: {
  userId: string;
  photoUploads: UploadRow[];
  voiceCloneId: string;
}): Promise<{
  identityId: string;
  version: number;
  sourcePhotoFingerprint: string;
  sourcePhotoCount: number;
  characterProfile: CharacterProfile;
  refsMeta: Record<string, unknown>;
} | null> {
  const sourcePhotoFingerprint = computePhotoSetFingerprint(args.photoUploads);
  const rows = await query<CharacterIdentityRow>(
    `
    SELECT
      id,
      version,
      source_photo_fingerprint,
      source_photo_count,
      character_profile_json,
      refs_meta_json
    FROM character_identities
    WHERE user_id = $1
      AND source_photo_fingerprint = $2
    LIMIT 1
    `,
    [args.userId, sourcePhotoFingerprint]
  );

  const row = rows[0];
  if (!row) {
    return null;
  }

  const characterProfile: CharacterProfile = {
    ...row.character_profile_json,
    voiceCloneId: args.voiceCloneId
  };
  const refsMeta = {
    ...row.refs_meta_json,
    voiceCloneId: args.voiceCloneId,
    characterIdentityId: row.id,
    characterIdentityVersion: row.version,
    reusedIdentity: true,
    lastReusedAt: new Date().toISOString()
  };

  return {
    identityId: row.id,
    version: row.version,
    sourcePhotoFingerprint,
    sourcePhotoCount: row.source_photo_count,
    characterProfile,
    refsMeta
  };
}

async function persistReusableCharacterIdentity(args: {
  userId: string;
  orderId: string;
  photoUploads: UploadRow[];
  characterProfile: CharacterProfile;
  refsMeta: Record<string, unknown>;
}): Promise<{
  identityId: string;
  version: number;
  sourcePhotoFingerprint: string;
  sourcePhotoCount: number;
}> {
  const sourcePhotoFingerprint = computePhotoSetFingerprint(args.photoUploads);
  const sourcePhotoCount = args.photoUploads.length;
  const rows = await query<{ id: string; version: number }>(
    `
    INSERT INTO character_identities (
      user_id,
      source_photo_fingerprint,
      source_photo_count,
      latest_order_id,
      version,
      character_profile_json,
      refs_meta_json,
      last_used_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, 1, $5::jsonb, $6::jsonb, now(), now())
    ON CONFLICT (user_id, source_photo_fingerprint)
    DO UPDATE SET
      source_photo_count = EXCLUDED.source_photo_count,
      latest_order_id = EXCLUDED.latest_order_id,
      version = character_identities.version + 1,
      character_profile_json = EXCLUDED.character_profile_json,
      refs_meta_json = EXCLUDED.refs_meta_json,
      last_used_at = now(),
      updated_at = now()
    RETURNING id, version
    `,
    [
      args.userId,
      sourcePhotoFingerprint,
      sourcePhotoCount,
      args.orderId,
      JSON.stringify(args.characterProfile),
      JSON.stringify(args.refsMeta)
    ]
  );

  const row = rows[0];
  if (!row) {
    throw new Error('Failed to persist reusable character identity.');
  }

  return {
    identityId: row.id,
    version: row.version,
    sourcePhotoFingerprint,
    sourcePhotoCount
  };
}

async function markCharacterIdentityUsed(identityId: string, orderId: string): Promise<void> {
  await query(
    `
    UPDATE character_identities
    SET latest_order_id = $2,
        last_used_at = now(),
        updated_at = now()
    WHERE id = $1
    `,
    [identityId, orderId]
  );
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function containsAscii(bytes: Uint8Array, start: number, text: string): boolean {
  if (bytes.length < start + text.length) {
    return false;
  }

  for (let index = 0; index < text.length; index += 1) {
    if (bytes[start + index] !== text.charCodeAt(index)) {
      return false;
    }
  }

  return true;
}

function matchesUploadSignature(upload: UploadRow, bytes: Uint8Array): boolean {
  switch (upload.content_type) {
    case 'image/jpeg':
      return bytes.length >= 3 && hasPrefix(bytes, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return bytes.length >= 8 && hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'audio/wav':
    case 'audio/x-wav':
      return bytes.length >= 12 && containsAscii(bytes, 0, 'RIFF') && containsAscii(bytes, 8, 'WAVE');
    case 'audio/m4a':
    case 'audio/x-m4a':
    case 'audio/mp4':
      return bytes.length >= 12 && containsAscii(bytes, 4, 'ftyp');
    default:
      return false;
  }
}

function estimateVoiceDurationSec(upload: UploadRow, bytesLength: number): number {
  switch (upload.content_type) {
    case 'audio/wav':
    case 'audio/x-wav':
      return Math.max(1, Math.round(bytesLength / 32000));
    case 'audio/m4a':
    case 'audio/x-m4a':
    case 'audio/mp4':
      return Math.max(1, Math.round(bytesLength / 16000));
    default:
      return Math.max(1, Math.round(bytesLength / 16000));
  }
}

async function runLocalModerationChecks(args: {
  orderId: string;
  photoUploads: UploadRow[];
  voiceUpload: UploadRow | null;
}): Promise<{
  ok: true;
  checks: {
    faceDetect: string;
    nsfw: string;
    audioQuality: string;
  };
  metrics: Record<string, unknown>;
}> {
  if (args.photoUploads.length < 5 || args.photoUploads.length > 15) {
    throw new Error(`Moderation rejected intake: expected 5-15 photos, received ${String(args.photoUploads.length)}.`);
  }

  if (!args.voiceUpload) {
    throw new Error('Moderation rejected intake: missing voice sample.');
  }

  const photoPayloads = await Promise.all(
    args.photoUploads.map(async (upload) => {
      const downloaded = await downloadAssetBytes(upload.s3_key);
      if (!matchesUploadSignature(upload, downloaded.bytes)) {
        throw new Error(`Moderation rejected photo upload ${upload.s3_key}: file signature does not match ${upload.content_type}.`);
      }
      if (downloaded.bytes.byteLength !== upload.bytes) {
        throw new Error(`Moderation rejected photo upload ${upload.s3_key}: stored bytes do not match upload metadata.`);
      }
      if (downloaded.bytes.byteLength < 15_000) {
        throw new Error(`Moderation rejected photo upload ${upload.s3_key}: image file is too small to be usable.`);
      }

      return {
        bytes: downloaded.bytes.byteLength,
        sha256: upload.sha256
      };
    })
  );

  const uniquePhotoHashes = new Set(photoPayloads.map((photo) => photo.sha256).filter((value): value is string => Boolean(value)));
  if (uniquePhotoHashes.size < Math.min(3, args.photoUploads.length)) {
    throw new Error('Moderation rejected intake: photo set does not contain enough unique source images.');
  }

  const voiceDownloaded = await downloadAssetBytes(args.voiceUpload.s3_key);
  if (!matchesUploadSignature(args.voiceUpload, voiceDownloaded.bytes)) {
    throw new Error(`Moderation rejected voice upload ${args.voiceUpload.s3_key}: file signature does not match ${args.voiceUpload.content_type}.`);
  }
  if (voiceDownloaded.bytes.byteLength !== args.voiceUpload.bytes) {
    throw new Error(`Moderation rejected voice upload ${args.voiceUpload.s3_key}: stored bytes do not match upload metadata.`);
  }
  if (voiceDownloaded.bytes.byteLength < 80_000) {
    throw new Error('Moderation rejected voice sample: audio file is too small and likely unusable.');
  }

  const estimatedVoiceDurationSec = estimateVoiceDurationSec(args.voiceUpload, voiceDownloaded.bytes.byteLength);
  if (estimatedVoiceDurationSec < 25 || estimatedVoiceDurationSec > 75) {
    throw new Error(
      `Moderation rejected voice sample: estimated duration ${String(estimatedVoiceDurationSec)}s is outside the accepted range.`
    );
  }

  const averagePhotoBytes = Math.round(photoPayloads.reduce((sum, photo) => sum + photo.bytes, 0) / photoPayloads.length);

  return {
    ok: true,
    checks: {
      faceDetect: 'pass_local_photo_integrity',
      nsfw: 'pass_local_intake_heuristic',
      audioQuality: 'pass_local_duration_signature'
    },
    metrics: {
      mode: 'local_heuristic',
      photoCount: args.photoUploads.length,
      uniquePhotoCount: uniquePhotoHashes.size,
      averagePhotoBytes,
      voiceBytes: voiceDownloaded.bytes.byteLength,
      estimatedVoiceDurationSec
    }
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

function stripInlineAudioPayload(meta: Record<string, unknown>): Record<string, unknown> {
  const { base64Audio, ...rest } = meta;
  return rest;
}

async function persistAudioArtifact(args: {
  orderId: string;
  kind: Extract<ArtifactKind, 'audio_narration' | 'audio_dialogue'>;
  assetKey: string;
  meta: Record<string, unknown>;
}): Promise<void> {
  const sanitizedMeta = stripInlineAudioPayload(args.meta);
  const materialization = await materializeArtifactFile({
    kind: args.kind,
    assetKey: args.assetKey,
    payload: args.meta
  });

  await createArtifact(args.orderId, args.kind, args.assetKey, {
    ...sanitizedMeta,
    ...materialization,
    signedDownloadUrl: createSignedDownloadUrl(args.assetKey)
  });
}

function extractProviderTaskId(meta: Record<string, unknown>): string | null {
  const value = meta.providerTaskId;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

async function awaitProviderTask(providerTaskId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + env.PROVIDER_TASK_POLL_TIMEOUT_MS;
  let lastStatus = 'queued';
  let lastError: string | null = null;

  while (Date.now() <= deadline) {
    const task = await providers.scene.getProviderTaskStatus({
      providerTaskId
    });
    lastStatus = task.status;
    lastError = task.errorText;

    if (task.status === 'succeeded') {
      return task.output;
    }

    if (task.status === 'failed') {
      throw new Error(`Provider task ${providerTaskId} failed: ${task.errorText ?? 'unknown error'}`);
    }

    await sleep(env.PROVIDER_TASK_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Provider task ${providerTaskId} timed out after ${env.PROVIDER_TASK_POLL_TIMEOUT_MS}ms (last status: ${lastStatus}${lastError ? `, error: ${lastError}` : ''})`
  );
}

function readNestedString(source: Record<string, unknown>, path: string[]): string | null {
  let current: unknown = source;
  for (const segment of path) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  if (typeof current !== 'string') {
    return null;
  }

  const trimmed = current.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractProviderOutputUrl(payload: Record<string, unknown>, kind: ArtifactKind): string | null {
  const urlPathsByKind: Record<ArtifactKind, string[][]> = {
    voice_clone_meta: [],
    audio_narration: [],
    audio_dialogue: [],
    character_refs: [],
    shot_video: [
      ['providerTaskOutput', 'outputUrl'],
      ['providerTaskOutput', 'videoUrl'],
      ['providerTaskOutput', 'url'],
      ['providerTaskOutput', 'providerResponse', 'data', 'video_url'],
      ['providerTaskOutput', 'providerResponse', 'data', 'url'],
      ['providerTaskOutput', 'providerResponse', 'response', 'url']
    ],
    final_video: [
      ['providerTaskOutput', 'outputUrl'],
      ['providerTaskOutput', 'videoUrl'],
      ['providerTaskOutput', 'url'],
      ['providerTaskOutput', 'providerResponse', 'response', 'url'],
      ['providerTaskOutput', 'providerResponse', 'data', 'video_url'],
      ['providerTaskOutput', 'providerResponse', 'data', 'url']
    ],
    thumbnail: [
      ['providerTaskOutput', 'thumbnailUrl'],
      ['providerTaskOutput', 'posterUrl'],
      ['providerTaskOutput', 'providerResponse', 'response', 'poster'],
      ['providerTaskOutput', 'providerResponse', 'response', 'poster_url'],
      ['providerTaskOutput', 'providerResponse', 'data', 'thumbnail_url']
    ]
  };

  for (const path of urlPathsByKind[kind]) {
    const value = readNestedString(payload, path);
    if (value) {
      return value;
    }
  }

  return null;
}

async function materializeArtifactFile(args: {
  kind: ArtifactKind;
  assetKey: string;
  payload: Record<string, unknown>;
}): Promise<{
  contentType: string;
  bytesWritten: number;
  placeholderAsset: boolean;
  providerOutputIngested: boolean;
  providerOutputUrl?: string;
  providerOutputFetchError?: string;
  materializedAt: string;
}> {
  let contentType = 'application/octet-stream';
  let bytes: Uint8Array | null = null;
  let placeholderAsset = true;
  let providerOutputIngested = false;
  const providerOutputUrl = extractProviderOutputUrl(args.payload, args.kind);
  let providerOutputFetchError: string | undefined;

  if (providerOutputUrl) {
    try {
      const fetched = await fetchRemoteAssetBytes({
        url: providerOutputUrl,
        fallbackContentType: args.kind === 'thumbnail' ? 'image/jpeg' : 'video/mp4'
      });
      contentType = fetched.contentType;
      bytes = fetched.bytes;
      placeholderAsset = false;
      providerOutputIngested = true;
    } catch (error) {
      providerOutputFetchError = (error as Error).message;
    }
  }

  const inlineAudioBase64 = typeof args.payload.base64Audio === 'string' ? args.payload.base64Audio.trim() : '';
  if (!bytes && inlineAudioBase64 && (args.kind === 'audio_narration' || args.kind === 'audio_dialogue')) {
    contentType = 'audio/mpeg';
    bytes = Buffer.from(inlineAudioBase64, 'base64');
    placeholderAsset = false;
    providerOutputIngested = true;
  }

  if (!bytes) {
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
  }

  await uploadAssetBytes({
    assetKey: args.assetKey,
    contentType,
    bytes: bytes ?? buildJsonBytes({})
  });

  return {
    contentType,
    bytesWritten: (bytes ?? buildJsonBytes({})).byteLength,
    placeholderAsset,
    providerOutputIngested,
    ...(providerOutputUrl ? { providerOutputUrl } : {}),
    ...(providerOutputFetchError ? { providerOutputFetchError } : {}),
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
  await sendRenderFailureNotification(orderId, errorMessage);

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
    const movedManualReview = await transitionIfCurrent(orderId, ['refund_queued'], 'manual_review');
    if (movedManualReview) {
      await sendRenderFailureNotification(
        orderId,
        `Automatic refund failed and support review is required: ${(refundError as Error).message}`
      );
    }
  }
}

async function runPipeline(orderId: string, attempt: number): Promise<void> {
  const order = await getOrder(orderId);
  if (!order) {
    throw new Error(`Order ${orderId} not found`);
  }

  if (order.status !== 'paid' && order.status !== 'failed_soft') {
    process.stdout.write(`[worker] Skipping non-renderable order ${orderId} in status ${order.status}\n`);
    return;
  }

  const movedToRunning = await transitionIfCurrent(orderId, ['paid', 'failed_soft'], 'running');
  if (!movedToRunning) {
    const latest = await getOrder(orderId);
    process.stdout.write(
      `[worker] Skipping render start for order ${orderId}; current status is ${latest?.status ?? 'missing'}\n`
    );
    return;
  }

  const uploads = await loadUploads(orderId);
  const photoUploads = uploads.filter((upload) => upload.kind === 'photo');
  const voiceUpload = uploads.find((upload) => upload.kind === 'voice') ?? null;
  const renderContext = await loadOrderRenderContext(orderId);
  const scriptPayload = await loadScriptPayload(orderId);
  const shotPlan = [...scriptPayload.shots].sort((a, b) => a.shotNumber - b.shotNumber);
  const dialogueLines = shotPlan
    .filter((shot) => shot.shotType === 'dialogue' && shot.dialogue.trim().length > 0 && shot.dialogue !== 'Narration only.')
    .map((shot) => shot.dialogue);
  const totalDurationSec = shotPlan.reduce((sum, shot) => sum + shot.durationSec, 0);

  const moderationInput = {
    orderId,
    photoCount: photoUploads.length,
    voiceCount: voiceUpload ? 1 : 0
  };

  try {
    const localModerationResult = await runLocalModerationChecks({
      orderId,
      photoUploads,
      voiceUpload
    });
    const providerModerationResult = await providers.moderation.checkIntake({
      orderId,
      userId: order.user_id,
      photoUploads: photoUploads.map(toWorkerUpload),
      voiceUpload: voiceUpload ? toWorkerUpload(voiceUpload) : null
    });

    if (!providerModerationResult.approved) {
      const message = providerModerationResult.summary.join(' ') || 'Provider moderation rejected intake.';
      throw new ModerationFailure(
        message,
        {
          ok: false,
          localChecks: localModerationResult,
          providerChecks: providerModerationResult
        },
        providerModerationResult.provider
      );
    }

    await runStepWithInput(
      orderId,
      'moderation',
      attempt,
      moderationInput,
      {
        ok: true,
        localChecks: localModerationResult,
        providerChecks: providerModerationResult
      },
      providerModerationResult.provider
    );
  } catch (error) {
    const message = (error as Error).message;
    const failedOutput =
      error instanceof ModerationFailure
        ? error.output
        : {
            ok: false,
            checks: {
              faceDetect: 'failed',
              nsfw: 'failed',
              audioQuality: 'failed'
            },
            mode: 'local_heuristic'
          };
    await runFailedStepWithInput(
      orderId,
      'moderation',
      attempt,
      moderationInput,
      message,
      failedOutput,
      error instanceof ModerationFailure ? error.provider : 'local_moderation'
    );
    throw error;
  }

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
    dialogueLines,
    shots: shotPlan.map((shot) => ({
      shotNumber: shot.shotNumber,
      shotType: shot.shotType,
      durationSec: shot.durationSec,
      narration: shot.narration,
      dialogue: shot.dialogue,
      speakingDurationSec: shot.speakingDurationSec
    }))
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
      dialogueTrackKey: voiceTracks.dialogueArtifactKey,
      shotAudioTrackCount: voiceTracks.shotAudioTracks.length
    },
    voiceTracks.provider
  );

  await persistAudioArtifact({
    orderId,
    kind: 'audio_narration',
    assetKey: voiceTracks.narrationArtifactKey,
    meta: {
      ...voiceTracks.narrationMeta,
      provider: voiceTracks.provider,
      scriptTitle: scriptPayload.title
    }
  });

  await persistAudioArtifact({
    orderId,
    kind: 'audio_dialogue',
    assetKey: voiceTracks.dialogueArtifactKey,
    meta: {
      ...voiceTracks.dialogueMeta,
      provider: voiceTracks.provider,
      voiceCloneId: voiceClone.voiceCloneId
    }
  });

  for (const track of voiceTracks.shotAudioTracks) {
    await persistAudioArtifact({
      orderId,
      kind: track.shotType === 'dialogue' ? 'audio_dialogue' : 'audio_narration',
      assetKey: track.artifactKey,
      meta: {
        ...track.meta,
        provider: voiceTracks.provider,
        voiceCloneId: voiceClone.voiceCloneId
      }
    });
  }

  const reusedIdentity = await loadReusableCharacterIdentity({
    userId: order.user_id,
    photoUploads,
    voiceCloneId: voiceClone.voiceCloneId
  });

  let characterProfile: CharacterProfile;
  let characterRefsArtifactKey: string;
  let characterRefsMeta: Record<string, unknown>;
  let characterPackProvider: string;
  let characterIdentityId: string | null = null;
  let characterIdentityVersion: number | null = null;
  let characterIdentityReuse = false;
  let characterSourcePhotoFingerprint = reusedIdentity?.sourcePhotoFingerprint ?? computePhotoSetFingerprint(photoUploads);

  if (reusedIdentity) {
    characterProfile = reusedIdentity.characterProfile;
    characterRefsArtifactKey = `${order.user_id}/${orderId}/character/refs-${characterProfile.characterId}.json`;
    characterRefsMeta = {
      ...reusedIdentity.refsMeta,
      characterId: characterProfile.characterId,
      faceEmbeddingRef: characterProfile.faceEmbeddingRef,
      sourcePhotoCount: photoUploads.length,
      sourcePhotoFingerprint: reusedIdentity.sourcePhotoFingerprint
    };
    characterPackProvider = 'character_identity_cache';
    characterIdentityId = reusedIdentity.identityId;
    characterIdentityVersion = reusedIdentity.version;
    characterIdentityReuse = true;
    await markCharacterIdentityUsed(reusedIdentity.identityId, orderId);
  } else {
    const characterPack = await providers.scene.createCharacterPack({
      orderId,
      userId: order.user_id,
      photoUploads: photoUploads.map(toWorkerUpload),
      voiceCloneId: voiceClone.voiceCloneId
    });

    characterProfile = characterPack.characterProfile;
    characterRefsArtifactKey = characterPack.refsArtifactKey;
    characterRefsMeta = {
      ...characterPack.refsMeta,
      sourcePhotoFingerprint: characterSourcePhotoFingerprint
    };
    characterPackProvider = characterPack.provider;

    const persistedIdentity = await persistReusableCharacterIdentity({
      userId: order.user_id,
      orderId,
      photoUploads,
      characterProfile,
      refsMeta: characterRefsMeta
    });

    characterIdentityId = persistedIdentity.identityId;
    characterIdentityVersion = persistedIdentity.version;
    characterSourcePhotoFingerprint = persistedIdentity.sourcePhotoFingerprint;
    characterRefsMeta = {
      ...characterRefsMeta,
      characterIdentityId,
      characterIdentityVersion,
      reusedIdentity: false
    };
  }

  await runStepWithInput(
    orderId,
    'character_pack',
    attempt,
    {
      orderId,
      sourcePhotos: photoUploads.length,
      style: characterProfile.modelStyle,
      reusedIdentity: characterIdentityReuse
    },
    {
      ok: true,
      provider: characterPackProvider,
      characterId: characterProfile.characterId,
      faceEmbeddingRef: characterProfile.faceEmbeddingRef,
      characterIdentityId,
      characterIdentityVersion,
      sourcePhotoFingerprint: characterSourcePhotoFingerprint,
      reusedIdentity: characterIdentityReuse
    },
    characterPackProvider
  );

  const characterMaterialization = await materializeArtifactFile({
    kind: 'character_refs',
    assetKey: characterRefsArtifactKey,
    payload: {
      ...characterRefsMeta,
      provider: characterPackProvider,
      characterId: characterProfile.characterId,
      characterIdentityId,
      characterIdentityVersion,
      reusedIdentity: characterIdentityReuse
    }
  });

  await createArtifact(orderId, 'character_refs', characterRefsArtifactKey, {
    ...characterRefsMeta,
    ...characterMaterialization,
    characterIdentityId,
    characterIdentityVersion,
    reusedIdentity: characterIdentityReuse,
    signedDownloadUrl: createSignedDownloadUrl(characterRefsArtifactKey)
  });

  const shotArtifactKeys: string[] = [];

  for (const shot of shotPlan) {
    const sceneRenderSpec = resolveSceneRenderSpec({
      shot,
      context: renderContext
    });

    const shotRender = await providers.scene.renderShot({
      orderId,
      userId: order.user_id,
      shot,
      sceneRenderSpec,
      characterProfile
    });

    const shotProviderTaskId = extractProviderTaskId(shotRender.shotMeta);
    const shotProviderOutput = shotProviderTaskId ? await awaitProviderTask(shotProviderTaskId) : {};

    await runStepWithInput(orderId, 'shot_render', attempt, {
      orderId,
      shot,
      sceneRenderSpec,
      characterId: characterProfile.characterId,
      voiceCloneId: voiceClone.voiceCloneId
    }, {
      ok: true,
      provider: shotRender.provider,
      shotArtifactKey: shotRender.shotArtifactKey,
      providerTaskId: shotProviderTaskId,
      providerTaskOutput: shotProviderOutput
    }, shotRender.provider, shotProviderTaskId);

    const shotMaterialization = await materializeArtifactFile({
      kind: 'shot_video',
      assetKey: shotRender.shotArtifactKey,
      payload: {
        ...shotRender.shotMeta,
        sceneRenderSpec,
        provider: shotRender.provider,
        providerTaskOutput: shotProviderOutput
      }
    });

    shotArtifactKeys.push(shotRender.shotArtifactKey);
    await createArtifact(orderId, 'shot_video', shotRender.shotArtifactKey, {
      ...shotRender.shotMeta,
      sceneRenderSpec,
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

  const finalProviderTaskId = extractProviderTaskId(finalCompose.finalVideoMeta);
  const finalProviderOutput = finalProviderTaskId ? await awaitProviderTask(finalProviderTaskId) : {};

  await runStepWithInput(orderId, 'final_render', attempt, {
    orderId,
    shotCount: shotPlan.length,
    totalDurationSec,
    characterId: characterProfile.characterId
  }, {
    ok: true,
    provider: finalCompose.provider,
    finalVideoArtifactKey: finalCompose.finalVideoArtifactKey,
    thumbnailArtifactKey: finalCompose.thumbnailArtifactKey,
    providerTaskId: finalProviderTaskId,
    providerTaskOutput: finalProviderOutput
  }, finalCompose.provider, finalProviderTaskId);

  const finalVideoMaterialization = await materializeArtifactFile({
    kind: 'final_video',
    assetKey: finalCompose.finalVideoArtifactKey,
    payload: {
      ...finalCompose.finalVideoMeta,
      provider: finalCompose.provider,
      providerTaskOutput: finalProviderOutput
    }
  });

  const thumbnailMaterialization = await materializeArtifactFile({
    kind: 'thumbnail',
    assetKey: finalCompose.thumbnailArtifactKey,
    payload: {
      ...finalCompose.thumbnailMeta,
      provider: finalCompose.provider,
      providerTaskOutput: finalProviderOutput
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
  await sendDeliveryReadyNotification(orderId, finalCompose.finalVideoArtifactKey);
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

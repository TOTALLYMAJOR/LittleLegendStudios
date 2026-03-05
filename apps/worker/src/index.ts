import { randomUUID } from 'node:crypto';

import { type JobType, type ScriptPayload, assertOrderTransition, type OrderStatus } from '@little/shared';
import { QueueEvents, Worker } from 'bullmq';

import { query } from './db.js';
import { env } from './env.js';
import { createRefund, isStripeRefundEnabled } from './stripe.js';

const QUEUE_NAME = 'render-orders';
const pipelineSteps: JobType[] = [
  'moderation',
  'voice_clone',
  'voice_render',
  'character_pack',
  'shot_render',
  'final_render'
];

interface OrderRow {
  id: string;
  status: OrderStatus;
  user_id: string;
  stripe_payment_intent_id: string | null;
}

interface ScriptRow {
  script_json: ScriptPayload;
}

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

async function runStep(orderId: string, type: JobType, attempt: number): Promise<void> {
  await runStepWithInput(orderId, type, attempt, { orderId, type });
}

async function runStepWithInput(
  orderId: string,
  type: JobType,
  attempt: number,
  input: Record<string, unknown>
): Promise<void> {
  const [jobRow] = await query<{ id: string }>(
    `
    INSERT INTO jobs (order_id, type, status, attempt, provider, started_at, input_json)
    VALUES ($1, $2, 'running', $3, $4, now(), $5::jsonb)
    RETURNING id
    `,
    [orderId, type, attempt, 'stub_provider', JSON.stringify(input)]
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
    [jobRow.id, JSON.stringify({ ok: true, step: type, completedAt: new Date().toISOString() })]
  );
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

async function loadShotPlan(orderId: string): Promise<ScriptPayload['shots']> {
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
    return fallbackShotPlan();
  }

  return [...script.shots].sort((a, b) => a.shotNumber - b.shotNumber);
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

  for (const step of pipelineSteps.slice(0, 4)) {
    await runStep(orderId, step, attempt);
  }

  const shotPlan = await loadShotPlan(orderId);

  for (const shot of shotPlan) {
    await runStepWithInput(orderId, 'shot_render', attempt, {
      orderId,
      shot
    });

    const shotKey = `${order.user_id}/${orderId}/shots/shot-${shot.shotNumber}-${randomUUID().slice(0, 8)}.mp4`;
    await query(
      `
      INSERT INTO artifacts (order_id, kind, s3_key, meta_json)
      VALUES ($1, 'shot_video', $2, $3::jsonb)
      `,
      [
        orderId,
        shotKey,
        JSON.stringify({
          shotNumber: shot.shotNumber,
          sceneId: shot.sceneId,
          shotType: shot.shotType,
          camera: shot.camera,
          lighting: shot.lighting,
          durationSec: shot.durationSec,
          signedDownloadUrl: `${env.PUBLIC_ASSET_BASE_URL}/download/${encodeURIComponent(shotKey)}?token=dev`
        })
      ]
    );
  }

  await runStepWithInput(orderId, 'final_render', attempt, {
    orderId,
    shotCount: shotPlan.length,
    totalDurationSec: shotPlan.reduce((sum, shot) => sum + shot.durationSec, 0)
  });

  const finalKey = `${order.user_id}/${orderId}/final/final-${randomUUID().slice(0, 8)}.mp4`;
  const thumbnailKey = `${order.user_id}/${orderId}/thumb/thumb-${randomUUID().slice(0, 8)}.jpg`;

  await query(
    `
    INSERT INTO artifacts (order_id, kind, s3_key, meta_json)
    VALUES
      ($1, 'final_video', $2, $3::jsonb),
      ($1, 'thumbnail', $4, $5::jsonb)
    `,
    [
      orderId,
      finalKey,
      JSON.stringify({
        signedDownloadUrl: `${env.PUBLIC_ASSET_BASE_URL}/download/${encodeURIComponent(finalKey)}?token=dev`,
        resolution: '1080p',
        durationSec: 32
      }),
      thumbnailKey,
      JSON.stringify({
        signedDownloadUrl: `${env.PUBLIC_ASSET_BASE_URL}/download/${encodeURIComponent(thumbnailKey)}?token=dev`
      })
    ]
  );

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

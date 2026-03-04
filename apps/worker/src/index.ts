import { randomUUID } from 'node:crypto';

import { type JobType, assertOrderTransition, type OrderStatus } from '@little/shared';
import { QueueEvents, Worker } from 'bullmq';

import { query } from './db.js';
import { env } from './env.js';

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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getOrder(orderId: string): Promise<OrderRow | null> {
  const rows = await query<OrderRow>('SELECT id, status, user_id FROM orders WHERE id = $1', [orderId]);
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

async function runStep(orderId: string, type: JobType, attempt: number): Promise<void> {
  const [jobRow] = await query<{ id: string }>(
    `
    INSERT INTO jobs (order_id, type, status, attempt, provider, started_at, input_json)
    VALUES ($1, $2, 'running', $3, $4, now(), $5::jsonb)
    RETURNING id
    `,
    [orderId, type, attempt, 'stub_provider', JSON.stringify({ orderId, type })]
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

async function markFailed(orderId: string, errorMessage: string): Promise<void> {
  await setOrderStatus(orderId, 'failed');

  if (env.AUTO_REFUND_ON_FAILURE) {
    await setOrderStatus(orderId, 'refunded');

    await query(
      `
      INSERT INTO jobs (order_id, type, status, attempt, provider, started_at, finished_at, output_json)
      VALUES ($1, 'final_render', 'succeeded', 1, 'stripe_stub', now(), now(), $2::jsonb)
      `,
      [orderId, JSON.stringify({ autoRefunded: true, reason: errorMessage })]
    );
  }
}

async function runPipeline(orderId: string, attempt: number): Promise<void> {
  const order = await getOrder(orderId);
  if (!order) {
    throw new Error(`Order ${orderId} not found`);
  }

  if (order.status !== 'paid') {
    throw new Error(`Order ${orderId} must be paid before rendering`);
  }

  await setOrderStatus(orderId, 'running');

  for (const step of pipelineSteps) {
    await runStep(orderId, step, attempt);
  }

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
        await markFailed(orderId, message);
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

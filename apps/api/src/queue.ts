import { Queue } from 'bullmq';

import { env } from './env.js';

export const RENDER_QUEUE_NAME = 'render-orders';

const redisUrl = new URL(env.REDIS_URL);
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || '6379'),
  password: redisUrl.password || undefined,
  username: redisUrl.username || undefined
};

export const renderQueue = new Queue(RENDER_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    removeOnComplete: 500,
    removeOnFail: 1000,
    backoff: {
      type: 'exponential',
      delay: 5000
    }
  }
});

export async function closeQueue(): Promise<void> {
  await renderQueue.close();
}

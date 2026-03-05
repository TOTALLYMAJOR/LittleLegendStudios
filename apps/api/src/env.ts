import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const currentDir = dirname(fileURLToPath(import.meta.url));
const rootEnvPath = resolve(currentDir, '../../../.env');

dotenv.config({
  path: process.env.ENV_FILE ?? rootEnvPath
});

const schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_PORT: z.coerce.number().int().positive().default(4000),
  NEXT_PUBLIC_API_BASE_URL: z.string().url().default('http://localhost:4000'),
  WEB_APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  PUBLIC_ASSET_BASE_URL: z.string().url().default('http://localhost:4000/assets'),
  STRIPE_SECRET_KEY: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  AUTO_REFUND_ON_FAILURE: z
    .string()
    .optional()
    .transform((value) => value === undefined || value.toLowerCase() === 'true')
});

export const env = schema.parse(process.env);

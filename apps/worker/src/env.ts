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
  PUBLIC_ASSET_BASE_URL: z.string().url().default('http://localhost:4000/assets'),
  ASSET_SIGNING_SECRET: z.string().min(16).default('dev_asset_signing_secret_change_me'),
  ASSET_UPLOAD_URL_TTL_SEC: z.coerce.number().int().positive().default(900),
  ASSET_DOWNLOAD_URL_TTL_SEC: z.coerce.number().int().positive().default(3600),
  VOICE_PROVIDER_MODE: z.enum(['stub', 'http']).default('stub'),
  VOICE_PROVIDER_BASE_URL: z
    .string()
    .url()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  SCENE_PROVIDER_MODE: z.enum(['stub', 'http']).default('stub'),
  SCENE_PROVIDER_BASE_URL: z
    .string()
    .url()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  PROVIDER_AUTH_TOKEN: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  PROVIDER_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  STRIPE_SECRET_KEY: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  AUTO_REFUND_ON_FAILURE: z
    .string()
    .optional()
    .transform((value) => value === undefined || value.toLowerCase() === 'true')
});

export const env = schema.parse(process.env);

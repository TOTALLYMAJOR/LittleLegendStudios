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
  PROVIDER_INTEGRATION_MODE: z.enum(['stub', 'hybrid', 'strict']).default('stub'),
  PROVIDER_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  PROVIDER_SOURCE_ASSET_BASE_URL: z
    .string()
    .url()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  PROVIDER_SOURCE_ASSET_BEARER_TOKEN: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  PROVIDER_AUTH_TOKEN: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  ELEVENLABS_API_KEY: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  ELEVENLABS_BASE_URL: z.string().url().default('https://api.elevenlabs.io'),
  ELEVENLABS_MODEL_ID: z.string().min(1).default('eleven_multilingual_v2'),
  ELEVENLABS_OUTPUT_FORMAT: z.string().min(1).default('mp3_44100_128'),
  ELEVENLABS_FALLBACK_VOICE_ID: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  HEYGEN_API_KEY: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  HEYGEN_BASE_URL: z.string().url().default('https://api.heygen.com'),
  HEYGEN_VIDEO_GENERATE_PATH: z.string().min(1).default('/v1/video_agent/generate'),
  SHOTSTACK_API_KEY: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  SHOTSTACK_BASE_URL: z.string().url().default('https://api.shotstack.io'),
  SHOTSTACK_STAGE: z.enum(['stage', 'v1']).default('stage'),
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

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
  PORT: z.coerce.number().int().positive().optional(),
  API_PORT: z.coerce.number().int().positive().default(4000),
  NEXT_PUBLIC_API_BASE_URL: z.string().url().default('http://localhost:4000'),
  WEB_APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  PUBLIC_ASSET_BASE_URL: z.string().url().default('http://localhost:4000/assets'),
  ASSET_SIGNING_SECRET: z.string().min(16).default('dev_asset_signing_secret_change_me'),
  ASSET_UPLOAD_URL_TTL_SEC: z.coerce.number().int().positive().default(900),
  ASSET_DOWNLOAD_URL_TTL_SEC: z.coerce.number().int().positive().default(3600),
  ASSET_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(26214400),
  ASSET_LOCAL_ROOT: z.string().min(1).default('/tmp/little-legend-assets'),
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
  MODERATION_EXTERNAL_MODEL_MODE: z.enum(['off', 'hybrid', 'strict']).default('off'),
  MODERATION_EXTERNAL_MODEL_BASE_URL: z
    .string()
    .url()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  MODERATION_EXTERNAL_MODEL_PATH: z.string().min(1).default('/v1/moderation/photo-scores'),
  MODERATION_EXTERNAL_MODEL_API_KEY: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  PROVIDER_AUTH_TOKEN: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  PROVIDER_WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  ADMIN_API_TOKEN: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  PARENT_AUTH_SECRET: z.string().min(16).default('dev_parent_auth_secret_change_me'),
  PARENT_AUTH_TTL_SEC: z.coerce.number().int().positive().default(2592000),
  PARENT_MAX_RETRY_REQUESTS: z.coerce.number().int().min(1).max(10).default(2),
  ORDER_DATA_RETENTION_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform((value) => value.toLowerCase() === 'true'),
  ORDER_DATA_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  ORDER_DATA_RETENTION_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(21600000),
  ORDER_DATA_RETENTION_SWEEP_LIMIT: z.coerce.number().int().min(1).max(500).default(25),
  GIFT_REDEMPTION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  PROVIDER_TASK_POLL_MIN_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  PROVIDER_TASK_ASSUME_SUCCESS_AFTER_SEC: z.coerce.number().int().positive().default(45),
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
  HEYGEN_VIDEO_STATUS_PATH: z.string().min(1).default('/v1/video_agent/status'),
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
  EMAIL_PROVIDER_MODE: z.enum(['stub', 'resend']).default('stub'),
  RESEND_API_KEY: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  EMAIL_FROM: z.string().min(3).default('Little Legend Studios <no-reply@example.com>'),
  SUPPORT_EMAIL: z.string().email().default('support@example.com'),
  AUTO_REFUND_ON_FAILURE: z
    .string()
    .optional()
    .transform((value) => value === undefined || value.toLowerCase() === 'true')
});

const parsedEnv = schema.parse(process.env);

export const env = {
  ...parsedEnv,
  API_PORT: parsedEnv.PORT ?? parsedEnv.API_PORT
};

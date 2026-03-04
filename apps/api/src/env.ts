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
  PUBLIC_ASSET_BASE_URL: z.string().url().default('http://localhost:4000/assets'),
  AUTO_REFUND_ON_FAILURE: z
    .string()
    .optional()
    .transform((value) => value === undefined || value.toLowerCase() === 'true')
});

export const env = schema.parse(process.env);

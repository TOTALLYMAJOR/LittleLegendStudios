import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { env } from './env.js';

const HEX_SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;

function normalizeRootDir(rootDir: string): string {
  return resolve(rootDir);
}

function normalizeAssetKey(assetKey: string): string {
  const trimmed = assetKey.trim().replaceAll('\\', '/').replaceAll(/\/{2,}/g, '/');
  if (trimmed.length === 0 || trimmed.startsWith('/') || trimmed.includes('..')) {
    throw new Error('Invalid asset key path');
  }

  return trimmed;
}

export function resolveAssetPath(assetKey: string): string {
  const root = normalizeRootDir(env.ASSET_LOCAL_ROOT);
  const normalizedKey = normalizeAssetKey(assetKey);
  const fullPath = resolve(root, normalizedKey);

  if (!fullPath.startsWith(root)) {
    throw new Error('Resolved asset path escapes configured root');
  }

  return fullPath;
}

export async function writeAssetBytes(assetKey: string, bytes: Buffer): Promise<string> {
  const fullPath = resolveAssetPath(assetKey);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, bytes);
  return fullPath;
}

export async function readAssetBytes(assetKey: string): Promise<Buffer> {
  const fullPath = resolveAssetPath(assetKey);
  return readFile(fullPath);
}

export async function deleteAssetByKey(assetKey: string): Promise<void> {
  const fullPath = resolveAssetPath(assetKey);
  await rm(fullPath, { force: true });
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isSha256Hex(value: string | null): value is string {
  return Boolean(value && HEX_SHA256_PATTERN.test(value));
}

export function normalizeContentType(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase();
}

export function inferContentTypeFromKey(assetKey: string): string {
  const lower = assetKey.toLowerCase();
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

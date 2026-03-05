import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildSignedAssetUrl, verifyAssetToken } from '@little/shared';

import {
  inferContentTypeFromKey,
  isSha256Hex,
  normalizeContentType,
  readAssetBytes,
  sha256Hex,
  writeAssetBytes
} from './asset-store.js';
import { query } from './db.js';
import { env } from './env.js';

interface UploadMetaRow {
  id: string;
  content_type: string;
  bytes: number;
  sha256: string | null;
}

interface UploadContentTypeRow {
  content_type: string;
}

const assetPathSchema = z.object({
  assetKey: z.string().min(1)
});

const tokenQuerySchema = z.object({
  token: z.string().min(1)
});

function decodeAssetKey(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function assertValidToken(args: {
  token: string;
  expectedPurpose: 'upload' | 'download';
  expectedKey: string;
}): { ok: true } | { ok: false; reason: string } {
  const result = verifyAssetToken({
    token: args.token,
    expectedPurpose: args.expectedPurpose,
    expectedKey: args.expectedKey,
    secret: env.ASSET_SIGNING_SECRET
  });

  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }

  return { ok: true };
}

export function createSignedUploadUrl(assetKey: string): string {
  return buildSignedAssetUrl({
    baseUrl: env.PUBLIC_ASSET_BASE_URL,
    purpose: 'upload',
    key: assetKey,
    expiresInSec: env.ASSET_UPLOAD_URL_TTL_SEC,
    secret: env.ASSET_SIGNING_SECRET
  });
}

export function createSignedDownloadUrl(assetKey: string): string {
  return buildSignedAssetUrl({
    baseUrl: env.PUBLIC_ASSET_BASE_URL,
    purpose: 'download',
    key: assetKey,
    expiresInSec: env.ASSET_DOWNLOAD_URL_TTL_SEC,
    secret: env.ASSET_SIGNING_SECRET
  });
}

export function registerAssetRoutes(app: FastifyInstance): void {
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.put(
    '/assets/upload/:assetKey',
    {
      bodyLimit: env.ASSET_MAX_UPLOAD_BYTES
    },
    async (request, reply) => {
      const params = assetPathSchema.parse(request.params);
      const queryParams = tokenQuerySchema.parse(request.query);
      const assetKey = decodeAssetKey(params.assetKey);

      const tokenValidation = assertValidToken({
        token: queryParams.token,
        expectedPurpose: 'upload',
        expectedKey: assetKey
      });

      if (!tokenValidation.ok) {
        return reply.status(403).send({ message: `Invalid upload token: ${tokenValidation.reason}` });
      }

      const rows = await query<UploadMetaRow>(
        `
        SELECT id, content_type, bytes, sha256
        FROM uploads
        WHERE s3_key = $1
        LIMIT 1
        `,
        [assetKey]
      );

      const uploadMeta = rows[0];

      const requestContentType = normalizeContentType(String(request.headers['content-type'] ?? ''));
      if (!requestContentType) {
        return reply.status(400).send({ message: 'Content-Type header is required.' });
      }

      const body = request.body;
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : '');
      if (buffer.length === 0) {
        return reply.status(400).send({ message: 'Upload body is empty.' });
      }

      if (uploadMeta) {
        if (requestContentType !== uploadMeta.content_type) {
          return reply.status(400).send({
            message: `Content-Type mismatch. Expected ${uploadMeta.content_type}, got ${requestContentType}.`
          });
        }

        if (buffer.length !== uploadMeta.bytes) {
          return reply.status(400).send({
            message: `Upload size mismatch. Expected ${uploadMeta.bytes} bytes, got ${buffer.length}.`
          });
        }

        if (isSha256Hex(uploadMeta.sha256)) {
          const actualHash = sha256Hex(buffer);
          if (actualHash !== uploadMeta.sha256.toLowerCase()) {
            return reply.status(400).send({ message: 'Upload checksum mismatch.' });
          }
        }
      }

      await writeAssetBytes(assetKey, buffer);

      return reply.send({
        uploaded: true,
        assetKey,
        bytes: buffer.length
      });
    }
  );

  app.get('/assets/download/:assetKey', async (request, reply) => {
    const params = assetPathSchema.parse(request.params);
    const queryParams = tokenQuerySchema.parse(request.query);
    const assetKey = decodeAssetKey(params.assetKey);

    const tokenValidation = assertValidToken({
      token: queryParams.token,
      expectedPurpose: 'download',
      expectedKey: assetKey
    });

    if (!tokenValidation.ok) {
      return reply.status(403).send({ message: `Invalid download token: ${tokenValidation.reason}` });
    }

    let bytes: Buffer;
    try {
      bytes = await readAssetBytes(assetKey);
    } catch {
      return reply.status(404).send({ message: 'Asset not found.' });
    }

    const uploadRows = await query<UploadContentTypeRow>(
      `
      SELECT content_type
      FROM uploads
      WHERE s3_key = $1
      LIMIT 1
      `,
      [assetKey]
    );

    const contentType = uploadRows[0]?.content_type ?? inferContentTypeFromKey(assetKey);
    reply.header('Content-Type', contentType);
    reply.header('Cache-Control', 'private, max-age=60');
    return reply.send(bytes);
  });
}

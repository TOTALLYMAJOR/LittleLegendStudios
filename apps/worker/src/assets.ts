import { buildSignedAssetUrl } from '@little/shared';

import { env } from './env.js';

function createSignedUploadUrl(assetKey: string): string {
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

export async function downloadAssetBytes(assetKey: string): Promise<{ contentType: string; bytes: Uint8Array }> {
  const signedDownloadUrl = createSignedDownloadUrl(assetKey);
  const response = await fetch(signedDownloadUrl, {
    method: 'GET'
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to download asset ${assetKey}: ${response.status} ${text.slice(0, 300)}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`Downloaded asset ${assetKey} is empty.`);
  }

  const contentTypeHeader = response.headers.get('content-type');
  return {
    contentType: contentTypeHeader?.split(';')[0]?.trim() || 'application/octet-stream',
    bytes
  };
}

export async function uploadAssetBytes(args: {
  assetKey: string;
  contentType: string;
  bytes: Uint8Array;
}): Promise<void> {
  const signedUploadUrl = createSignedUploadUrl(args.assetKey);
  const response = await fetch(signedUploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': args.contentType
    },
    body: Buffer.from(args.bytes)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to upload asset ${args.assetKey}: ${response.status} ${text.slice(0, 300)}`);
  }
}

export function buildJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}

export function buildStubMp3Bytes(label: string): Uint8Array {
  return Buffer.from(`ID3LittleLegend:${label}`, 'utf8');
}

export function buildStubMp4Bytes(label: string): Uint8Array {
  const ftyp = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
  const note = Buffer.from(`stub:${label}`, 'utf8');
  return Buffer.concat([ftyp, note]);
}

export function buildStubJpegBytes(): Uint8Array {
  return Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEBAVFhUVFRUVFRUVFRUVFRUVFRUWFhUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGhAQGi0fHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAoACgMBIgACEQEDEQH/xAAbAAEAAgMBAQAAAAAAAAAAAAAABQYDBEcBAv/EADcQAAIBAwMCBAQEBQQDAQAAAAECAwAEEQUSITFBBhMiUWFxFDKBkaEjQlKxwSNSYnLh8AcWQ3Oi/8QAGQEAAwEBAQAAAAAAAAAAAAAAAAECAwQF/8QAHhEBAQEBAQADAQEAAAAAAAAAAAECEQMhMQQSMlH/2gAMAwEAAhEDEQA/ALr6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmW7yx7aYz7z9zq3u3+J3yJ8H2K5qL9l7Xq7X3Qxw8r2V2n7aPj5r2j7+fZr7m2wq4a0l0Yxk4x8s9Q4WnHnqvP0fWz6m7r9f6bL5o9l3b8v6X4xkW9u2f2W8cUqk6m0uQ3W3Y2e7eY0k7x6+fVfYw0f6j5L6nTq6m2w9r3b7j8NfY7mWnq6Y8d4K8o6w7Fj3+u8f2o9X2t7s2q2V2o8P8A0r7l7v7x9x1d7m7yY7c7m4k7fV9mVdR0j9J7t4h5s2q7y8W3W7p5Q8uO+6c4L8v7f5zv8A9rQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//2Q==',
    'base64'
  );
}

export async function fetchRemoteAssetBytes(args: {
  url: string;
  fallbackContentType: string;
}): Promise<{ contentType: string; bytes: Uint8Array }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.PROVIDER_HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(args.url, {
      method: 'GET',
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 250)}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new Error('Provider output payload is empty.');
    }

    const contentTypeHeader = response.headers.get('content-type');
    const contentType = contentTypeHeader?.split(';')[0]?.trim() || args.fallbackContentType;

    return {
      contentType,
      bytes
    };
  } finally {
    clearTimeout(timeout);
  }
}

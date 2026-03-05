import { buildSignedAssetUrl } from '@little/shared';

import { env } from './env.js';

export function createSignedDownloadUrl(assetKey: string): string {
  return buildSignedAssetUrl({
    baseUrl: env.PUBLIC_ASSET_BASE_URL,
    purpose: 'download',
    key: assetKey,
    expiresInSec: env.ASSET_DOWNLOAD_URL_TTL_SEC,
    secret: env.ASSET_SIGNING_SECRET
  });
}

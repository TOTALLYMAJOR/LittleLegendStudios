import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from './env.js';

interface ParentAccessTokenPayload {
  uid: string;
  em: string;
  iat: number;
  exp: number;
}

export interface ParentAccessIdentity {
  userId: string;
  email: string;
}

function toBase64UrlJson(value: ParentAccessTokenPayload): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signPayload(encodedPayload: string): string {
  return createHmac('sha256', env.PARENT_AUTH_SECRET).update(encodedPayload).digest('base64url');
}

export function createParentAccessToken(identity: ParentAccessIdentity): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: ParentAccessTokenPayload = {
    uid: identity.userId,
    em: identity.email.toLowerCase(),
    iat: now,
    exp: now + env.PARENT_AUTH_TTL_SEC
  };

  const encodedPayload = toBase64UrlJson(payload);
  const signature = signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function verifyParentAccessToken(token: string): ParentAccessIdentity | null {
  const parts = token.split('.', 2);
  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, providedSignature] = parts;
  if (!encodedPayload || !providedSignature) {
    return null;
  }

  const expectedSignature = signPayload(encodedPayload);
  if (providedSignature.length !== expectedSignature.length) {
    return null;
  }

  const signatureMatches = timingSafeEqual(
    Buffer.from(providedSignature, 'utf8'),
    Buffer.from(expectedSignature, 'utf8')
  );
  if (!signatureMatches) {
    return null;
  }

  let payload: ParentAccessTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as ParentAccessTokenPayload;
  } catch {
    return null;
  }

  if (
    !payload ||
    typeof payload.uid !== 'string' ||
    typeof payload.em !== 'string' ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number'
  ) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) {
    return null;
  }

  return {
    userId: payload.uid,
    email: payload.em.toLowerCase()
  };
}

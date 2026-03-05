import { createHmac, timingSafeEqual } from 'node:crypto';

export type AssetTokenPurpose = 'upload' | 'download';

interface AssetTokenPayload {
  v: 1;
  p: AssetTokenPurpose;
  k: string;
  exp: number;
}

interface SignAssetTokenArgs {
  purpose: AssetTokenPurpose;
  key: string;
  expiresAtUnixSec: number;
  secret: string;
}

interface VerifyAssetTokenArgs {
  token: string;
  expectedPurpose: AssetTokenPurpose;
  expectedKey: string;
  secret: string;
  nowUnixSec?: number;
}

interface BuildSignedAssetUrlArgs {
  baseUrl: string;
  purpose: AssetTokenPurpose;
  key: string;
  expiresInSec: number;
  secret: string;
  nowUnixSec?: number;
}

interface VerifiedAssetTokenResult {
  ok: true;
  payload: AssetTokenPayload;
}

interface FailedAssetTokenResult {
  ok: false;
  reason: string;
}

type AssetTokenVerificationResult = VerifiedAssetTokenResult | FailedAssetTokenResult;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function tokenActionPath(purpose: AssetTokenPurpose): 'upload' | 'download' {
  return purpose === 'upload' ? 'upload' : 'download';
}

function encodePayload(payload: AssetTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodePayload(segment: string): AssetTokenPayload {
  const raw = Buffer.from(segment, 'base64url').toString('utf8');
  const parsed = JSON.parse(raw) as Partial<AssetTokenPayload>;

  if (parsed.v !== 1 || (parsed.p !== 'upload' && parsed.p !== 'download') || typeof parsed.k !== 'string') {
    throw new Error('Invalid token payload shape');
  }

  const expiresAt = parsed.exp;
  if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt <= 0) {
    throw new Error('Invalid token expiry');
  }

  return {
    v: 1,
    p: parsed.p,
    k: parsed.k,
    exp: expiresAt
  };
}

function signSegment(segment: string, secret: string): string {
  return createHmac('sha256', secret).update(segment).digest('base64url');
}

function safeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function signAssetToken(args: SignAssetTokenArgs): string {
  const payload: AssetTokenPayload = {
    v: 1,
    p: args.purpose,
    k: args.key,
    exp: args.expiresAtUnixSec
  };

  const encoded = encodePayload(payload);
  const signature = signSegment(encoded, args.secret);
  return `${encoded}.${signature}`;
}

export function verifyAssetToken(args: VerifyAssetTokenArgs): AssetTokenVerificationResult {
  if (!args.token || !args.secret) {
    return { ok: false, reason: 'Missing token or secret' };
  }

  const [encodedPayload, signature] = args.token.split('.', 2);
  if (!encodedPayload || !signature) {
    return { ok: false, reason: 'Malformed token format' };
  }

  const expectedSignature = signSegment(encodedPayload, args.secret);
  if (!safeEqualText(signature, expectedSignature)) {
    return { ok: false, reason: 'Token signature mismatch' };
  }

  let payload: AssetTokenPayload;
  try {
    payload = decodePayload(encodedPayload);
  } catch (error) {
    return { ok: false, reason: `Invalid token payload: ${(error as Error).message}` };
  }

  if (payload.p !== args.expectedPurpose) {
    return { ok: false, reason: 'Token purpose mismatch' };
  }

  if (payload.k !== args.expectedKey) {
    return { ok: false, reason: 'Token key mismatch' };
  }

  const now = args.nowUnixSec ?? Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    return { ok: false, reason: 'Token expired' };
  }

  return {
    ok: true,
    payload
  };
}

export function buildSignedAssetUrl(args: BuildSignedAssetUrlArgs): string {
  const now = args.nowUnixSec ?? Math.floor(Date.now() / 1000);
  const expiresAt = now + Math.max(1, Math.floor(args.expiresInSec));
  const token = signAssetToken({
    purpose: args.purpose,
    key: args.key,
    expiresAtUnixSec: expiresAt,
    secret: args.secret
  });

  const action = tokenActionPath(args.purpose);
  return `${normalizeBaseUrl(args.baseUrl)}/${action}/${encodeURIComponent(args.key)}?token=${encodeURIComponent(token)}`;
}

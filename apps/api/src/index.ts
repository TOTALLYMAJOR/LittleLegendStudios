import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import { assertOrderTransition, type OrderStatus, type SceneRenderSpec, type ScriptPayload, type ThemeManifest } from '@little/shared';
import { AGE_GROUPS, PARENT_APPROVAL_REASONS, PARENT_APPROVAL_STATUSES } from '@little/shared/child-director';
import fastifyRawBody from 'fastify-raw-body';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type Stripe from 'stripe';
import { z } from 'zod';

import { createSignedDownloadUrl, createSignedUploadUrl, registerAssetRoutes } from './asset-routes.js';
import { deleteAssetByKey, writeAssetBytes } from './asset-store.js';
import { pool, query } from './db.js';
import { sendTransactionalEmail } from './email.js';
import { env } from './env.js';
import { createParentAccessToken, verifyParentAccessToken } from './parent-auth.js';
import { registerProviderRoutes } from './provider-routes.js';
import { renderQueue } from './queue.js';
import { generateScript } from './script.js';
import { seedThemes } from './seed.js';
import {
  canVerifyStripeWebhook,
  constructStripeWebhookEvent,
  createCheckoutSession,
  isStripePaymentsEnabled
} from './stripe.js';

interface UserRow {
  id: string;
  email: string;
  created_at: string;
}

interface ThemeRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  duration_min_sec: number;
  duration_max_sec: number;
  template_manifest_json: Record<string, unknown>;
  is_active: boolean;
}

interface OrderRow {
  id: string;
  user_id: string;
  theme_id: string;
  status: OrderStatus;
  currency: string;
  amount_cents: number;
  stripe_payment_intent_id: string | null;
  created_at: string;
  updated_at: string;
}

interface UploadCountRow {
  count: number;
}

interface UploadKindSummaryRow {
  kind: 'photo' | 'voice';
  count: number;
  normalized_content_types: string[] | null;
}

interface AssetKeyRow {
  s3_key: string;
}

interface ArtifactMetaRow {
  meta_json: Record<string, unknown>;
}

interface ProviderTaskStatusRow {
  provider_task_id: string;
  provider: string;
  order_id: string | null;
  job_type: string | null;
  status: string;
  artifact_key: string | null;
  output_json: Record<string, unknown>;
  error_text: string | null;
  last_polled_at: string | null;
  created_at: string;
  updated_at: string;
}

type ProviderDeleteTargetType = 'voice_clone' | 'video' | 'render' | 'hosted_asset';
type ProviderDeleteIdentifierSource =
  | 'artifact_meta'
  | 'provider_task'
  | 'provider_task_output'
  | 'artifact_meta_output'
  | 'provider_lookup';
type ProviderDeleteVerification =
  | 'provider_confirmed'
  | 'already_absent'
  | 'best_effort'
  | 'not_supported'
  | 'not_attempted';

interface ProviderDeleteTarget {
  provider: string;
  target: string;
  targetType: ProviderDeleteTargetType;
  identifierSource: ProviderDeleteIdentifierSource;
}

interface ProviderDeleteResult {
  provider: ProviderDeleteTarget['provider'];
  target: ProviderDeleteTarget['target'];
  targetType: ProviderDeleteTargetType;
  identifierSource: ProviderDeleteIdentifierSource;
  status: 'deleted' | 'skipped' | 'failed';
  verification: ProviderDeleteVerification;
  detail: string;
}

interface ProviderDeletionSummary {
  discoveredTargetCount: number;
  attempted: number;
  deleted: number;
  skipped: number;
  failed: number;
  verified: number;
  targets: ProviderDeleteTarget[];
  byProvider: Array<{
    provider: string;
    discoveredTargetCount: number;
    attempted: number;
    deleted: number;
    skipped: number;
    failed: number;
    verified: number;
  }>;
  results: ProviderDeleteResult[];
}

interface LatestScriptRow {
  id: string;
  version: number;
  script_json: ScriptPayload;
  approved_at: string | null;
  created_at: string;
}

interface RetryUsageRow {
  used: number;
}

interface GiftLinkRow {
  id: string;
  order_id: string;
  recipient_email: string;
  sender_name: string | null;
  gift_message: string | null;
  token_hash: string;
  token_encrypted: string | null;
  token_hint: string;
  status: 'pending' | 'redeemed' | 'expired' | 'revoked';
  redeemed_by_user_id: string | null;
  redeemed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface GiftRedeemOrderRow {
  id: string;
  status: OrderStatus;
  theme_name: string;
}

interface OrderOwnerRow {
  id: string;
  email: string;
}

interface ChildDirectorPreviewSessionRow {
  id: string;
  session_id: string;
  parent_user_id: string | null;
  age_group: string;
  release_track: string;
  preview_json: Record<string, unknown>;
  parent_approval_json: Array<Record<string, unknown>>;
  created_at: string;
  updated_at: string;
}

interface PaymentIdempotencyRow {
  id: string;
  order_id: string;
  idempotency_key: string;
  status: 'in_progress' | 'completed' | 'failed';
  response_json: Record<string, unknown> | null;
  error_text: string | null;
  created_at: string;
  updated_at: string;
}

interface RenderEnqueueDedupeRow {
  id: string;
  order_id: string;
  dedupe_key: string;
  job_id: string;
  payment_intent_id: string;
  source: string;
  created_at: string;
}

interface StripeWebhookEventRow {
  event_id: string;
  event_type: string;
  status: 'processing' | 'processed' | 'failed';
  delivery_count: number;
  payload_json: Record<string, unknown>;
  last_error: string | null;
  first_received_at: string;
  last_received_at: string;
  processed_at: string | null;
}

interface EmailNotificationFailureRow {
  id: string;
  order_id: string;
  order_status: OrderStatus;
  parent_email: string;
  recipient_email: string;
  notification_type: 'delivery_ready' | 'render_failed' | 'gift_redeem_link';
  provider: string;
  provider_message_id: string | null;
  subject: string;
  error_text: string | null;
  payload_json: Record<string, unknown>;
  created_at: string;
}

interface EmailFailureCountRow {
  key: string;
  count: number;
}

interface RetryHistoryRow {
  id: string;
  order_id: string;
  current_order_status: OrderStatus;
  parent_email: string;
  actor: 'parent' | 'admin';
  requested_status: OrderStatus;
  accepted: boolean;
  reason: string | null;
  created_at: string;
}

interface OrderJobStatusRow {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  provider: string;
  attempt: number;
  input_json: Record<string, unknown> | null;
  output_json: Record<string, unknown> | null;
  error_text: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

interface ModerationReviewRow {
  id: string;
  order_id: string;
  order_status: OrderStatus;
  parent_email: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  provider: string;
  attempt: number;
  output_json: Record<string, unknown> | null;
  error_text: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

interface ModerationJobRow {
  id: string;
  order_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  provider: string;
  attempt: number;
  output_json: Record<string, unknown> | null;
  error_text: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

type ModerationCaseActionType = 'approve_override' | 'reject_override';

interface ModerationCaseActionRow {
  id: string;
  moderation_job_id: string;
  order_id: string;
  action: ModerationCaseActionType;
  note: string;
  actor: string;
  previous_order_status: OrderStatus;
  resulting_order_status: OrderStatus;
  previous_decision: ModerationDecision;
  resulting_decision: ModerationDecision;
  retry_request_id: string | null;
  retry_job_id: string | null;
  created_at: string;
}

interface ProviderTaskCleanupRow {
  provider_task_id: string;
  provider: string;
  output_json: Record<string, unknown>;
}

type OrderDataPurgeTriggerSource = 'manual_parent' | 'manual_admin' | 'retention_sweep';
type OrderDataPurgeOutcome = 'succeeded' | 'failed';

interface OrderDataPurgeEventRow {
  id: string;
  order_id: string;
  parent_email: string;
  trigger_source: OrderDataPurgeTriggerSource;
  actor: 'parent' | 'admin' | null;
  previous_order_status: OrderStatus;
  resulting_order_status: OrderStatus;
  outcome: OrderDataPurgeOutcome;
  deleted_asset_count: number;
  provider_deletion_json: Partial<ProviderDeletionSummary>;
  retention_window_days: number | null;
  error_text: string | null;
  created_at: string;
}

interface ScenePlanEntry {
  shotNumber: number;
  shotType: 'narration' | 'dialogue';
  durationSec: number;
  sceneFallbackUsed: boolean;
  sceneRenderSpec: SceneRenderSpec;
}

type RenderEnqueueSource =
  | 'payment_stub'
  | 'payment_webhook'
  | 'parent_retry'
  | 'admin_retry'
  | 'admin_moderation_override';

interface QueueRenderResult {
  queued: boolean;
  deduped: boolean;
  jobId: string;
  dedupeKey: string;
}

const LAUNCH_PRICE_CENTS = 3900;
const MIN_PHOTO_UPLOADS = 5;
const MAX_PHOTO_UPLOADS = 15;
const REQUIRED_VOICE_UPLOADS = 1;
const MAX_SCRIPT_VERSIONS_PER_ORDER = 3;
const parentRetryableStatuses: OrderStatus[] = ['paid', 'failed_soft', 'failed_hard', 'manual_review'];
const postPaymentStatuses = new Set<OrderStatus>([
  'paid',
  'running',
  'failed_soft',
  'failed_hard',
  'refund_queued',
  'manual_review',
  'delivered',
  'refunded',
  'expired'
]);
const photoContentTypes = new Set(['image/jpeg', 'image/png']);
const voiceContentTypes = new Set(['audio/wav', 'audio/x-wav', 'audio/m4a', 'audio/x-m4a', 'audio/mp4']);

const createUserSchema = z.object({
  email: z.string().email()
});

const createOrderSchema = z.object({
  userId: z.string().uuid(),
  themeSlug: z.string().min(1),
  currency: z.string().min(3).max(3).default('usd')
});

const uploadSignSchema = z.object({
  kind: z.enum(['photo', 'voice']),
  contentType: z.string().min(1),
  bytes: z.number().int().positive(),
  sha256: z.string().min(1).optional()
});

const consentSchema = z.object({
  userId: z.string().uuid(),
  version: z.string().min(1),
  ip: z.string().optional(),
  userAgent: z.string().optional()
});

const generateScriptSchema = z.object({
  childName: z.string().min(1),
  keywords: z.array(z.string()).optional()
});

const approveScriptSchema = z.object({
  version: z.number().int().positive()
});

const adminRetrySchema = z.object({
  reason: z.string().min(1).max(500).optional()
});

const adminEmailFailuresQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  orderId: z.string().uuid().optional(),
  notificationType: z.enum(['delivery_ready', 'render_failed', 'gift_redeem_link']).optional()
});

const adminRetryHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  orderId: z.string().uuid().optional(),
  actor: z.enum(['parent', 'admin']).optional(),
  accepted: z.coerce.boolean().optional()
});

const adminModerationReviewsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  orderId: z.string().uuid().optional(),
  stepStatus: z.enum(['queued', 'running', 'succeeded', 'failed']).optional(),
  decision: z.enum(['pass', 'manual_review', 'reject', 'unknown']).optional()
});

const adminModerationCaseActionSchema = z.object({
  action: z.enum(['approve', 'reject']),
  note: z.string().trim().min(5).max(2000),
  queueRetry: z.boolean().optional().default(true)
});

const adminOrderDataPurgeHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  orderId: z.string().uuid().optional(),
  triggerSource: z.enum(['manual_parent', 'manual_admin', 'retention_sweep']).optional(),
  outcome: z.enum(['succeeded', 'failed']).optional()
});

const parentRetrySchema = z.object({
  reason: z.string().min(1).max(500).optional()
});

const giftLinkCreateSchema = z.object({
  recipientEmail: z.string().email(),
  senderName: z.string().trim().min(1).max(120).optional(),
  giftMessage: z.string().trim().min(1).max(500).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  sendEmail: z.boolean().optional().default(true)
});

const giftRedeemParamsSchema = z.object({
  token: z.string().min(24).max(200)
});

const giftRedeemSchema = z.object({
  parentEmail: z.string().email()
});

const childDirectorPreviewPayloadSchema = z.object({
  id: z.string().min(1).max(120),
  ageGroup: z.literal('explorer'),
  releaseTrack: z.literal('release-2'),
  createdAtIso: z.string().datetime(),
  runtimeTargetSec: z.number().int().min(30).max(240),
  majorDecisionCount: z.number().int().min(0).max(20),
  contentRiskScore: z.number().min(0).max(1),
  choiceOrder: z.array(z.string().min(1).max(120)).min(1).max(12),
  branchChoices: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        title: z.string().min(1).max(200)
      })
    )
    .max(3),
  thumbnailLabel: z.string().min(1).max(240),
  shortAudioPrompt: z.string().min(1).max(400)
});

const childDirectorParentApprovalRequestSchema = z.object({
  id: z.string().min(1).max(120),
  reason: z.enum(PARENT_APPROVAL_REASONS),
  status: z.enum(PARENT_APPROVAL_STATUSES)
});

const childDirectorPreviewSessionCreateSchema = z.object({
  sessionId: z.string().trim().min(1).max(120),
  ageGroup: z.enum(AGE_GROUPS),
  releaseTrack: z.string().trim().min(1).max(40).default('release-2'),
  preview: childDirectorPreviewPayloadSchema,
  parentApprovalRequests: z.array(childDirectorParentApprovalRequestSchema).max(10).default([])
});

const childDirectorPreviewSessionParamsSchema = z.object({
  sessionId: z.string().trim().min(1).max(120)
});

function parseBearerToken(value: string | string[] | undefined): string | null {
  if (!value || Array.isArray(value)) {
    return null;
  }

  const [scheme, token] = value.split(' ', 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }

  return token.trim();
}

function hasAdminAccess(request: FastifyRequest): boolean {
  if (!env.ADMIN_API_TOKEN) {
    return false;
  }

  const bearerToken = parseBearerToken(request.headers.authorization);
  if (bearerToken && bearerToken === env.ADMIN_API_TOKEN) {
    return true;
  }

  const headerToken = request.headers['x-admin-api-token'];
  return typeof headerToken === 'string' && headerToken === env.ADMIN_API_TOKEN;
}

function resolveAdminActor(request: FastifyRequest): string {
  const fromHeader =
    readHeaderToken(request.headers['x-admin-actor']) ??
    readHeaderToken(request.headers['x-admin-email']) ??
    readHeaderToken(request.headers['x-admin-user']) ??
    null;

  if (!fromHeader) {
    return 'admin';
  }

  return fromHeader.slice(0, 120);
}

function readHeaderToken(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

function readCookieToken(cookieHeader: string | string[] | undefined, cookieName: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  for (const part of raw.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name !== cookieName || valueParts.length === 0) {
      continue;
    }

    const value = valueParts.join('=').trim();
    if (!value) {
      return null;
    }

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

function extractParentAccessToken(request: FastifyRequest): string | null {
  const bearerToken = parseBearerToken(request.headers.authorization);
  if (bearerToken) {
    return bearerToken;
  }

  const headerToken = request.headers['x-parent-access-token'];
  if (typeof headerToken === 'string' && headerToken.trim().length > 0) {
    return headerToken.trim();
  }

  return readCookieToken(request.headers.cookie, 'parent_access_token');
}

function extractIdempotencyKey(request: FastifyRequest, fallbackKey: string): string {
  const primary = readHeaderToken(request.headers['idempotency-key']);
  if (primary) {
    return primary;
  }

  const secondary = readHeaderToken(request.headers['x-idempotency-key']);
  if (secondary) {
    return secondary;
  }

  return fallbackKey;
}

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildParentAccessTokenSetCookie(token: string): string {
  const isSecureWebOrigin = env.WEB_APP_BASE_URL.startsWith('https://');
  const parts = [
    `parent_access_token=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${env.PARENT_AUTH_TTL_SEC}`,
    'HttpOnly',
    isSecureWebOrigin ? 'SameSite=None' : 'SameSite=Lax'
  ];

  if (isSecureWebOrigin) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function buildGiftRedemptionUrl(token: string): string {
  return `${env.WEB_APP_BASE_URL}/gift/redeem/${token}`;
}

function buildGiftTokenHint(token: string): string {
  return token.slice(-6);
}

function createGiftToken(): string {
  return randomBytes(24).toString('hex');
}

function getGiftTokenEncryptionKey(): Buffer {
  return createHash('sha256').update(env.PARENT_AUTH_SECRET).digest();
}

function encryptGiftToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getGiftTokenEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${authTag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptGiftToken(value: string): string | null {
  const [ivText, authTagText, ciphertextText] = value.split('.', 3);
  if (!ivText || !authTagText || !ciphertextText) {
    return null;
  }

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      getGiftTokenEncryptionKey(),
      Buffer.from(ivText, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(authTagText, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, 'base64url')),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

function isGiftLinkExpired(link: Pick<GiftLinkRow, 'expires_at'>): boolean {
  return Date.parse(link.expires_at) <= Date.now();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function getOrder(orderId: string): Promise<OrderRow | null> {
  const rows = await query<OrderRow>('SELECT * FROM orders WHERE id = $1', [orderId]);
  return rows[0] ?? null;
}

async function getOrderOwner(userId: string): Promise<OrderOwnerRow | null> {
  const rows = await query<OrderOwnerRow>('SELECT id, email FROM users WHERE id = $1 LIMIT 1', [userId]);
  return rows[0] ?? null;
}

async function assertParentOwnsOrder(request: FastifyRequest, order: OrderRow): Promise<boolean> {
  const token = extractParentAccessToken(request);
  if (!token) {
    return false;
  }

  const identity = verifyParentAccessToken(token);
  if (!identity) {
    return false;
  }

  if (identity.userId !== order.user_id) {
    return false;
  }

  const owner = await getOrderOwner(order.user_id);
  if (!owner) {
    return false;
  }

  return owner.email.toLowerCase() === identity.email.toLowerCase();
}

async function assertParentOwnsUserId(request: FastifyRequest, userId: string): Promise<boolean> {
  const token = extractParentAccessToken(request);
  if (!token) {
    return false;
  }

  const identity = verifyParentAccessToken(token);
  if (!identity || identity.userId !== userId) {
    return false;
  }

  const owner = await getOrderOwner(userId);
  if (!owner) {
    return false;
  }

  return owner.email.toLowerCase() === identity.email.toLowerCase();
}

async function resolveVerifiedParentUserId(request: FastifyRequest): Promise<string | null> {
  const token = extractParentAccessToken(request);
  if (!token) {
    return null;
  }

  const identity = verifyParentAccessToken(token);
  if (!identity) {
    return null;
  }

  const owner = await getOrderOwner(identity.userId);
  if (!owner) {
    return null;
  }

  if (owner.email.toLowerCase() !== identity.email.toLowerCase()) {
    return null;
  }

  return owner.id;
}

async function getGiftLinkByToken(token: string): Promise<GiftLinkRow | null> {
  const rows = await query<GiftLinkRow>(
    `
    SELECT *
    FROM gift_redemption_links
    WHERE token_hash = $1
    LIMIT 1
    `,
    [hashToken(token)]
  );
  return rows[0] ?? null;
}

async function markGiftLinkExpired(linkId: string): Promise<void> {
  await query(
    `
    UPDATE gift_redemption_links
    SET status = 'expired', updated_at = now()
    WHERE id = $1 AND status = 'pending'
    `,
    [linkId]
  );
}

async function getLatestGiftLink(orderId: string): Promise<GiftLinkRow | null> {
  const rows = await query<GiftLinkRow>(
    `
    SELECT *
    FROM gift_redemption_links
    WHERE order_id = $1
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [orderId]
  );
  return rows[0] ?? null;
}

async function getParentRetryUsage(orderId: string): Promise<number> {
  const rows = await query<RetryUsageRow>(
    `
    SELECT COUNT(*)::int AS used
    FROM order_retry_requests
    WHERE order_id = $1
      AND actor = 'parent'
      AND accepted = true
    `,
    [orderId]
  );

  return rows[0]?.used ?? 0;
}

async function recordRetryRequest(args: {
  orderId: string;
  actor: 'parent' | 'admin';
  requestedStatus: OrderStatus;
  accepted: boolean;
  reason?: string;
}): Promise<string> {
  const rows = await query<{ id: string }>(
    `
    INSERT INTO order_retry_requests (order_id, actor, requested_status, accepted, reason)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
    `,
    [args.orderId, args.actor, args.requestedStatus, args.accepted, args.reason ?? null]
  );

  return rows[0].id;
}

async function recordModerationCaseAction(args: {
  moderationJobId: string;
  orderId: string;
  action: ModerationCaseActionType;
  note: string;
  actor: string;
  previousOrderStatus: OrderStatus;
  resultingOrderStatus: OrderStatus;
  previousDecision: ModerationDecision;
  resultingDecision: ModerationDecision;
  retryRequestId?: string | null;
  retryJobId?: string | null;
}): Promise<ModerationCaseActionRow> {
  const rows = await query<ModerationCaseActionRow>(
    `
    INSERT INTO moderation_case_actions (
      moderation_job_id,
      order_id,
      action,
      note,
      actor,
      previous_order_status,
      resulting_order_status,
      previous_decision,
      resulting_decision,
      retry_request_id,
      retry_job_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING
      id,
      moderation_job_id,
      order_id,
      action,
      note,
      actor,
      previous_order_status,
      resulting_order_status,
      previous_decision,
      resulting_decision,
      retry_request_id,
      retry_job_id,
      created_at
    `,
    [
      args.moderationJobId,
      args.orderId,
      args.action,
      args.note,
      args.actor,
      args.previousOrderStatus,
      args.resultingOrderStatus,
      args.previousDecision,
      args.resultingDecision,
      args.retryRequestId ?? null,
      args.retryJobId ?? null
    ]
  );

  return rows[0];
}

async function recordEmailNotification(args: {
  orderId: string;
  recipientEmail: string;
  notificationType: 'delivery_ready' | 'render_failed' | 'gift_redeem_link';
  provider: string;
  providerMessageId: string | null;
  status: 'sent' | 'failed' | 'stub';
  subject: string;
  errorText: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  await query(
    `
    INSERT INTO email_notifications (
      order_id,
      recipient_email,
      notification_type,
      provider,
      provider_message_id,
      status,
      subject,
      error_text,
      payload_json
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    `,
    [
      args.orderId,
      args.recipientEmail,
      args.notificationType,
      args.provider,
      args.providerMessageId,
      args.status,
      args.subject,
      args.errorText,
      JSON.stringify(args.payload)
    ]
  );
}

function buildGiftLinkResponse(giftLink: GiftLinkRow) {
  return {
    id: giftLink.id,
    orderId: giftLink.order_id,
    recipientEmail: giftLink.recipient_email,
    senderName: giftLink.sender_name,
    giftMessage: giftLink.gift_message,
    status: giftLink.status,
    tokenHint: giftLink.token_hint,
    expiresAt: giftLink.expires_at,
    createdAt: giftLink.created_at
  };
}

function buildGiftEmailContent(args: {
  senderName: string | null;
  giftMessage: string | null;
  redemptionUrl: string;
}) {
  const subject = 'Your Little Legend gift is ready to redeem';
  const senderLine = args.senderName
    ? `${args.senderName} sent you a Little Legend gift.`
    : 'A Little Legend gift was sent to you.';
  const messageLine = args.giftMessage
    ? `Message: "${args.giftMessage}"`
    : 'Open the redemption link to claim your order.';
  const safeSenderLine = escapeHtml(senderLine);
  const safeMessageLine = escapeHtml(messageLine);

  return {
    subject,
    html: `
      <p>${safeSenderLine}</p>
      <p>${safeMessageLine}</p>
      <p><a href="${args.redemptionUrl}">Redeem gift</a></p>
      <p>If the button does not work, copy this URL into your browser:</p>
      <p>${args.redemptionUrl}</p>
    `,
    text: `${senderLine}\n${messageLine}\nRedeem gift: ${args.redemptionUrl}`
  };
}

async function deliverGiftLinkEmail(args: {
  orderId: string;
  giftLink: GiftLinkRow;
  redemptionUrl: string;
  source: 'create' | 'resend';
}): Promise<{
  status: 'sent' | 'failed' | 'stub';
  provider: 'resend' | 'stub';
  errorText: string | null;
}> {
  const message = buildGiftEmailContent({
    senderName: args.giftLink.sender_name,
    giftMessage: args.giftLink.gift_message,
    redemptionUrl: args.redemptionUrl
  });
  const sendResult = await sendTransactionalEmail({
    to: args.giftLink.recipient_email,
    subject: message.subject,
    html: message.html,
    text: message.text
  });

  await recordEmailNotification({
    orderId: args.orderId,
    recipientEmail: args.giftLink.recipient_email,
    notificationType: 'gift_redeem_link',
    provider: sendResult.provider,
    providerMessageId: sendResult.providerMessageId,
    status: sendResult.status,
    subject: message.subject,
    errorText: sendResult.errorText,
    payload: {
      giftLinkId: args.giftLink.id,
      tokenHint: args.giftLink.token_hint,
      source: args.source
    }
  });

  return {
    status: sendResult.status,
    provider: sendResult.provider,
    errorText: sendResult.errorText
  };
}

async function setOrderStatus(orderId: string, nextStatus: OrderStatus): Promise<OrderRow> {
  const order = await getOrder(orderId);
  if (!order) {
    throw new Error('Order not found');
  }

  assertOrderTransition(order.status, nextStatus);

  const rows = await query<OrderRow>(
    'UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [orderId, nextStatus]
  );

  return rows[0];
}

async function transitionOrderIfCurrent(
  orderId: string,
  allowedCurrentStatuses: OrderStatus[],
  nextStatus: OrderStatus
): Promise<OrderRow | null> {
  const rows = await query<OrderRow>(
    `
    UPDATE orders
    SET status = $2, updated_at = now()
    WHERE id = $1
      AND status = ANY($3::text[])
    RETURNING *
    `,
    [orderId, nextStatus, allowedCurrentStatuses]
  );

  return rows[0] ?? null;
}

async function claimPaymentIdempotencyKey(orderId: string, idempotencyKey: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `
    INSERT INTO payment_idempotency_keys (order_id, idempotency_key, status)
    VALUES ($1, $2, 'in_progress')
    ON CONFLICT (order_id, idempotency_key)
    DO NOTHING
    RETURNING id
    `,
    [orderId, idempotencyKey]
  );

  return Boolean(rows[0]?.id);
}

async function getPaymentIdempotencyKey(orderId: string, idempotencyKey: string): Promise<PaymentIdempotencyRow | null> {
  const rows = await query<PaymentIdempotencyRow>(
    `
    SELECT *
    FROM payment_idempotency_keys
    WHERE order_id = $1
      AND idempotency_key = $2
    LIMIT 1
    `,
    [orderId, idempotencyKey]
  );

  return rows[0] ?? null;
}

async function waitForPaymentIdempotencyResult(
  orderId: string,
  idempotencyKey: string,
  timeoutMs = 8000
): Promise<PaymentIdempotencyRow | null> {
  const started = Date.now();

  while (Date.now() - started <= timeoutMs) {
    const row = await getPaymentIdempotencyKey(orderId, idempotencyKey);
    if (!row) {
      return null;
    }

    if (row.status === 'completed' || row.status === 'failed') {
      return row;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return null;
}

async function completePaymentIdempotencyKey(
  orderId: string,
  idempotencyKey: string,
  response: Record<string, unknown>
): Promise<void> {
  await query(
    `
    UPDATE payment_idempotency_keys
    SET status = 'completed',
        response_json = $3::jsonb,
        error_text = NULL,
        updated_at = now()
    WHERE order_id = $1
      AND idempotency_key = $2
    `,
    [orderId, idempotencyKey, JSON.stringify(response)]
  );
}

async function failPaymentIdempotencyKey(orderId: string, idempotencyKey: string, errorText: string): Promise<void> {
  await query(
    `
    UPDATE payment_idempotency_keys
    SET status = 'failed',
        error_text = $3,
        updated_at = now()
    WHERE order_id = $1
      AND idempotency_key = $2
    `,
    [orderId, idempotencyKey, errorText]
  );
}

async function upsertStripeWebhookEvent(event: Stripe.Event): Promise<StripeWebhookEventRow> {
  const rows = await query<StripeWebhookEventRow>(
    `
    INSERT INTO stripe_webhook_events (event_id, event_type, status, delivery_count, payload_json)
    VALUES ($1, $2, 'processing', 1, $3::jsonb)
    ON CONFLICT (event_id)
    DO UPDATE
    SET event_type = EXCLUDED.event_type,
        payload_json = EXCLUDED.payload_json,
        delivery_count = stripe_webhook_events.delivery_count + 1,
        last_received_at = now()
    RETURNING *
    `,
    [event.id, event.type, JSON.stringify(event)]
  );

  return rows[0];
}

async function markStripeWebhookEventProcessed(eventId: string): Promise<void> {
  await query(
    `
    UPDATE stripe_webhook_events
    SET status = 'processed',
        last_error = NULL,
        processed_at = now(),
        last_received_at = now()
    WHERE event_id = $1
    `,
    [eventId]
  );
}

async function markStripeWebhookEventFailed(eventId: string, errorText: string): Promise<void> {
  await query(
    `
    UPDATE stripe_webhook_events
    SET status = 'failed',
        last_error = $2,
        last_received_at = now()
    WHERE event_id = $1
    `,
    [eventId, errorText]
  );
}

async function queueRenderOrder(args: {
  orderId: string;
  paymentIntentId: string;
  jobId: string;
  dedupeKey: string;
  source: RenderEnqueueSource;
}): Promise<QueueRenderResult> {
  const claim = await query<{ id: string }>(
    `
    INSERT INTO render_enqueue_dedupes (order_id, dedupe_key, job_id, payment_intent_id, source)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (order_id, dedupe_key)
    DO NOTHING
    RETURNING id
    `,
    [args.orderId, args.dedupeKey, args.jobId, args.paymentIntentId, args.source]
  );

  if (!claim[0]) {
    const existing = await query<RenderEnqueueDedupeRow>(
      `
      SELECT *
      FROM render_enqueue_dedupes
      WHERE order_id = $1
        AND dedupe_key = $2
      LIMIT 1
      `,
      [args.orderId, args.dedupeKey]
    );

    return {
      queued: false,
      deduped: true,
      jobId: existing[0]?.job_id ?? args.jobId,
      dedupeKey: args.dedupeKey
    };
  }

  try {
    await renderQueue.add(
      'render-order',
      {
        orderId: args.orderId,
        paymentIntentId: args.paymentIntentId
      },
      {
        jobId: args.jobId
      }
    );
  } catch (error) {
    await query(
      `
      DELETE FROM render_enqueue_dedupes
      WHERE order_id = $1
        AND dedupe_key = $2
      `,
      [args.orderId, args.dedupeKey]
    );
    throw error;
  }

  return {
    queued: true,
    deduped: false,
    jobId: args.jobId,
    dedupeKey: args.dedupeKey
  };
}

async function updatePaymentIntent(orderId: string, paymentIntentId: string | null): Promise<void> {
  if (!paymentIntentId) {
    return;
  }

  await query('UPDATE orders SET stripe_payment_intent_id = $2, updated_at = now() WHERE id = $1', [orderId, paymentIntentId]);
}

async function markPaidAndQueueIfEligible(orderId: string, paymentIntentId: string | null): Promise<void> {
  const order = await getOrder(orderId);
  if (!order) {
    return;
  }

  if (order.status === 'awaiting_script_approval') {
    await transitionOrderIfCurrent(orderId, ['awaiting_script_approval'], 'payment_pending');
  }

  const refreshed = await getOrder(orderId);
  if (!refreshed) {
    return;
  }

  if (postPaymentStatuses.has(refreshed.status)) {
    return;
  }

  if (refreshed.status !== 'payment_pending') {
    return;
  }

  const resolvedPaymentIntentId =
    paymentIntentId ?? refreshed.stripe_payment_intent_id ?? `pi_missing_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

  await updatePaymentIntent(orderId, resolvedPaymentIntentId);
  const paidOrder = await transitionOrderIfCurrent(orderId, ['payment_pending'], 'paid');
  const orderForQueue = paidOrder ?? (await getOrder(orderId));

  if (!orderForQueue || orderForQueue.status !== 'paid') {
    return;
  }

  await queueRenderOrder({
    orderId,
    paymentIntentId: orderForQueue.stripe_payment_intent_id ?? resolvedPaymentIntentId,
    jobId: `render-${orderId}-payment-${resolvedPaymentIntentId.slice(-12)}`,
    dedupeKey: `payment:${resolvedPaymentIntentId}`,
    source: 'payment_webhook'
  });
}

async function markPaymentPendingOrderAsCancelled(orderId: string): Promise<void> {
  await transitionOrderIfCurrent(orderId, ['payment_pending'], 'awaiting_script_approval');
}

function buildPreviewVideoBytes(args: {
  orderId: string;
  childName: string;
  themeName: string;
  version: number;
  totalDurationSec: number;
}): Buffer {
  const ftyp = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
  const note = Buffer.from(
    `preview-watermarked|order=${args.orderId}|child=${args.childName}|theme=${args.themeName}|version=${args.version}|duration=${args.totalDurationSec}`,
    'utf8'
  );
  return Buffer.concat([ftyp, note]);
}

async function createScriptPreviewArtifact(args: {
  order: OrderRow;
  version: number;
  childName: string;
  themeName: string;
  totalDurationSec: number;
}): Promise<{
  kind: 'preview_video';
  s3Key: string;
  meta: Record<string, unknown>;
}> {
  const s3Key = `${args.order.user_id}/${args.order.id}/preview/script-v${args.version}.mp4`;
  const bytes = buildPreviewVideoBytes({
    orderId: args.order.id,
    childName: args.childName,
    themeName: args.themeName,
    version: args.version,
    totalDurationSec: args.totalDurationSec
  });

  await writeAssetBytes(s3Key, bytes);
  const signedDownloadUrl = createSignedDownloadUrl(s3Key);
  const meta: Record<string, unknown> = {
    scriptVersion: args.version,
    watermarked: true,
    resolution: '720p',
    bytes: bytes.byteLength,
    signedDownloadUrl
  };

  await query(
    `
    INSERT INTO artifacts (order_id, kind, s3_key, meta_json)
    VALUES ($1, 'preview_video', $2, $3::jsonb)
    `,
    [args.order.id, s3Key, JSON.stringify(meta)]
  );

  return {
    kind: 'preview_video',
    s3Key,
    meta
  };
}

function normalizeContentType(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase();
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

async function readDeleteResponseText(response: Response): Promise<string> {
  const text = await response.text();
  return text.trim().slice(0, 300);
}

function createProviderDeleteResult(
  target: ProviderDeleteTarget,
  status: ProviderDeleteResult['status'],
  verification: ProviderDeleteVerification,
  detail: string
): ProviderDeleteResult {
  return {
    provider: target.provider,
    target: target.target,
    targetType: target.targetType,
    identifierSource: target.identifierSource,
    status,
    verification,
    detail
  };
}

async function deleteElevenLabsVoiceClone(target: ProviderDeleteTarget): Promise<ProviderDeleteResult> {
  if (target.target.startsWith('voice_')) {
    return createProviderDeleteResult(target, 'skipped', 'not_supported', 'Local/stub voice clone id.');
  }

  if (!env.ELEVENLABS_API_KEY) {
    return createProviderDeleteResult(target, 'skipped', 'not_supported', 'ELEVENLABS_API_KEY not configured.');
  }

  const endpoint = `${normalizeBaseUrl(env.ELEVENLABS_BASE_URL)}/v1/voices/${encodeURIComponent(target.target)}`;
  const response = await fetch(endpoint, {
    method: 'DELETE',
    headers: {
      'xi-api-key': env.ELEVENLABS_API_KEY
    }
  });

  if (response.ok || response.status === 404) {
    return createProviderDeleteResult(
      target,
      'deleted',
      response.status === 404 ? 'already_absent' : 'provider_confirmed',
      response.status === 404 ? 'Voice clone already absent at provider.' : 'Voice clone deleted.'
    );
  }

  return createProviderDeleteResult(
    target,
    'failed',
    'not_attempted',
    `HTTP ${response.status} ${await readDeleteResponseText(response)}`
  );
}

async function deleteHeyGenVideo(target: ProviderDeleteTarget): Promise<ProviderDeleteResult> {
  if (!env.HEYGEN_API_KEY) {
    return createProviderDeleteResult(target, 'skipped', 'not_supported', 'HEYGEN_API_KEY not configured.');
  }

  const base = normalizeBaseUrl(env.HEYGEN_BASE_URL);
  const attempts: Array<{ method: 'DELETE' | 'POST'; url: string; body?: Record<string, unknown> }> = [
    {
      method: 'DELETE',
      url: `${base}/v1/video.delete?video_id=${encodeURIComponent(target.target)}`
    },
    {
      method: 'DELETE',
      url: `${base}/v1/video.delete`,
      body: { video_id: target.target }
    },
    {
      method: 'POST',
      url: `${base}/v1/video.delete`,
      body: { video_id: target.target }
    }
  ];

  let lastFailure = 'Unknown provider delete failure.';
  for (const attempt of attempts) {
    const response = await fetch(attempt.url, {
      method: attempt.method,
      headers: {
        'X-Api-Key': env.HEYGEN_API_KEY,
        Authorization: `Bearer ${env.HEYGEN_API_KEY}`,
        ...(attempt.body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(attempt.body ? { body: JSON.stringify(attempt.body) } : {})
    });

    if (response.ok || response.status === 404) {
      return createProviderDeleteResult(
        target,
        'deleted',
        response.status === 404 ? 'already_absent' : 'provider_confirmed',
        response.status === 404 ? 'Video already absent at provider.' : 'Video deleted.'
      );
    }

    lastFailure = `HTTP ${response.status} ${await readDeleteResponseText(response)}`;
  }

  return createProviderDeleteResult(target, 'failed', 'not_attempted', lastFailure);
}

function collectShotstackAssetIds(payload: unknown): string[] {
  const ids = new Set<string>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    const maybeId = record.id;
    if (typeof maybeId === 'string' && maybeId.trim().length > 0) {
      ids.add(maybeId.trim());
    }

    for (const nested of Object.values(record)) {
      visit(nested);
    }
  };

  visit(payload);
  return Array.from(ids);
}

async function lookupShotstackAssetIds(renderId: string): Promise<string[]> {
  if (!env.SHOTSTACK_API_KEY) {
    return [];
  }

  const endpoint = `${normalizeBaseUrl(env.SHOTSTACK_BASE_URL)}/serve/${env.SHOTSTACK_STAGE}/assets/render/${encodeURIComponent(renderId)}`;
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'x-api-key': env.SHOTSTACK_API_KEY
    }
  });

  if (response.status === 404) {
    return [];
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${await readDeleteResponseText(response)}`);
  }

  const payload = (await response.json()) as unknown;
  return collectShotstackAssetIds(payload);
}

async function deleteShotstackHostedAsset(assetId: string): Promise<{
  status: ProviderDeleteResult['status'];
  verification: ProviderDeleteVerification;
  detail: string;
}> {
  if (!env.SHOTSTACK_API_KEY) {
    return {
      status: 'skipped',
      verification: 'not_supported',
      detail: 'SHOTSTACK_API_KEY not configured.'
    };
  }

  const endpoint = `${normalizeBaseUrl(env.SHOTSTACK_BASE_URL)}/serve/${env.SHOTSTACK_STAGE}/assets/${encodeURIComponent(assetId)}`;
  const response = await fetch(endpoint, {
    method: 'DELETE',
    headers: {
      'x-api-key': env.SHOTSTACK_API_KEY
    }
  });

  if (response.ok || response.status === 404) {
    return {
      status: 'deleted',
      verification: response.status === 404 ? 'already_absent' : 'provider_confirmed',
      detail: response.status === 404 ? 'Hosted asset already absent at provider.' : 'Hosted asset deleted.'
    };
  }

  return {
    status: 'failed',
    verification: 'not_attempted',
    detail: `HTTP ${response.status} ${await readDeleteResponseText(response)}`
  };
}

async function deleteShotstackRenderAssets(target: ProviderDeleteTarget): Promise<ProviderDeleteResult[]> {
  if (!env.SHOTSTACK_API_KEY) {
    return [createProviderDeleteResult(target, 'skipped', 'not_supported', 'SHOTSTACK_API_KEY not configured.')];
  }

  try {
    const assetIds = await lookupShotstackAssetIds(target.target);
    if (assetIds.length === 0) {
      return [createProviderDeleteResult(target, 'skipped', 'best_effort', 'No hosted Shotstack assets found for render.')];
    }

    const results: ProviderDeleteResult[] = [];
    for (const assetId of assetIds) {
      const hostedAssetDelete = await deleteShotstackHostedAsset(assetId);
      results.push({
        provider: 'shotstack',
        target: assetId,
        targetType: 'hosted_asset',
        identifierSource: 'provider_lookup',
        status: hostedAssetDelete.status,
        verification: hostedAssetDelete.verification,
        detail:
          hostedAssetDelete.status === 'deleted' && hostedAssetDelete.verification === 'provider_confirmed'
            ? `Deleted hosted asset from render ${target.target}.`
            : hostedAssetDelete.detail
      });
    }

    return results;
  } catch (error) {
    return [createProviderDeleteResult(target, 'failed', 'not_attempted', (error as Error).message)];
  }
}

function dedupeProviderDeleteTargets(targets: ProviderDeleteTarget[]): ProviderDeleteTarget[] {
  const byKey = new Map<string, ProviderDeleteTarget>();
  for (const target of targets) {
    const key = `${target.provider}:${target.targetType}:${target.target}`;
    if (!byKey.has(key)) {
      byKey.set(key, target);
    }
  }
  return Array.from(byKey.values());
}

async function discoverProviderDeleteTargets(orderId: string): Promise<ProviderDeleteTarget[]> {
  const [voiceCloneRows, providerTaskRows, artifactRows] = await Promise.all([
    query<ArtifactMetaRow>(
      `
      SELECT meta_json
      FROM artifacts
      WHERE order_id = $1
        AND kind = 'voice_clone_meta'
      `,
      [orderId]
    ),
    query<ProviderTaskCleanupRow>(
      `
      SELECT provider_task_id, provider, output_json
      FROM provider_tasks
      WHERE order_id = $1
      `,
      [orderId]
    ),
    query<{ kind: string; meta_json: Record<string, unknown> }>(
      `
      SELECT kind, meta_json
      FROM artifacts
      WHERE order_id = $1
        AND kind IN ('shot_video', 'final_video', 'thumbnail')
      `,
      [orderId]
    )
  ]);

  const targets: ProviderDeleteTarget[] = [];

  for (const row of voiceCloneRows) {
    const voiceCloneId = row.meta_json?.voiceCloneId;
    if (typeof voiceCloneId === 'string' && voiceCloneId.trim().length > 0) {
      targets.push({
        provider: 'elevenlabs',
        target: voiceCloneId.trim(),
        targetType: 'voice_clone',
        identifierSource: 'artifact_meta'
      });
    }
  }

  for (const task of providerTaskRows) {
    if (task.provider === 'heygen') {
      targets.push({
        provider: 'heygen',
        target: task.provider_task_id,
        targetType: 'video',
        identifierSource: 'provider_task'
      });
    } else if (task.provider === 'shotstack') {
      targets.push({
        provider: 'shotstack',
        target: task.provider_task_id,
        targetType: 'render',
        identifierSource: 'provider_task'
      });
    }
  }

  for (const row of artifactRows) {
    const providerTaskId = row.meta_json?.providerTaskId;
    if (typeof providerTaskId !== 'string' || providerTaskId.trim().length === 0) {
      continue;
    }

    targets.push({
      provider: row.kind === 'shot_video' ? 'heygen' : 'shotstack',
      target: providerTaskId.trim(),
      targetType: row.kind === 'shot_video' ? 'video' : 'render',
      identifierSource: 'artifact_meta'
    });
  }

  return dedupeProviderDeleteTargets(targets);
}

function summarizeProviderDeletion(targets: ProviderDeleteTarget[], results: ProviderDeleteResult[]): ProviderDeletionSummary {
  const providers = Array.from(new Set([...targets.map((target) => target.provider), ...results.map((result) => result.provider)]));

  return {
    discoveredTargetCount: targets.length,
    attempted: results.length,
    deleted: results.filter((result) => result.status === 'deleted').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    failed: results.filter((result) => result.status === 'failed').length,
    verified: results.filter((result) =>
      result.verification === 'provider_confirmed' || result.verification === 'already_absent'
    ).length,
    targets,
    byProvider: providers
      .map((provider) => ({
        provider,
        discoveredTargetCount: targets.filter((target) => target.provider === provider).length,
        attempted: results.filter((result) => result.provider === provider).length,
        deleted: results.filter((result) => result.provider === provider && result.status === 'deleted').length,
        skipped: results.filter((result) => result.provider === provider && result.status === 'skipped').length,
        failed: results.filter((result) => result.provider === provider && result.status === 'failed').length,
        verified: results.filter(
          (result) =>
            result.provider === provider &&
            (result.verification === 'provider_confirmed' || result.verification === 'already_absent')
        ).length
      }))
      .sort((left, right) => left.provider.localeCompare(right.provider)),
    results
  };
}

async function runProviderDeleteHooks(orderId: string): Promise<ProviderDeletionSummary> {
  const targets = await discoverProviderDeleteTargets(orderId);
  const results: ProviderDeleteResult[] = [];

  for (const target of targets) {
    if (target.provider === 'elevenlabs' && target.targetType === 'voice_clone') {
      results.push(await deleteElevenLabsVoiceClone(target));
    } else if (target.provider === 'heygen' && target.targetType === 'video') {
      results.push(await deleteHeyGenVideo(target));
    } else if (target.provider === 'shotstack' && target.targetType === 'render') {
      results.push(...(await deleteShotstackRenderAssets(target)));
    }
  }

  return summarizeProviderDeletion(targets, results);
}

async function deleteOrderAssociatedData(orderId: string): Promise<{
  deletedAssetCount: number;
  providerDeletion: ProviderDeletionSummary;
}> {
  const uploadRows = await query<AssetKeyRow>('SELECT s3_key FROM uploads WHERE order_id = $1', [orderId]);
  const artifactRows = await query<AssetKeyRow>('SELECT s3_key FROM artifacts WHERE order_id = $1', [orderId]);
  const providerDeletion = await runProviderDeleteHooks(orderId);

  const assetKeys = Array.from(new Set([...uploadRows, ...artifactRows].map((row) => row.s3_key)));
  await Promise.all(assetKeys.map((assetKey) => deleteAssetByKey(assetKey).catch(() => undefined)));

  await query('DELETE FROM uploads WHERE order_id = $1', [orderId]);
  await query('DELETE FROM artifacts WHERE order_id = $1', [orderId]);
  await query('DELETE FROM scripts WHERE order_id = $1', [orderId]);
  await query('DELETE FROM provider_tasks WHERE order_id = $1', [orderId]);
  await query('DELETE FROM jobs WHERE order_id = $1', [orderId]);

  return {
    deletedAssetCount: assetKeys.length,
    providerDeletion
  };
}

async function recordOrderDataPurgeEvent(input: {
  orderId: string;
  triggerSource: OrderDataPurgeTriggerSource;
  actor: 'parent' | 'admin' | null;
  previousOrderStatus: OrderStatus;
  resultingOrderStatus: OrderStatus;
  outcome: OrderDataPurgeOutcome;
  deletedAssetCount: number;
  providerDeletion?: ProviderDeletionSummary;
  retentionWindowDays: number | null;
  errorText: string | null;
}): Promise<void> {
  await query(
    `
    INSERT INTO order_data_purge_events (
      order_id,
      trigger_source,
      actor,
      previous_order_status,
      resulting_order_status,
      outcome,
      deleted_asset_count,
      provider_deletion_json,
      retention_window_days,
      error_text
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
    `,
    [
      input.orderId,
      input.triggerSource,
      input.actor,
      input.previousOrderStatus,
      input.resultingOrderStatus,
      input.outcome,
      input.deletedAssetCount,
      JSON.stringify(input.providerDeletion ?? {}),
      input.retentionWindowDays,
      input.errorText
    ]
  );
}

async function runOrderDataRetentionSweep(log: FastifyInstance['log']): Promise<void> {
  if (!env.ORDER_DATA_RETENTION_ENABLED) {
    return;
  }

  const candidateRows = await query<{ id: string; status: OrderStatus }>(
    `
    SELECT id, status
    FROM orders
    WHERE status IN ('delivered', 'refunded', 'expired')
      AND updated_at <= now() - make_interval(days => $1)
    ORDER BY updated_at ASC
    LIMIT $2
    `,
    [env.ORDER_DATA_RETENTION_DAYS, env.ORDER_DATA_RETENTION_SWEEP_LIMIT]
  );

  for (const row of candidateRows) {
    try {
      const cleanup = await deleteOrderAssociatedData(row.id);
      const resultingOrderStatus = row.status === 'delivered' ? 'expired' : row.status;
      if (row.status === 'delivered') {
        await query(`UPDATE orders SET status = 'expired', updated_at = now() WHERE id = $1`, [row.id]);
      } else {
        await query('UPDATE orders SET updated_at = now() WHERE id = $1', [row.id]);
      }

      await recordOrderDataPurgeEvent({
        orderId: row.id,
        triggerSource: 'retention_sweep',
        actor: null,
        previousOrderStatus: row.status,
        resultingOrderStatus,
        outcome: 'succeeded',
        deletedAssetCount: cleanup.deletedAssetCount,
        providerDeletion: cleanup.providerDeletion,
        retentionWindowDays: env.ORDER_DATA_RETENTION_DAYS,
        errorText: null
      });

      log.info(
        {
          orderId: row.id,
          previousStatus: row.status,
          resultingOrderStatus,
          deletedAssetCount: cleanup.deletedAssetCount,
          providerDeletion: cleanup.providerDeletion
        },
        'Order data retention sweep cleaned up order data'
      );
    } catch (error) {
      await recordOrderDataPurgeEvent({
        orderId: row.id,
        triggerSource: 'retention_sweep',
        actor: null,
        previousOrderStatus: row.status,
        resultingOrderStatus: row.status,
        outcome: 'failed',
        deletedAssetCount: 0,
        retentionWindowDays: env.ORDER_DATA_RETENTION_DAYS,
        errorText: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
      log.error({ err: error, orderId: row.id }, 'Order data retention sweep failed for order');
    }
  }
}

function isSupportedUploadType(kind: 'photo' | 'voice', contentType: string): boolean {
  const normalized = normalizeContentType(contentType);
  return kind === 'photo' ? photoContentTypes.has(normalized) : voiceContentTypes.has(normalized);
}

async function validateIntakeReadiness(order: OrderRow): Promise<string | null> {
  const consentRows = await query<{ id: string }>(
    `
    SELECT id
    FROM consents
    WHERE user_id = $1
    ORDER BY accepted_at DESC
    LIMIT 1
    `,
    [order.user_id]
  );

  if (!consentRows[0]) {
    return 'Parental consent is required before script generation.';
  }

  const uploadSummaryRows = await query<UploadKindSummaryRow>(
    `
    SELECT
      kind,
      COUNT(*)::int AS count,
      ARRAY_AGG(DISTINCT LOWER(SPLIT_PART(content_type, ';', 1))) AS normalized_content_types
    FROM uploads
    WHERE order_id = $1
    GROUP BY kind
    `,
    [order.id]
  );

  const photoSummary = uploadSummaryRows.find((row) => row.kind === 'photo');
  const voiceSummary = uploadSummaryRows.find((row) => row.kind === 'voice');

  const photoCount = photoSummary?.count ?? 0;
  if (photoCount < MIN_PHOTO_UPLOADS || photoCount > MAX_PHOTO_UPLOADS) {
    return `Order must contain ${MIN_PHOTO_UPLOADS}-${MAX_PHOTO_UPLOADS} photo uploads before script generation.`;
  }

  const voiceCount = voiceSummary?.count ?? 0;
  if (voiceCount !== REQUIRED_VOICE_UPLOADS) {
    return `Order must contain exactly ${REQUIRED_VOICE_UPLOADS} voice upload before script generation.`;
  }

  const hasUnsupportedPhotoType = (photoSummary?.normalized_content_types ?? []).some(
    (contentType) => !photoContentTypes.has(contentType)
  );
  if (hasUnsupportedPhotoType) {
    return 'Photo uploads must be JPEG or PNG.';
  }

  const hasUnsupportedVoiceType = (voiceSummary?.normalized_content_types ?? []).some(
    (contentType) => !voiceContentTypes.has(contentType)
  );
  if (hasUnsupportedVoiceType) {
    return 'Voice uploads must be WAV or M4A.';
  }

  return null;
}

function parseThemeManifest(value: unknown): ThemeManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('Theme manifest is missing.');
  }

  const manifest = value as ThemeManifest;
  if (!Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
    throw new Error('Theme manifest must include at least one scene.');
  }

  return manifest;
}

function buildScenePlan(args: { script: ScriptPayload; manifest: ThemeManifest }): ScenePlanEntry[] {
  const shots = [...args.script.shots].sort((a, b) => a.shotNumber - b.shotNumber);

  return shots.map((shot, index) => {
    const fallbackScene = args.manifest.scenes[index % args.manifest.scenes.length];
    const matchedScene = args.manifest.scenes.find((scene) => scene.id === shot.sceneId);
    const scene = matchedScene ?? fallbackScene;

    const sceneRenderSpec: SceneRenderSpec = {
      shotNumber: shot.shotNumber,
      sceneId: scene.id,
      sceneName: shot.sceneName || scene.name,
      sceneArchitecture: args.manifest.sceneArchitecture,
      camera: shot.camera || scene.cameraPreset,
      lighting: shot.lighting || scene.lightingPreset,
      environmentMotion:
        shot.overrides?.environmentMotion && shot.overrides.environmentMotion.length > 0
          ? shot.overrides.environmentMotion
          : shot.environmentMotion.length > 0
            ? shot.environmentMotion
            : scene.environmentMotionDefaults,
      soundBed: scene.soundBed,
      assets: scene.assets,
      anchors: scene.anchors,
      palette: scene.palette ?? args.manifest.palette ?? [],
      globalFx: scene.globalFx ?? args.manifest.globalFx ?? [],
      audio: scene.audio ?? { musicBed: null, sfx: [] },
      cameraMove: scene.cameraMove,
      parallaxStrength: scene.parallaxStrength,
      grade: scene.grade ?? { lut: scene.assets.lut },
      modelProfile: {
        avatarModel: shot.shotType === 'dialogue' ? 'avatar_speech_v1' : 'avatar_idle_v1',
        compositorModel: env.PROVIDER_INTEGRATION_MODE === 'stub' ? 'scene_parallax_compositor_v1_stub' : 'provider_scene_compositor_v1'
      }
    };

    return {
      shotNumber: shot.shotNumber,
      shotType: shot.shotType,
      durationSec: shot.durationSec,
      sceneFallbackUsed: !matchedScene,
      sceneRenderSpec
    };
  });
}

type ModerationDecision = 'pass' | 'manual_review' | 'reject' | 'unknown';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => (typeof entry === 'string' ? entry : String(entry))).filter((entry) => entry.length > 0);
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, typeof entry === 'string' ? entry : JSON.stringify(entry)])
  );
}

function toModerationDecision(value: unknown): ModerationDecision {
  if (value === 'pass' || value === 'manual_review' || value === 'reject') {
    return value;
  }

  return 'unknown';
}

function buildModerationSnapshot(source: {
  output: Record<string, unknown> | null;
  errorText: string | null;
  provider: string;
}): {
  provider: string;
  decision: ModerationDecision;
  checks: Record<string, string>;
  summary: string[];
  rejectReasons: string[];
  reviewReasons: string[];
  aggregateScores: Record<string, unknown>;
  modelProfile: Record<string, unknown>;
  thresholdProfile: Record<string, unknown>;
  evidence: Record<string, unknown>;
  details: Record<string, unknown>;
  localChecks: Record<string, unknown>;
  errorText: string | null;
} {
  const output = source.output ?? {};
  const providerChecks = asRecord(output.providerChecks) ?? output;
  const localChecks = asRecord(output.localChecks) ?? {};
  const evidence = asRecord(providerChecks.evidence) ?? {};
  const details = asRecord(providerChecks.details) ?? {};
  const decision = toModerationDecision(providerChecks.decision ?? output.decision);
  const aggregateScores = asRecord(evidence.aggregateScores) ?? asRecord(details.aggregateScores) ?? {};

  return {
    provider: source.provider,
    decision,
    checks: asStringRecord(providerChecks.checks),
    summary: asStringArray(providerChecks.summary),
    rejectReasons: asStringArray(evidence.rejectReasons),
    reviewReasons: asStringArray(evidence.reviewReasons),
    aggregateScores,
    modelProfile: asRecord(evidence.modelProfile) ?? {},
    thresholdProfile: asRecord(evidence.thresholdProfile) ?? {},
    evidence,
    details,
    localChecks,
    errorText: source.errorText
  };
}

async function buildParentRetryPolicy(order: OrderRow): Promise<{
  limit: number;
  used: number;
  remaining: number;
  canRetry: boolean;
  reason: string | null;
}> {
  const used = await getParentRetryUsage(order.id);
  const remaining = Math.max(0, env.PARENT_MAX_RETRY_REQUESTS - used);

  if (!parentRetryableStatuses.includes(order.status)) {
    return {
      limit: env.PARENT_MAX_RETRY_REQUESTS,
      used,
      remaining,
      canRetry: false,
      reason: `Order status ${order.status} is not retryable.`
    };
  }

  if (!order.stripe_payment_intent_id) {
    return {
      limit: env.PARENT_MAX_RETRY_REQUESTS,
      used,
      remaining,
      canRetry: false,
      reason: 'No captured payment intent is linked to this order.'
    };
  }

  if (remaining <= 0) {
    return {
      limit: env.PARENT_MAX_RETRY_REQUESTS,
      used,
      remaining,
      canRetry: false,
      reason: 'Parent retry limit reached for this order.'
    };
  }

  return {
    limit: env.PARENT_MAX_RETRY_REQUESTS,
    used,
    remaining,
    canRetry: true,
    reason: null
  };
}

async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: true,
    credentials: true
  });
  await app.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
    routes: ['/payments/stripe/webhook']
  });

  await seedThemes();
  await runOrderDataRetentionSweep(app.log);

  const retentionSweepTimer = env.ORDER_DATA_RETENTION_ENABLED
    ? setInterval(() => {
        void runOrderDataRetentionSweep(app.log);
      }, env.ORDER_DATA_RETENTION_SWEEP_INTERVAL_MS)
    : null;

  if (retentionSweepTimer) {
    retentionSweepTimer.unref();
    app.addHook('onClose', async () => {
      clearInterval(retentionSweepTimer);
    });
  }

  app.get('/health', async () => ({ ok: true }));
  registerAssetRoutes(app);
  registerProviderRoutes(app);

  app.post('/payments/stripe/webhook', async (request, reply) => {
    if (!canVerifyStripeWebhook()) {
      return reply.status(503).send({ message: 'Stripe webhook verification is not configured.' });
    }

    const signature = request.headers['stripe-signature'];
    if (!signature || Array.isArray(signature)) {
      return reply.status(400).send({ message: 'Missing stripe-signature header.' });
    }

    const rawBody = (request as unknown as { rawBody?: string }).rawBody;
    if (!rawBody) {
      return reply.status(400).send({ message: 'Missing raw request body for webhook verification.' });
    }

    let event: Stripe.Event;
    try {
      event = constructStripeWebhookEvent(rawBody, signature);
    } catch (error) {
      return reply.status(400).send({ message: `Webhook signature verification failed: ${(error as Error).message}` });
    }

    const trackedEvent = await upsertStripeWebhookEvent(event);
    if (trackedEvent.status === 'processed') {
      return reply.send({
        received: true,
        deduped: true,
        eventId: event.id,
        deliveryCount: trackedEvent.delivery_count
      });
    }

    if (trackedEvent.status === 'processing' && trackedEvent.delivery_count > 1) {
      return reply.status(202).send({
        received: true,
        deduped: true,
        inProgress: true,
        eventId: event.id,
        deliveryCount: trackedEvent.delivery_count
      });
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        const orderId = session.metadata?.orderId ?? session.client_reference_id ?? null;
        const paymentIntentId =
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : (session.payment_intent?.id ?? null);

        if (orderId) {
          await markPaidAndQueueIfEligible(orderId, paymentIntentId);
        }
      } else if (event.type === 'checkout.session.expired') {
        const session = event.data.object as Stripe.Checkout.Session;
        const orderId = session.metadata?.orderId ?? session.client_reference_id ?? null;
        if (orderId) {
          await markPaymentPendingOrderAsCancelled(orderId);
        }
      } else if (event.type === 'payment_intent.payment_failed') {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const orderId = paymentIntent.metadata?.orderId ?? null;
        if (orderId) {
          await updatePaymentIntent(orderId, paymentIntent.id);
          await markPaymentPendingOrderAsCancelled(orderId);
        }
      }
      await markStripeWebhookEventProcessed(event.id);
    } catch (error) {
      await markStripeWebhookEventFailed(event.id, (error as Error).message);
      request.log.error({ err: error, eventId: event.id, eventType: event.type }, 'Stripe webhook processing failed');
      return reply.status(500).send({ message: 'Webhook processing failed' });
    }

    return reply.send({
      received: true,
      eventId: event.id,
      deliveryCount: trackedEvent.delivery_count
    });
  });

  app.post('/users/upsert', async (request, reply) => {
    const payload = createUserSchema.parse(request.body);

    const rows = await query<UserRow>(
      `
      INSERT INTO users (email)
      VALUES ($1)
      ON CONFLICT (email)
      DO UPDATE SET email = EXCLUDED.email
      RETURNING *
      `,
      [payload.email.toLowerCase()]
    );

    const user = rows[0];
    const parentAccessToken = createParentAccessToken({
      userId: user.id,
      email: user.email
    });
    reply.header('Set-Cookie', buildParentAccessTokenSetCookie(parentAccessToken));

    return reply.send({
      ...user,
      parentAccessToken
    });
  });

  app.post('/orders/:orderId/consent', async (request, reply) => {
    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const payload = consentSchema.parse(request.body);

    const order = await getOrder(params.orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }

    if (order.user_id !== payload.userId) {
      return reply.status(403).send({ message: 'Consent user mismatch' });
    }

    const hasUserAccess = await assertParentOwnsUserId(request, payload.userId);
    if (!hasUserAccess) {
      return reply.status(401).send({ message: 'Unauthorized parent request.' });
    }

    const rows = await query(
      `
      INSERT INTO consents (user_id, version, accepted_at, ip, user_agent)
      VALUES ($1, $2, now(), $3::inet, $4)
      RETURNING *
      `,
      [payload.userId, payload.version, payload.ip ?? null, payload.userAgent ?? null]
    );

    return reply.send(rows[0]);
  });

  app.get('/themes', async () => {
    const rows = await query<ThemeRow>(
      `
      SELECT *
      FROM themes
      WHERE is_active = true
      ORDER BY name ASC
      `
    );

    return rows;
  });

  app.post('/child-director/preview-sessions', async (request, reply) => {
    const payload = childDirectorPreviewSessionCreateSchema.parse(request.body ?? {});
    const parentUserId = await resolveVerifiedParentUserId(request);

    const rows = await query<ChildDirectorPreviewSessionRow>(
      `
      INSERT INTO child_director_preview_sessions (
        session_id,
        parent_user_id,
        age_group,
        release_track,
        preview_json,
        parent_approval_json
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
      ON CONFLICT (session_id)
      DO UPDATE SET
        parent_user_id = COALESCE(EXCLUDED.parent_user_id, child_director_preview_sessions.parent_user_id),
        age_group = EXCLUDED.age_group,
        release_track = EXCLUDED.release_track,
        preview_json = EXCLUDED.preview_json,
        parent_approval_json = EXCLUDED.parent_approval_json,
        updated_at = now()
      RETURNING *
      `,
      [
        payload.sessionId,
        parentUserId,
        payload.ageGroup,
        payload.releaseTrack,
        JSON.stringify(payload.preview),
        JSON.stringify(payload.parentApprovalRequests)
      ]
    );

    const session = rows[0];
    if (!session) {
      return reply.status(500).send({ message: 'Failed to persist child-director preview session.' });
    }

    const parentApprovalRequests = Array.isArray(session.parent_approval_json) ? session.parent_approval_json : [];

    return reply.send({
      id: session.id,
      sessionId: session.session_id,
      parentLinked: Boolean(session.parent_user_id),
      ageGroup: session.age_group,
      releaseTrack: session.release_track,
      preview: session.preview_json,
      parentApprovalRequests,
      createdAt: session.created_at,
      updatedAt: session.updated_at
    });
  });

  app.get('/child-director/preview-sessions/:sessionId', async (request, reply) => {
    const params = childDirectorPreviewSessionParamsSchema.parse(request.params ?? {});

    const rows = await query<ChildDirectorPreviewSessionRow>(
      `
      SELECT *
      FROM child_director_preview_sessions
      WHERE session_id = $1
      LIMIT 1
      `,
      [params.sessionId]
    );

    const session = rows[0];
    if (!session) {
      return reply.status(404).send({ message: 'Preview session not found.' });
    }

    if (session.parent_user_id) {
      const hasAccess = await assertParentOwnsUserId(request, session.parent_user_id);
      if (!hasAccess) {
        return reply.status(401).send({ message: 'Unauthorized parent request.' });
      }
    }

    const parentApprovalRequests = Array.isArray(session.parent_approval_json) ? session.parent_approval_json : [];

    return reply.send({
      id: session.id,
      sessionId: session.session_id,
      parentLinked: Boolean(session.parent_user_id),
      ageGroup: session.age_group,
      releaseTrack: session.release_track,
      preview: session.preview_json,
      parentApprovalRequests,
      createdAt: session.created_at,
      updatedAt: session.updated_at
    });
  });

  app.post('/orders', async (request, reply) => {
    const payload = createOrderSchema.parse(request.body);

    const hasUserAccess = await assertParentOwnsUserId(request, payload.userId);
    if (!hasUserAccess) {
      return reply.status(401).send({ message: 'Unauthorized parent request.' });
    }

    const themeRows = await query<ThemeRow>('SELECT * FROM themes WHERE slug = $1 AND is_active = true', [
      payload.themeSlug
    ]);

    const theme = themeRows[0];
    if (!theme) {
      return reply.status(404).send({ message: 'Theme not found' });
    }

    const rows = await query<OrderRow>(
      `
      INSERT INTO orders (user_id, theme_id, status, currency, amount_cents)
      VALUES ($1, $2, 'draft', $3, $4)
      RETURNING *
      `,
      [payload.userId, theme.id, payload.currency.toLowerCase(), LAUNCH_PRICE_CENTS]
    );

    return reply.status(201).send(rows[0]);
  });

  app.post('/orders/:orderId/uploads/sign', async (request, reply) => {
    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const payload = uploadSignSchema.parse(request.body);

    const order = await getOrder(params.orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }

    const hasOrderAccess = await assertParentOwnsOrder(request, order);
    if (!hasOrderAccess) {
      return reply.status(401).send({ message: 'Unauthorized parent request.' });
    }

    if (!['draft', 'needs_user_fix', 'awaiting_script_approval'].includes(order.status)) {
      return reply.status(409).send({ message: `Cannot add uploads for order in status ${order.status}` });
    }

    if (!isSupportedUploadType(payload.kind, payload.contentType)) {
      const expectedTypeMessage =
        payload.kind === 'photo' ? 'Photo uploads must be JPEG/PNG.' : 'Voice uploads must be WAV/M4A.';
      return reply.status(400).send({ message: expectedTypeMessage });
    }

    if (payload.bytes > env.ASSET_MAX_UPLOAD_BYTES) {
      return reply.status(400).send({
        message: `Upload exceeds max allowed size of ${env.ASSET_MAX_UPLOAD_BYTES} bytes.`
      });
    }

    const [uploadCountRow] = await query<UploadCountRow>(
      'SELECT COUNT(*)::int AS count FROM uploads WHERE order_id = $1 AND kind = $2',
      [params.orderId, payload.kind]
    );
    const existingCount = uploadCountRow?.count ?? 0;

    if (payload.kind === 'photo' && existingCount >= MAX_PHOTO_UPLOADS) {
      return reply
        .status(400)
        .send({ message: `A maximum of ${MAX_PHOTO_UPLOADS} photo uploads is allowed per order.` });
    }

    if (payload.kind === 'voice' && existingCount >= REQUIRED_VOICE_UPLOADS) {
      return reply.status(400).send({ message: 'Only one voice upload is allowed per order.' });
    }

    const normalizedContentType = normalizeContentType(payload.contentType);
    const uploadId = randomUUID();
    const s3Key = `${order.user_id}/${params.orderId}/${payload.kind}/${uploadId}`;

    await query(
      `
      INSERT INTO uploads (id, order_id, kind, s3_key, content_type, bytes, sha256)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [uploadId, params.orderId, payload.kind, s3Key, normalizedContentType, payload.bytes, payload.sha256 ?? null]
    );

    const signedUploadUrl = createSignedUploadUrl(s3Key);

    return reply.send({
      uploadId,
      s3Key,
      signedUploadUrl,
      expiresInSec: env.ASSET_UPLOAD_URL_TTL_SEC
    });
  });

  app.post('/orders/:orderId/script/generate', async (request, reply) => {
    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const payload = generateScriptSchema.parse(request.body);

    const order = await getOrder(params.orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }

    const hasOrderAccess = await assertParentOwnsOrder(request, order);
    if (!hasOrderAccess) {
      return reply.status(401).send({ message: 'Unauthorized parent request.' });
    }

    if (!['draft', 'needs_user_fix', 'awaiting_script_approval', 'script_regenerate'].includes(order.status)) {
      return reply.status(409).send({ message: `Cannot generate script for order in status ${order.status}` });
    }

    let activeOrder = order;
    if (order.status === 'draft' || order.status === 'needs_user_fix') {
      activeOrder = await setOrderStatus(params.orderId, 'intake_validating');
    } else if (order.status === 'awaiting_script_approval') {
      activeOrder = await setOrderStatus(params.orderId, 'script_regenerate');
    }

    const intakeError = await validateIntakeReadiness(activeOrder);
    if (intakeError) {
      if (activeOrder.status === 'intake_validating') {
        await setOrderStatus(params.orderId, 'needs_user_fix');
      } else if (activeOrder.status === 'script_regenerate') {
        await setOrderStatus(params.orderId, 'awaiting_script_approval');
      }
      return reply.status(400).send({ message: intakeError });
    }

    const [theme] = await query<ThemeRow>('SELECT * FROM themes WHERE id = $1', [activeOrder.theme_id]);
    if (!theme) {
      return reply.status(404).send({ message: 'Theme not found for order' });
    }

    const script = generateScript({
      childName: payload.childName,
      themeName: theme.name,
      keywords: payload.keywords,
      templateManifest: theme.template_manifest_json
    });

    const [versionRow] = await query<{ next_version: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM scripts WHERE order_id = $1',
      [params.orderId]
    );

    const version = versionRow.next_version;
    if (version > MAX_SCRIPT_VERSIONS_PER_ORDER) {
      if (activeOrder.status === 'intake_validating' || activeOrder.status === 'script_regenerate') {
        await setOrderStatus(params.orderId, 'awaiting_script_approval');
      }
      return reply.status(429).send({
        message: `Script regenerate limit reached (${MAX_SCRIPT_VERSIONS_PER_ORDER} per order).`
      });
    }

    const [scriptRow] = await query(
      `
      INSERT INTO scripts (order_id, version, script_json)
      VALUES ($1, $2, $3::jsonb)
      RETURNING *
      `,
      [params.orderId, version, JSON.stringify(script)]
    );

    if (activeOrder.status === 'intake_validating' || activeOrder.status === 'script_regenerate') {
      await setOrderStatus(params.orderId, 'awaiting_script_approval');
    }

    const previewArtifact = await createScriptPreviewArtifact({
      order: activeOrder,
      version,
      childName: payload.childName,
      themeName: theme.name,
      totalDurationSec: script.totalDurationSec
    });

    return reply.send({
      ...scriptRow,
      previewArtifact
    });
  });

  app.post('/orders/:orderId/script/approve', async (request, reply) => {
    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const payload = approveScriptSchema.parse(request.body);

    const order = await getOrder(params.orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }

    const hasOrderAccess = await assertParentOwnsOrder(request, order);
    if (!hasOrderAccess) {
      return reply.status(401).send({ message: 'Unauthorized parent request.' });
    }

    if (!['awaiting_script_approval', 'script_regenerate', 'payment_pending'].includes(order.status)) {
      return reply.status(409).send({ message: `Cannot approve script for order in status ${order.status}` });
    }

    const rows = await query(
      `
      UPDATE scripts
      SET approved_at = now()
      WHERE order_id = $1 AND version = $2
      RETURNING *
      `,
      [params.orderId, payload.version]
    );

    const approved = rows[0];
    if (!approved) {
      return reply.status(404).send({ message: 'Script version not found' });
    }

    let updatedOrder = order;
    if (updatedOrder.status === 'script_regenerate') {
      updatedOrder = await setOrderStatus(params.orderId, 'awaiting_script_approval');
    }
    if (updatedOrder.status === 'awaiting_script_approval') {
      updatedOrder = await setOrderStatus(params.orderId, 'payment_pending');
    }

    return reply.send({
      ...approved,
      orderStatus: updatedOrder.status
    });
  });

  app.post('/orders/:orderId/pay', async (request, reply) => {
    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);

    const order = await getOrder(params.orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }

    const hasOrderAccess = await assertParentOwnsOrder(request, order);
    if (!hasOrderAccess) {
      return reply.status(401).send({ message: 'Unauthorized parent request.' });
    }

    const approvedRows = await query<{ id: string }>(
      'SELECT id FROM scripts WHERE order_id = $1 AND approved_at IS NOT NULL ORDER BY version DESC LIMIT 1',
      [params.orderId]
    );

    if (!approvedRows[0]) {
      return reply.status(400).send({ message: 'Script must be approved before payment' });
    }

    let payableOrder = order;
    if (payableOrder.status === 'awaiting_script_approval') {
      const transitioned = await transitionOrderIfCurrent(params.orderId, ['awaiting_script_approval'], 'payment_pending');
      payableOrder = transitioned ?? (await getOrder(params.orderId)) ?? payableOrder;
    }

    if (postPaymentStatuses.has(payableOrder.status) && payableOrder.stripe_payment_intent_id) {
      const replayResponse = {
        order: payableOrder,
        paymentIntentId: payableOrder.stripe_payment_intent_id,
        provider: payableOrder.stripe_payment_intent_id.startsWith('pi_dev_') ? 'stripe_stub' : 'stripe',
        idempotentReplay: true
      };
      return reply.send(replayResponse);
    }

    if (payableOrder.status !== 'payment_pending' || postPaymentStatuses.has(payableOrder.status)) {
      return reply.status(409).send({ message: `Cannot pay order in status ${payableOrder.status}` });
    }

    const idempotencyKey = extractIdempotencyKey(request, `pay:${params.orderId}`);
    const claimed = await claimPaymentIdempotencyKey(params.orderId, idempotencyKey);
    if (!claimed) {
      const existing = await waitForPaymentIdempotencyResult(params.orderId, idempotencyKey);
      if (existing?.status === 'completed' && existing.response_json) {
        return reply.send(existing.response_json);
      }

      if (existing?.status === 'failed') {
        return reply.status(409).send({
          message: existing.error_text ?? 'Payment request failed for this idempotency key.',
          idempotencyKey
        });
      }

      return reply.status(409).send({
        message: 'Payment request already in progress for this idempotency key.',
        idempotencyKey
      });
    }

    try {
      if (isStripePaymentsEnabled()) {
        const [user] = await query<Pick<UserRow, 'email'>>('SELECT email FROM users WHERE id = $1', [order.user_id]);

        const checkoutSession = await createCheckoutSession({
          orderId: params.orderId,
          amountCents: payableOrder.amount_cents,
          currency: payableOrder.currency,
          parentEmail: user?.email,
          idempotencyKey
        });

        if (!checkoutSession.url) {
          await failPaymentIdempotencyKey(params.orderId, idempotencyKey, 'Stripe Checkout session did not return a URL.');
          return reply.status(500).send({ message: 'Stripe Checkout session did not return a URL.' });
        }

        const stripeResponse = {
          order: payableOrder,
          provider: 'stripe',
          checkoutSessionId: checkoutSession.id,
          checkoutUrl: checkoutSession.url,
          idempotencyKey
        };
        await completePaymentIdempotencyKey(params.orderId, idempotencyKey, stripeResponse);
        return reply.send(stripeResponse);
      }

      const paymentIntentId = payableOrder.stripe_payment_intent_id ?? `pi_dev_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
      await updatePaymentIntent(params.orderId, paymentIntentId);

      const paidOrder =
        (await transitionOrderIfCurrent(params.orderId, ['payment_pending'], 'paid')) ?? (await getOrder(params.orderId));
      if (!paidOrder || !postPaymentStatuses.has(paidOrder.status)) {
        throw new Error(`Order ${params.orderId} did not reach a post-payment status after payment attempt.`);
      }

      if (paidOrder.status === 'paid') {
        await queueRenderOrder({
          orderId: params.orderId,
          paymentIntentId,
          jobId: `render-${params.orderId}-payment-${paymentIntentId.slice(-12)}`,
          dedupeKey: `payment:${paymentIntentId}`,
          source: 'payment_stub'
        });
      }

      const stubResponse = {
        order: paidOrder,
        paymentIntentId,
        provider: 'stripe_stub',
        idempotencyKey
      };
      await completePaymentIdempotencyKey(params.orderId, idempotencyKey, stubResponse);
      return reply.send(stubResponse);
    } catch (error) {
      await failPaymentIdempotencyKey(params.orderId, idempotencyKey, (error as Error).message);
      throw error;
    }
  });

  app.post('/orders/:orderId/retry', async (request, reply) => {
    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const payload = parentRetrySchema.parse(request.body ?? {});

    const order = await getOrder(params.orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }

    const hasOrderAccess = await assertParentOwnsOrder(request, order);
    if (!hasOrderAccess) {
      return reply.status(401).send({ message: 'Unauthorized parent request.' });
    }

    if (!parentRetryableStatuses.includes(order.status)) {
      await recordRetryRequest({
        orderId: params.orderId,
        actor: 'parent',
        requestedStatus: order.status,
        accepted: false,
        reason: payload.reason
      });

      return reply.status(409).send({
        message: `Order in status ${order.status} cannot be retried. Allowed statuses: ${parentRetryableStatuses.join(', ')}.`
      });
    }

    if (!order.stripe_payment_intent_id) {
      await recordRetryRequest({
        orderId: params.orderId,
        actor: 'parent',
        requestedStatus: order.status,
        accepted: false,
        reason: payload.reason
      });

      return reply.status(409).send({
        message: 'Cannot retry order without a captured payment intent.'
      });
    }

    const parentRetryUsed = await getParentRetryUsage(params.orderId);
    if (parentRetryUsed >= env.PARENT_MAX_RETRY_REQUESTS) {
      await recordRetryRequest({
        orderId: params.orderId,
        actor: 'parent',
        requestedStatus: order.status,
        accepted: false,
        reason: payload.reason
      });

      return reply.status(429).send({
        message: `Retry limit reached (${env.PARENT_MAX_RETRY_REQUESTS} parent retries per order).`,
        parentRetryUsed,
        parentRetryLimit: env.PARENT_MAX_RETRY_REQUESTS
      });
    }

    let updatedOrder = order;
    if (order.status === 'failed_hard' || order.status === 'manual_review') {
      updatedOrder = await setOrderStatus(params.orderId, 'failed_soft');
    }

    const retryRequestId = await recordRetryRequest({
      orderId: params.orderId,
      actor: 'parent',
      requestedStatus: order.status,
      accepted: true,
      reason: payload.reason
    });
    const retryJobId = `render-${params.orderId}-parent-retry-${retryRequestId}`;
    const queueResult = await queueRenderOrder({
      orderId: params.orderId,
      paymentIntentId: order.stripe_payment_intent_id,
      jobId: retryJobId,
      dedupeKey: `retry:${retryRequestId}`,
      source: 'parent_retry'
    });

    const nextUsed = parentRetryUsed + 1;
    return reply.send({
      queued: queueResult.queued,
      deduped: queueResult.deduped,
      orderId: params.orderId,
      fromStatus: order.status,
      currentStatus: updatedOrder.status,
      retryJobId,
      paymentIntentId: order.stripe_payment_intent_id,
      reason: payload.reason ?? null,
      parentRetryUsed: nextUsed,
      parentRetryLimit: env.PARENT_MAX_RETRY_REQUESTS,
      parentRetryRemaining: Math.max(0, env.PARENT_MAX_RETRY_REQUESTS - nextUsed)
    });
  });

  app.post('/admin/orders/:orderId/retry', async (request, reply) => {
    if (!hasAdminAccess(request)) {
      return reply.status(401).send({ message: 'Unauthorized admin request.' });
    }

    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const payload = adminRetrySchema.parse(request.body ?? {});

    const order = await getOrder(params.orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }

    if (!parentRetryableStatuses.includes(order.status)) {
      await recordRetryRequest({
        orderId: params.orderId,
        actor: 'admin',
        requestedStatus: order.status,
        accepted: false,
        reason: payload.reason
      });

      return reply.status(409).send({
        message: `Order in status ${order.status} cannot be retried. Allowed statuses: ${parentRetryableStatuses.join(', ')}.`
      });
    }

    if (!order.stripe_payment_intent_id) {
      await recordRetryRequest({
        orderId: params.orderId,
        actor: 'admin',
        requestedStatus: order.status,
        accepted: false,
        reason: payload.reason
      });

      return reply.status(409).send({
        message: 'Cannot retry order without a captured payment intent.'
      });
    }

    let updatedOrder = order;
    if (order.status === 'failed_hard' || order.status === 'manual_review') {
      updatedOrder = await setOrderStatus(params.orderId, 'failed_soft');
    }

    const retryRequestId = await recordRetryRequest({
      orderId: params.orderId,
      actor: 'admin',
      requestedStatus: order.status,
      accepted: true,
      reason: payload.reason
    });
    const retryJobId = `render-${params.orderId}-admin-retry-${retryRequestId}`;
    const queueResult = await queueRenderOrder({
      orderId: params.orderId,
      paymentIntentId: order.stripe_payment_intent_id,
      jobId: retryJobId,
      dedupeKey: `retry:${retryRequestId}`,
      source: 'admin_retry'
    });

    return reply.send({
      queued: queueResult.queued,
      deduped: queueResult.deduped,
      orderId: params.orderId,
      fromStatus: order.status,
      currentStatus: updatedOrder.status,
      retryJobId,
      paymentIntentId: order.stripe_payment_intent_id,
      reason: payload.reason ?? null
    });
  });

  app.get('/admin/email-notifications/failures', async (request, reply) => {
    if (!hasAdminAccess(request)) {
      return reply.status(401).send({ message: 'Unauthorized admin request.' });
    }

    const queryParams = adminEmailFailuresQuerySchema.parse(request.query ?? {});
    const orderIdFilter = queryParams.orderId ?? null;
    const notificationTypeFilter = queryParams.notificationType ?? null;

    const [failures, totalCountRows, countsByTypeRows, countsByProviderRows] = await Promise.all([
      query<EmailNotificationFailureRow>(
        `
        SELECT
          en.id,
          en.order_id,
          o.status AS order_status,
          u.email AS parent_email,
          en.recipient_email,
          en.notification_type,
          en.provider,
          en.provider_message_id,
          en.subject,
          en.error_text,
          en.payload_json,
          en.created_at
        FROM email_notifications en
        INNER JOIN orders o ON o.id = en.order_id
        INNER JOIN users u ON u.id = o.user_id
        WHERE en.status = 'failed'
          AND ($1::uuid IS NULL OR en.order_id = $1)
          AND ($2::text IS NULL OR en.notification_type = $2)
        ORDER BY en.created_at DESC
        LIMIT $3
        `,
        [orderIdFilter, notificationTypeFilter, queryParams.limit]
      ),
      query<{ count: number }>(
        `
        SELECT COUNT(*)::int AS count
        FROM email_notifications en
        WHERE en.status = 'failed'
          AND ($1::uuid IS NULL OR en.order_id = $1)
          AND ($2::text IS NULL OR en.notification_type = $2)
        `,
        [orderIdFilter, notificationTypeFilter]
      ),
      query<EmailFailureCountRow>(
        `
        SELECT en.notification_type AS key, COUNT(*)::int AS count
        FROM email_notifications en
        WHERE en.status = 'failed'
          AND ($1::uuid IS NULL OR en.order_id = $1)
          AND ($2::text IS NULL OR en.notification_type = $2)
        GROUP BY en.notification_type
        ORDER BY COUNT(*) DESC, en.notification_type ASC
        `,
        [orderIdFilter, notificationTypeFilter]
      ),
      query<EmailFailureCountRow>(
        `
        SELECT en.provider AS key, COUNT(*)::int AS count
        FROM email_notifications en
        WHERE en.status = 'failed'
          AND ($1::uuid IS NULL OR en.order_id = $1)
          AND ($2::text IS NULL OR en.notification_type = $2)
        GROUP BY en.provider
        ORDER BY COUNT(*) DESC, en.provider ASC
        `,
        [orderIdFilter, notificationTypeFilter]
      )
    ]);

    return reply.send({
      filters: {
        orderId: orderIdFilter,
        notificationType: notificationTypeFilter,
        limit: queryParams.limit
      },
      summary: {
        totalFailed: totalCountRows[0]?.count ?? 0,
        byType: countsByTypeRows.map((row) => ({
          notificationType: row.key,
          count: row.count
        })),
        byProvider: countsByProviderRows.map((row) => ({
          provider: row.key,
          count: row.count
        }))
      },
      failures: failures.map((row) => ({
        id: row.id,
        orderId: row.order_id,
        orderStatus: row.order_status,
        parentEmail: row.parent_email,
        recipientEmail: row.recipient_email,
        notificationType: row.notification_type,
        provider: row.provider,
        providerMessageId: row.provider_message_id,
        subject: row.subject,
        errorText: row.error_text,
        payload: row.payload_json,
        createdAt: row.created_at
      }))
    });
  });

  app.get('/admin/retry-requests', async (request, reply) => {
    if (!hasAdminAccess(request)) {
      return reply.status(401).send({ message: 'Unauthorized admin request.' });
    }

    const queryParams = adminRetryHistoryQuerySchema.parse(request.query ?? {});
    const orderIdFilter = queryParams.orderId ?? null;
    const actorFilter = queryParams.actor ?? null;
    const acceptedFilter = typeof queryParams.accepted === 'boolean' ? queryParams.accepted : null;

    const [historyRows, totalCountRows, actorCountsRows, outcomeCountsRows] = await Promise.all([
      query<RetryHistoryRow>(
        `
        SELECT
          rr.id,
          rr.order_id,
          o.status AS current_order_status,
          u.email AS parent_email,
          rr.actor,
          rr.requested_status,
          rr.accepted,
          rr.reason,
          rr.created_at
        FROM order_retry_requests rr
        INNER JOIN orders o ON o.id = rr.order_id
        INNER JOIN users u ON u.id = o.user_id
        WHERE ($1::uuid IS NULL OR rr.order_id = $1)
          AND ($2::text IS NULL OR rr.actor = $2)
          AND ($3::boolean IS NULL OR rr.accepted = $3)
        ORDER BY rr.created_at DESC
        LIMIT $4
        `,
        [orderIdFilter, actorFilter, acceptedFilter, queryParams.limit]
      ),
      query<{ count: number }>(
        `
        SELECT COUNT(*)::int AS count
        FROM order_retry_requests rr
        WHERE ($1::uuid IS NULL OR rr.order_id = $1)
          AND ($2::text IS NULL OR rr.actor = $2)
          AND ($3::boolean IS NULL OR rr.accepted = $3)
        `,
        [orderIdFilter, actorFilter, acceptedFilter]
      ),
      query<{ actor: 'parent' | 'admin'; count: number }>(
        `
        SELECT rr.actor, COUNT(*)::int AS count
        FROM order_retry_requests rr
        WHERE ($1::uuid IS NULL OR rr.order_id = $1)
          AND ($2::text IS NULL OR rr.actor = $2)
          AND ($3::boolean IS NULL OR rr.accepted = $3)
        GROUP BY rr.actor
        ORDER BY COUNT(*) DESC, rr.actor ASC
        `,
        [orderIdFilter, actorFilter, acceptedFilter]
      ),
      query<{ accepted: boolean; count: number }>(
        `
        SELECT rr.accepted, COUNT(*)::int AS count
        FROM order_retry_requests rr
        WHERE ($1::uuid IS NULL OR rr.order_id = $1)
          AND ($2::text IS NULL OR rr.actor = $2)
          AND ($3::boolean IS NULL OR rr.accepted = $3)
        GROUP BY rr.accepted
        ORDER BY rr.accepted DESC
        `,
        [orderIdFilter, actorFilter, acceptedFilter]
      )
    ]);

    return reply.send({
      filters: {
        orderId: orderIdFilter,
        actor: actorFilter,
        accepted: acceptedFilter,
        limit: queryParams.limit
      },
      summary: {
        totalRequests: totalCountRows[0]?.count ?? 0,
        actorBreakdown: actorCountsRows.map((row) => ({
          actor: row.actor,
          count: row.count
        })),
        outcomeBreakdown: outcomeCountsRows.map((row) => ({
          accepted: row.accepted,
          count: row.count
        }))
      },
      retryRequests: historyRows.map((row) => ({
        id: row.id,
        orderId: row.order_id,
        currentOrderStatus: row.current_order_status,
        parentEmail: row.parent_email,
        actor: row.actor,
        requestedStatus: row.requested_status,
        accepted: row.accepted,
        reason: row.reason,
        createdAt: row.created_at
      }))
    });
  });

  app.get('/admin/moderation-reviews', async (request, reply) => {
    if (!hasAdminAccess(request)) {
      return reply.status(401).send({ message: 'Unauthorized admin request.' });
    }

    const queryParams = adminModerationReviewsQuerySchema.parse(request.query ?? {});
    const orderIdFilter = queryParams.orderId ?? null;
    const stepStatusFilter = queryParams.stepStatus ?? null;
    const decisionFilter = queryParams.decision ?? null;
    const fetchLimit = decisionFilter ? Math.min(queryParams.limit * 4, 400) : queryParams.limit;

    const rows = await query<ModerationReviewRow>(
      `
      SELECT
        j.id,
        j.order_id,
        o.status AS order_status,
        u.email AS parent_email,
        j.status,
        j.provider,
        j.attempt,
        j.output_json,
        j.error_text,
        j.started_at,
        j.finished_at,
        j.created_at
      FROM jobs j
      INNER JOIN orders o ON o.id = j.order_id
      INNER JOIN users u ON u.id = o.user_id
      WHERE j.type = 'moderation'
        AND ($1::uuid IS NULL OR j.order_id = $1)
        AND ($2::text IS NULL OR j.status = $2)
      ORDER BY j.started_at DESC NULLS LAST, j.finished_at DESC NULLS LAST, j.created_at DESC
      LIMIT $3
      `,
      [orderIdFilter, stepStatusFilter, fetchLimit]
    );

    const mappedReviews = rows.map((row) => {
      const moderation = buildModerationSnapshot({
        output: row.output_json,
        errorText: row.error_text,
        provider: row.provider
      });

      return {
        id: row.id,
        orderId: row.order_id,
        orderStatus: row.order_status,
        parentEmail: row.parent_email,
        stepStatus: row.status,
        attempt: row.attempt,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        createdAt: row.created_at,
        ...moderation
      };
    });

    const filteredReviews =
      decisionFilter && decisionFilter !== 'unknown'
        ? mappedReviews.filter((review) => review.decision === decisionFilter)
        : decisionFilter === 'unknown'
          ? mappedReviews.filter((review) => review.decision === 'unknown')
          : mappedReviews;
    const reviewsWithoutActions = filteredReviews.slice(0, queryParams.limit);
    const reviewIds = reviewsWithoutActions.map((review) => review.id);
    const caseActionRows =
      reviewIds.length > 0
        ? await query<ModerationCaseActionRow>(
            `
            SELECT
              id,
              moderation_job_id,
              order_id,
              action,
              note,
              actor,
              previous_order_status,
              resulting_order_status,
              previous_decision,
              resulting_decision,
              retry_request_id,
              retry_job_id,
              created_at
            FROM moderation_case_actions
            WHERE moderation_job_id = ANY($1::uuid[])
            ORDER BY created_at DESC
            `,
            [reviewIds]
          )
        : [];

    const actionsByReview = new Map<string, ModerationCaseActionRow[]>();
    for (const actionRow of caseActionRows) {
      const existing = actionsByReview.get(actionRow.moderation_job_id) ?? [];
      existing.push(actionRow);
      actionsByReview.set(actionRow.moderation_job_id, existing);
    }

    const reviews = reviewsWithoutActions.map((review) => ({
      ...review,
      caseActions: (actionsByReview.get(review.id) ?? []).map((actionRow) => ({
        id: actionRow.id,
        action: actionRow.action,
        note: actionRow.note,
        actor: actionRow.actor,
        previousOrderStatus: actionRow.previous_order_status,
        resultingOrderStatus: actionRow.resulting_order_status,
        previousDecision: actionRow.previous_decision,
        resultingDecision: actionRow.resulting_decision,
        retryRequestId: actionRow.retry_request_id,
        retryJobId: actionRow.retry_job_id,
        createdAt: actionRow.created_at
      }))
    }));

    const decisionBreakdownMap = new Map<ModerationDecision, number>();
    const stepStatusBreakdownMap = new Map<'queued' | 'running' | 'succeeded' | 'failed', number>();
    const caseActionBreakdownMap = new Map<ModerationCaseActionType, number>();
    for (const review of reviews) {
      decisionBreakdownMap.set(review.decision, (decisionBreakdownMap.get(review.decision) ?? 0) + 1);
      stepStatusBreakdownMap.set(review.stepStatus, (stepStatusBreakdownMap.get(review.stepStatus) ?? 0) + 1);
      for (const caseAction of review.caseActions) {
        caseActionBreakdownMap.set(caseAction.action, (caseActionBreakdownMap.get(caseAction.action) ?? 0) + 1);
      }
    }

    return reply.send({
      filters: {
        orderId: orderIdFilter,
        stepStatus: stepStatusFilter,
        decision: decisionFilter,
        limit: queryParams.limit
      },
      summary: {
        totalReviews: reviews.length,
        decisionBreakdown: Array.from(decisionBreakdownMap.entries()).map(([decision, count]) => ({
          decision,
          count
        })),
        stepStatusBreakdown: Array.from(stepStatusBreakdownMap.entries()).map(([stepStatus, count]) => ({
          stepStatus,
          count
        })),
        caseActionBreakdown: Array.from(caseActionBreakdownMap.entries()).map(([action, count]) => ({
          action,
          count
        }))
      },
      reviews
    });
  });

  app.post('/admin/moderation-reviews/:reviewId/actions', async (request, reply) => {
    if (!hasAdminAccess(request)) {
      return reply.status(401).send({ message: 'Unauthorized admin request.' });
    }

    const params = z.object({ reviewId: z.string().uuid() }).parse(request.params);
    const payload = adminModerationCaseActionSchema.parse(request.body ?? {});
    const actor = resolveAdminActor(request);

    const moderationRows = await query<ModerationJobRow>(
      `
      SELECT
        id,
        order_id,
        status,
        provider,
        attempt,
        output_json,
        error_text,
        started_at,
        finished_at,
        created_at
      FROM jobs
      WHERE id = $1
        AND type = 'moderation'
      LIMIT 1
      `,
      [params.reviewId]
    );
    const moderationJob = moderationRows[0] ?? null;
    if (!moderationJob) {
      return reply.status(404).send({ message: 'Moderation review record not found.' });
    }

    const order = await getOrder(moderationJob.order_id);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found for moderation review.' });
    }

    const moderationSnapshot = buildModerationSnapshot({
      output: moderationJob.output_json,
      errorText: moderationJob.error_text,
      provider: moderationJob.provider
    });

    const previousOrderStatus = order.status;
    const previousDecision = moderationSnapshot.decision;
    let resultingOrderStatus = order.status;
    let resultingDecision: ModerationDecision = payload.action === 'approve' ? 'pass' : 'reject';
    let retryRequestId: string | null = null;
    let retryJobId: string | null = null;
    let queueResult: QueueRenderResult | null = null;

    if (payload.action === 'approve') {
      if (!['manual_review', 'failed_hard', 'failed_soft'].includes(order.status)) {
        return reply.status(409).send({
          message:
            `Cannot approve override for order in status ${order.status}. ` +
            'Allowed statuses: manual_review, failed_hard, failed_soft.'
        });
      }

      if (order.status === 'manual_review' || order.status === 'failed_hard') {
        const updatedOrder = await setOrderStatus(order.id, 'failed_soft');
        resultingOrderStatus = updatedOrder.status;
      }

      if (payload.queueRetry) {
        if (!order.stripe_payment_intent_id) {
          return reply.status(409).send({ message: 'Cannot queue retry because payment intent is missing.' });
        }

        retryRequestId = await recordRetryRequest({
          orderId: order.id,
          actor: 'admin',
          requestedStatus: previousOrderStatus,
          accepted: true,
          reason: `Moderation approve override: ${payload.note}`
        });

        retryJobId = `render-${order.id}-moderation-approve-${retryRequestId}`;
        queueResult = await queueRenderOrder({
          orderId: order.id,
          paymentIntentId: order.stripe_payment_intent_id,
          jobId: retryJobId,
          dedupeKey: `moderation-approve:${retryRequestId}`,
          source: 'admin_moderation_override'
        });
      }
    } else {
      if (!['manual_review', 'failed_hard', 'failed_soft'].includes(order.status)) {
        return reply.status(409).send({
          message:
            `Cannot reject override for order in status ${order.status}. ` +
            'Allowed statuses: manual_review, failed_hard, failed_soft.'
        });
      }

      if (order.status === 'failed_soft') {
        const updatedOrder = await setOrderStatus(order.id, 'failed_hard');
        resultingOrderStatus = updatedOrder.status;
      }
    }

    const actionType: ModerationCaseActionType =
      payload.action === 'approve' ? 'approve_override' : 'reject_override';
    const caseAction = await recordModerationCaseAction({
      moderationJobId: moderationJob.id,
      orderId: order.id,
      action: actionType,
      note: payload.note,
      actor,
      previousOrderStatus,
      resultingOrderStatus,
      previousDecision,
      resultingDecision,
      retryRequestId,
      retryJobId
    });

    return reply.send({
      action: {
        id: caseAction.id,
        moderationJobId: caseAction.moderation_job_id,
        orderId: caseAction.order_id,
        action: caseAction.action,
        note: caseAction.note,
        actor: caseAction.actor,
        previousOrderStatus: caseAction.previous_order_status,
        resultingOrderStatus: caseAction.resulting_order_status,
        previousDecision: caseAction.previous_decision,
        resultingDecision: caseAction.resulting_decision,
        retryRequestId: caseAction.retry_request_id,
        retryJobId: caseAction.retry_job_id,
        createdAt: caseAction.created_at
      },
      queue: queueResult
        ? {
            queued: queueResult.queued,
            deduped: queueResult.deduped,
            jobId: queueResult.jobId
          }
        : null
    });
  });

  app.get('/admin/order-data-purges', async (request, reply) => {
    if (!hasAdminAccess(request)) {
      return reply.status(401).send({ message: 'Unauthorized admin request.' });
    }

    const queryParams = adminOrderDataPurgeHistoryQuerySchema.parse(request.query ?? {});
    const orderIdFilter = queryParams.orderId ?? null;
    const triggerSourceFilter = queryParams.triggerSource ?? null;
    const outcomeFilter = queryParams.outcome ?? null;

    const [eventRows, totalCountRows, triggerCountsRows, outcomeCountsRows, deletedAssetCountRows] = await Promise.all([
      query<OrderDataPurgeEventRow>(
        `
        SELECT
          e.id,
          e.order_id,
          u.email AS parent_email,
          e.trigger_source,
          e.actor,
          e.previous_order_status,
          e.resulting_order_status,
          e.outcome,
          e.deleted_asset_count,
          e.provider_deletion_json,
          e.retention_window_days,
          e.error_text,
          e.created_at
        FROM order_data_purge_events e
        INNER JOIN orders o ON o.id = e.order_id
        INNER JOIN users u ON u.id = o.user_id
        WHERE ($1::uuid IS NULL OR e.order_id = $1)
          AND ($2::text IS NULL OR e.trigger_source = $2)
          AND ($3::text IS NULL OR e.outcome = $3)
        ORDER BY e.created_at DESC
        LIMIT $4
        `,
        [orderIdFilter, triggerSourceFilter, outcomeFilter, queryParams.limit]
      ),
      query<{ count: number }>(
        `
        SELECT COUNT(*)::int AS count
        FROM order_data_purge_events e
        WHERE ($1::uuid IS NULL OR e.order_id = $1)
          AND ($2::text IS NULL OR e.trigger_source = $2)
          AND ($3::text IS NULL OR e.outcome = $3)
        `,
        [orderIdFilter, triggerSourceFilter, outcomeFilter]
      ),
      query<{ trigger_source: OrderDataPurgeTriggerSource; count: number }>(
        `
        SELECT e.trigger_source, COUNT(*)::int AS count
        FROM order_data_purge_events e
        WHERE ($1::uuid IS NULL OR e.order_id = $1)
          AND ($2::text IS NULL OR e.trigger_source = $2)
          AND ($3::text IS NULL OR e.outcome = $3)
        GROUP BY e.trigger_source
        ORDER BY COUNT(*) DESC, e.trigger_source ASC
        `,
        [orderIdFilter, triggerSourceFilter, outcomeFilter]
      ),
      query<{ outcome: OrderDataPurgeOutcome; count: number }>(
        `
        SELECT e.outcome, COUNT(*)::int AS count
        FROM order_data_purge_events e
        WHERE ($1::uuid IS NULL OR e.order_id = $1)
          AND ($2::text IS NULL OR e.trigger_source = $2)
          AND ($3::text IS NULL OR e.outcome = $3)
        GROUP BY e.outcome
        ORDER BY e.outcome ASC
        `,
        [orderIdFilter, triggerSourceFilter, outcomeFilter]
      ),
      query<{ deleted_asset_count: number }>(
        `
        SELECT COALESCE(SUM(e.deleted_asset_count), 0)::int AS deleted_asset_count
        FROM order_data_purge_events e
        WHERE ($1::uuid IS NULL OR e.order_id = $1)
          AND ($2::text IS NULL OR e.trigger_source = $2)
          AND ($3::text IS NULL OR e.outcome = $3)
        `,
        [orderIdFilter, triggerSourceFilter, outcomeFilter]
      )
    ]);

    return reply.send({
      retention: {
        enabled: env.ORDER_DATA_RETENTION_ENABLED,
        windowDays: env.ORDER_DATA_RETENTION_DAYS,
        intervalMs: env.ORDER_DATA_RETENTION_SWEEP_INTERVAL_MS,
        batchLimit: env.ORDER_DATA_RETENTION_SWEEP_LIMIT
      },
      filters: {
        orderId: orderIdFilter,
        triggerSource: triggerSourceFilter,
        outcome: outcomeFilter,
        limit: queryParams.limit
      },
      summary: {
        totalEvents: totalCountRows[0]?.count ?? 0,
        totalDeletedAssets: deletedAssetCountRows[0]?.deleted_asset_count ?? 0,
        triggerBreakdown: triggerCountsRows.map((row) => ({
          triggerSource: row.trigger_source,
          count: row.count
        })),
        outcomeBreakdown: outcomeCountsRows.map((row) => ({
          outcome: row.outcome,
          count: row.count
        }))
      },
      purgeEvents: eventRows.map((row) => ({
        id: row.id,
        orderId: row.order_id,
        parentEmail: row.parent_email,
        triggerSource: row.trigger_source,
        actor: row.actor,
        previousOrderStatus: row.previous_order_status,
        resultingOrderStatus: row.resulting_order_status,
        outcome: row.outcome,
        deletedAssetCount: row.deleted_asset_count,
        providerDeletion: row.provider_deletion_json,
        retentionWindowDays: row.retention_window_days,
        errorText: row.error_text,
        createdAt: row.created_at
      }))
    });
  });

  app.get('/admin/queue/render/dead-letter', async (request, reply) => {
    if (!hasAdminAccess(request)) {
      return reply.status(401).send({ message: 'Unauthorized admin request.' });
    }

    const queryParams = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(25)
      })
      .parse(request.query ?? {});

    const failedJobs = await renderQueue.getFailed(0, queryParams.limit - 1);
    const [failedCount, waitingCount, activeCount, delayedCount] = await Promise.all([
      renderQueue.getJobCountByTypes('failed'),
      renderQueue.getJobCountByTypes('waiting'),
      renderQueue.getJobCountByTypes('active'),
      renderQueue.getJobCountByTypes('delayed')
    ]);

    const recentFailedSteps = await query<{
      order_id: string;
      type: string;
      attempt: number;
      provider: string;
      error_text: string | null;
      finished_at: string | null;
    }>(
      `
      SELECT order_id, type, attempt, provider, error_text, finished_at
      FROM jobs
      WHERE status = 'failed'
      ORDER BY finished_at DESC NULLS LAST
      LIMIT $1
      `,
      [queryParams.limit]
    );

    return reply.send({
      queue: {
        name: 'render-orders',
        failedCount,
        waitingCount,
        activeCount,
        delayedCount
      },
      failedJobs: failedJobs.map((job) => ({
        jobId: job.id,
        name: job.name,
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? 1,
        failedReason: job.failedReason,
        data: job.data,
        timestamp: job.timestamp,
        processedOn: job.processedOn ?? null,
        finishedOn: job.finishedOn ?? null
      })),
      recentFailedSteps
    });
  });

  app.post('/admin/queue/render/dead-letter/:jobId/retry', async (request, reply) => {
    if (!hasAdminAccess(request)) {
      return reply.status(401).send({ message: 'Unauthorized admin request.' });
    }

    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    const job = await renderQueue.getJob(params.jobId);
    if (!job) {
      return reply.status(404).send({ message: 'Queue job not found.' });
    }

    const state = await job.getState();
    if (state !== 'failed') {
      return reply.status(409).send({ message: `Queue job is in state ${state}; only failed jobs can be retried.` });
    }

    await job.retry();
    return reply.send({
      queued: true,
      jobId: params.jobId,
      previousState: state
    });
  });

  app.post('/orders/:orderId/gift-link', async (request, reply) => {
    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const payload = giftLinkCreateSchema.parse(request.body ?? {});

    const order = await getOrder(params.orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }

    const hasOrderAccess = await assertParentOwnsOrder(request, order);
    if (!hasOrderAccess) {
      return reply.status(401).send({ message: 'Unauthorized parent request.' });
    }

    if (order.status === 'refunded' || order.status === 'expired') {
      return reply.status(409).send({ message: `Cannot create gift links for order in status ${order.status}.` });
    }

    const normalizedRecipientEmail = payload.recipientEmail.toLowerCase();
    const giftToken = createGiftToken();
    const tokenHash = hashToken(giftToken);
    const tokenHint = buildGiftTokenHint(giftToken);
    const expiresInDays = payload.expiresInDays ?? env.GIFT_REDEMPTION_TTL_DAYS;

    await query(
      `
      UPDATE gift_redemption_links
      SET status = 'revoked',
          updated_at = now()
      WHERE order_id = $1
        AND status = 'pending'
      `,
      [params.orderId]
    );

    const insertedRows = await query<GiftLinkRow>(
      `
      INSERT INTO gift_redemption_links (
        order_id,
        recipient_email,
        sender_name,
        gift_message,
        token_hash,
        token_encrypted,
        token_hint,
        status,
        expires_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        'pending',
        now() + ($8::text || ' days')::interval
      )
      RETURNING *
      `,
      [
        params.orderId,
        normalizedRecipientEmail,
        payload.senderName ?? null,
        payload.giftMessage ?? null,
        tokenHash,
        encryptGiftToken(giftToken),
        tokenHint,
        String(expiresInDays)
      ]
    );

    const giftLink = insertedRows[0];
    if (!giftLink) {
      return reply.status(500).send({ message: 'Failed to create gift redemption link.' });
    }
    const redemptionUrl = buildGiftRedemptionUrl(giftToken);
    let emailDelivery: {
      status: 'sent' | 'failed' | 'stub' | 'skipped';
      provider: 'resend' | 'stub' | 'none';
      errorText: string | null;
    } = {
      status: 'skipped',
      provider: 'none',
      errorText: null
    };

    if (payload.sendEmail) {
      emailDelivery = await deliverGiftLinkEmail({
        orderId: params.orderId,
        giftLink,
        redemptionUrl,
        source: 'create'
      });
    }

    return reply.send({
      giftLink: buildGiftLinkResponse(giftLink),
      redemptionUrl,
      emailDelivery
    });
  });

  app.post('/orders/:orderId/gift-link/resend', async (request, reply) => {
    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);

    const order = await getOrder(params.orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }

    const hasOrderAccess = await assertParentOwnsOrder(request, order);
    if (!hasOrderAccess) {
      return reply.status(401).send({ message: 'Unauthorized parent request.' });
    }

    const latestGiftLink = await getLatestGiftLink(params.orderId);
    if (!latestGiftLink) {
      return reply.status(404).send({ message: 'No gift link exists for this order yet.' });
    }

    if (latestGiftLink.status === 'pending' && isGiftLinkExpired(latestGiftLink)) {
      await markGiftLinkExpired(latestGiftLink.id);
      latestGiftLink.status = 'expired';
    }

    if (latestGiftLink.status !== 'pending') {
      return reply
        .status(409)
        .send({ message: `Cannot resend email for gift link in status ${latestGiftLink.status}.` });
    }

    if (!latestGiftLink.token_encrypted) {
      return reply.status(409).send({
        message: 'This gift link predates resend support. Create a new gift redemption link to email it again.'
      });
    }

    const giftToken = decryptGiftToken(latestGiftLink.token_encrypted);
    if (!giftToken) {
      return reply.status(500).send({ message: 'Gift redemption token could not be restored for resend.' });
    }

    const redemptionUrl = buildGiftRedemptionUrl(giftToken);
    const emailDelivery = await deliverGiftLinkEmail({
      orderId: params.orderId,
      giftLink: latestGiftLink,
      redemptionUrl,
      source: 'resend'
    });

    return reply.send({
      giftLink: buildGiftLinkResponse(latestGiftLink),
      redemptionUrl,
      emailDelivery
    });
  });

  app.post('/orders/:orderId/gift-link/revoke', async (request, reply) => {
    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);

    const order = await getOrder(params.orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }

    const hasOrderAccess = await assertParentOwnsOrder(request, order);
    if (!hasOrderAccess) {
      return reply.status(401).send({ message: 'Unauthorized parent request.' });
    }

    const latestGiftLink = await getLatestGiftLink(params.orderId);
    if (!latestGiftLink) {
      return reply.status(404).send({ message: 'No gift link exists for this order yet.' });
    }

    if (latestGiftLink.status === 'pending' && isGiftLinkExpired(latestGiftLink)) {
      await markGiftLinkExpired(latestGiftLink.id);
      latestGiftLink.status = 'expired';
    }

    if (latestGiftLink.status !== 'pending') {
      return reply
        .status(409)
        .send({ message: `Cannot revoke gift link in status ${latestGiftLink.status}.` });
    }

    const revokedRows = await query<GiftLinkRow>(
      `
      UPDATE gift_redemption_links
      SET status = 'revoked',
          updated_at = now()
      WHERE id = $1
        AND status = 'pending'
      RETURNING *
      `,
      [latestGiftLink.id]
    );
    const revokedLink = revokedRows[0];
    if (!revokedLink) {
      return reply.status(409).send({ message: 'Gift link could not be revoked because it is no longer pending.' });
    }

    return reply.send({
      giftLink: buildGiftLinkResponse(revokedLink),
      revoked: true
    });
  });

  app.get('/gift/redeem/:token', async (request, reply) => {
    const params = giftRedeemParamsSchema.parse(request.params);
    const link = await getGiftLinkByToken(params.token);
    if (!link) {
      return reply.status(404).send({ message: 'Gift redemption link not found.' });
    }

    if (link.status === 'pending' && isGiftLinkExpired(link)) {
      await markGiftLinkExpired(link.id);
      return reply.status(410).send({ message: 'Gift redemption link has expired.' });
    }

    if (link.status !== 'pending') {
      return reply.status(410).send({ message: 'Gift redemption link is unavailable.' });
    }

    const orderRows = await query<GiftRedeemOrderRow>(
      `
      SELECT
        o.id,
        o.status,
        t.name AS theme_name
      FROM orders o
      JOIN themes t ON t.id = o.theme_id
      WHERE o.id = $1
      LIMIT 1
      `,
      [link.order_id]
    );
    const order = orderRows[0];
    if (!order) {
      return reply.status(404).send({ message: 'Gift order not found.' });
    }

    return reply.send({
      giftLink: {
        id: link.id,
        orderId: link.order_id,
        recipientEmail: link.recipient_email,
        senderName: link.sender_name,
        giftMessage: link.gift_message,
        status: link.status,
        tokenHint: link.token_hint,
        expiresAt: link.expires_at,
        redeemedAt: link.redeemed_at,
        createdAt: link.created_at
      },
      order: {
        id: order.id,
        status: order.status,
        themeName: order.theme_name
      }
    });
  });

  app.post('/gift/redeem/:token', async (request, reply) => {
    const params = giftRedeemParamsSchema.parse(request.params);
    const payload = giftRedeemSchema.parse(request.body ?? {});
    const normalizedParentEmail = payload.parentEmail.toLowerCase();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const linkRows = await client.query<GiftLinkRow>(
        `
        SELECT *
        FROM gift_redemption_links
        WHERE token_hash = $1
        LIMIT 1
        FOR UPDATE
        `,
        [hashToken(params.token)]
      );
      const link = linkRows.rows[0];
      if (!link) {
        await client.query('ROLLBACK');
        return reply.status(404).send({ message: 'Gift redemption link not found.' });
      }

      if (link.status === 'pending' && isGiftLinkExpired(link)) {
        await client.query(
          `
          UPDATE gift_redemption_links
          SET status = 'expired', updated_at = now()
          WHERE id = $1 AND status = 'pending'
          `,
          [link.id]
        );
        await client.query('COMMIT');
        return reply.status(410).send({ message: 'Gift redemption link has expired.' });
      }

      if (link.status !== 'pending') {
        await client.query('ROLLBACK');
        return reply.status(409).send({
          message: `Gift redemption link cannot be redeemed in status ${link.status}.`
        });
      }

      if (normalizedParentEmail !== link.recipient_email.toLowerCase()) {
        await client.query('ROLLBACK');
        return reply.status(403).send({ message: 'Gift redemption email does not match recipient email.' });
      }

      const userRows = await client.query<UserRow>(
        `
        INSERT INTO users (email)
        VALUES ($1)
        ON CONFLICT (email)
        DO UPDATE SET email = EXCLUDED.email
        RETURNING *
        `,
        [normalizedParentEmail]
      );
      const user = userRows.rows[0];

      await client.query(
        `
        UPDATE orders
        SET user_id = $2,
            updated_at = now()
        WHERE id = $1
        `,
        [link.order_id, user.id]
      );

      const updatedLinkRows = await client.query<GiftLinkRow>(
        `
        UPDATE gift_redemption_links
        SET status = 'redeemed',
            redeemed_by_user_id = $2,
            redeemed_at = now(),
            updated_at = now()
        WHERE id = $1
          AND status = 'pending'
        RETURNING *
        `,
        [link.id, user.id]
      );
      const updatedLink = updatedLinkRows.rows[0];
      if (!updatedLink) {
        throw new Error('Gift redemption update failed.');
      }

      await client.query('COMMIT');
      const parentAccessToken = createParentAccessToken({
        userId: user.id,
        email: user.email
      });
      reply.header('Set-Cookie', buildParentAccessTokenSetCookie(parentAccessToken));

      return reply.send({
        redeemed: true,
        orderId: link.order_id,
        userId: user.id,
        parentEmail: user.email,
        parentAccessToken,
        giftLink: {
          id: updatedLink.id,
          status: updatedLink.status,
          redeemedAt: updatedLink.redeemed_at
        },
        orderStatusUrl: `${env.WEB_APP_BASE_URL}/orders/${link.order_id}`
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/orders/:orderId/status', async (request, reply) => {
    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);

    const order = await getOrder(params.orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }

    const hasOrderAccess = await assertParentOwnsOrder(request, order);
    if (!hasOrderAccess) {
      return reply.status(401).send({ message: 'Unauthorized parent request.' });
    }

    const latestScriptRows = await query<LatestScriptRow>(
      `
      SELECT *
      FROM scripts
      WHERE order_id = $1
      ORDER BY version DESC
      LIMIT 1
      `,
      [params.orderId]
    );
    const latestScript = latestScriptRows[0] ?? null;

    let scenePlanThemeName: string | null = null;
    let scenePlan: ScenePlanEntry[] = [];
    let scenePlanError: string | null = null;

    if (latestScript) {
      const themeRows = await query<Pick<ThemeRow, 'name' | 'template_manifest_json'>>(
        `
        SELECT name, template_manifest_json
        FROM themes
        WHERE id = $1
        LIMIT 1
        `,
        [order.theme_id]
      );

      const theme = themeRows[0];
      if (!theme) {
        scenePlanError = 'Theme not found for order.';
      } else {
        scenePlanThemeName = theme.name;
        try {
          scenePlan = buildScenePlan({
            script: latestScript.script_json,
            manifest: parseThemeManifest(theme.template_manifest_json)
          });
        } catch (error) {
          scenePlanError = (error as Error).message;
        }
      }
    }

    const jobRows = await query<OrderJobStatusRow>(
      `
      SELECT
        id,
        type,
        status,
        provider,
        attempt,
        input_json,
        output_json,
        error_text,
        started_at,
        finished_at,
        created_at
      FROM jobs
      WHERE order_id = $1
      ORDER BY started_at DESC NULLS LAST, finished_at DESC NULLS LAST, created_at DESC
      `,
      [params.orderId]
    );

    const latestModerationJob = jobRows.find((job) => job.type === 'moderation') ?? null;
    const latestModeration = latestModerationJob
      ? {
          jobId: latestModerationJob.id,
          status: latestModerationJob.status,
          attempt: latestModerationJob.attempt,
          startedAt: latestModerationJob.started_at,
          finishedAt: latestModerationJob.finished_at,
          ...buildModerationSnapshot({
            output: latestModerationJob.output_json,
            errorText: latestModerationJob.error_text,
            provider: latestModerationJob.provider
          })
        }
      : null;

    const artifactsRows = await query(
      `
      SELECT *
      FROM artifacts
      WHERE order_id = $1
      ORDER BY created_at DESC
      `,
      [params.orderId]
    );

    const providerTaskRows = await query<ProviderTaskStatusRow>(
      `
      SELECT
        provider_task_id,
        provider,
        order_id,
        job_type,
        status,
        artifact_key,
        output_json,
        error_text,
        last_polled_at,
        created_at,
        updated_at
      FROM provider_tasks
      WHERE order_id = $1
      ORDER BY updated_at DESC
      `,
      [params.orderId]
    );

    const parentRetryPolicy = await buildParentRetryPolicy(order);
    const latestGiftLink = await getLatestGiftLink(params.orderId);

    return reply.send({
      order,
      latestScript,
      jobs: jobRows,
      latestModeration,
      artifacts: artifactsRows,
      providerTasks: providerTaskRows,
      parentRetryPolicy,
      latestGiftLink: latestGiftLink
        ? {
            ...buildGiftLinkResponse(latestGiftLink),
            redeemedAt: latestGiftLink.redeemed_at
          }
        : null,
      scenePlanThemeName,
      scenePlan,
      scenePlanError
    });
  });

  app.post('/orders/:orderId/delete-data', async (request, reply) => {
    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);

    const order = await getOrder(params.orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }

    const hasOrderAccess = hasAdminAccess(request) || (await assertParentOwnsOrder(request, order));
    if (!hasOrderAccess) {
      return reply.status(401).send({ message: 'Unauthorized delete request.' });
    }

    const triggerSource: OrderDataPurgeTriggerSource = hasAdminAccess(request) ? 'manual_admin' : 'manual_parent';
    const actor: 'admin' | 'parent' = triggerSource === 'manual_admin' ? 'admin' : 'parent';

    try {
      const cleanup = await deleteOrderAssociatedData(params.orderId);
      await recordOrderDataPurgeEvent({
        orderId: params.orderId,
        triggerSource,
        actor,
        previousOrderStatus: order.status,
        resultingOrderStatus: order.status,
        outcome: 'succeeded',
        deletedAssetCount: cleanup.deletedAssetCount,
        providerDeletion: cleanup.providerDeletion,
        retentionWindowDays: null,
        errorText: null
      });

      return reply.send({
        deleted: true,
        orderId: params.orderId,
        deletedAssetCount: cleanup.deletedAssetCount,
        providerDeletion: cleanup.providerDeletion,
        note: 'Order uploads, artifacts, scripts, provider tasks, and jobs were removed locally after best-effort provider cleanup.'
      });
    } catch (error) {
      await recordOrderDataPurgeEvent({
        orderId: params.orderId,
        triggerSource,
        actor,
        previousOrderStatus: order.status,
        resultingOrderStatus: order.status,
        outcome: 'failed',
        deletedAssetCount: 0,
        retentionWindowDays: null,
        errorText: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
      throw error;
    }
  });

  return app;
}

buildServer()
  .then((app) =>
    app.listen({ port: env.API_PORT, host: '0.0.0.0' }).then(() => {
      app.log.info(`API listening on http://localhost:${env.API_PORT}`);
    })
  )
  .catch((error) => {
    process.stderr.write(`Server startup failed: ${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  });

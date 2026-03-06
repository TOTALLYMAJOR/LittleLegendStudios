import { createHash, randomBytes, randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import { assertOrderTransition, type OrderStatus, type SceneRenderSpec, type ScriptPayload, type ThemeManifest } from '@little/shared';
import fastifyRawBody from 'fastify-raw-body';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type Stripe from 'stripe';
import { z } from 'zod';

import { createSignedDownloadUrl, createSignedUploadUrl, registerAssetRoutes } from './asset-routes.js';
import { deleteAssetByKey, writeAssetBytes } from './asset-store.js';
import { query } from './db.js';
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

interface ScenePlanEntry {
  shotNumber: number;
  shotType: 'narration' | 'dialogue';
  durationSec: number;
  sceneFallbackUsed: boolean;
  sceneRenderSpec: SceneRenderSpec;
}

type RenderEnqueueSource = 'payment_stub' | 'payment_webhook' | 'parent_retry' | 'admin_retry';

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
const parentRetryableStatuses: OrderStatus[] = ['failed_soft', 'failed_hard', 'manual_review'];
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

function extractParentAccessToken(request: FastifyRequest): string | null {
  const bearerToken = parseBearerToken(request.headers.authorization);
  if (bearerToken) {
    return bearerToken;
  }

  const headerToken = request.headers['x-parent-access-token'];
  return typeof headerToken === 'string' && headerToken.trim().length > 0 ? headerToken.trim() : null;
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

function buildGiftRedemptionUrl(token: string): string {
  return `${env.WEB_APP_BASE_URL}/gift/redeem/${token}`;
}

function buildGiftTokenHint(token: string): string {
  return token.slice(-6);
}

function createGiftToken(): string {
  return randomBytes(24).toString('hex');
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
      sceneName: scene.name,
      sceneArchitecture: args.manifest.sceneArchitecture,
      camera: shot.camera || scene.cameraPreset,
      lighting: shot.lighting || scene.lightingPreset,
      environmentMotion: shot.environmentMotion.length > 0 ? shot.environmentMotion : scene.environmentMotionDefaults,
      soundBed: scene.soundBed,
      assets: scene.assets,
      anchors: scene.anchors,
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
    return reply.send({
      ...user,
      parentAccessToken: createParentAccessToken({
        userId: user.id,
        email: user.email
      })
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

  app.post('/orders', async (request, reply) => {
    const payload = createOrderSchema.parse(request.body);

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
        'pending',
        now() + ($7::text || ' days')::interval
      )
      RETURNING *
      `,
      [
        params.orderId,
        normalizedRecipientEmail,
        payload.senderName ?? null,
        payload.giftMessage ?? null,
        tokenHash,
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
      const subject = `Your Little Legend gift is ready to redeem`;
      const senderLine = payload.senderName ? `${payload.senderName} sent you a Little Legend gift.` : `A Little Legend gift was sent to you.`;
      const messageLine = payload.giftMessage ? `Message: "${payload.giftMessage}"` : 'Open the redemption link to claim your order.';
      const safeSenderLine = escapeHtml(senderLine);
      const safeMessageLine = escapeHtml(messageLine);
      const html = `
        <p>${safeSenderLine}</p>
        <p>${safeMessageLine}</p>
        <p><a href="${redemptionUrl}">Redeem gift</a></p>
        <p>If the button does not work, copy this URL into your browser:</p>
        <p>${redemptionUrl}</p>
      `;
      const text = `${senderLine}\n${messageLine}\nRedeem gift: ${redemptionUrl}`;
      const sendResult = await sendTransactionalEmail({
        to: normalizedRecipientEmail,
        subject,
        html,
        text
      });

      emailDelivery = {
        status: sendResult.status,
        provider: sendResult.provider,
        errorText: sendResult.errorText
      };

      await recordEmailNotification({
        orderId: params.orderId,
        recipientEmail: normalizedRecipientEmail,
        notificationType: 'gift_redeem_link',
        provider: sendResult.provider,
        providerMessageId: sendResult.providerMessageId,
        status: sendResult.status,
        subject,
        errorText: sendResult.errorText,
        payload: {
          giftLinkId: giftLink.id,
          tokenHint
        }
      });
    }

    return reply.send({
      giftLink: {
        id: giftLink.id,
        orderId: giftLink.order_id,
        recipientEmail: giftLink.recipient_email,
        senderName: giftLink.sender_name,
        giftMessage: giftLink.gift_message,
        status: giftLink.status,
        tokenHint: giftLink.token_hint,
        expiresAt: giftLink.expires_at,
        createdAt: giftLink.created_at
      },
      redemptionUrl,
      emailDelivery
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

    const link = await getGiftLinkByToken(params.token);
    if (!link) {
      return reply.status(404).send({ message: 'Gift redemption link not found.' });
    }

    if (link.status === 'pending' && isGiftLinkExpired(link)) {
      await markGiftLinkExpired(link.id);
      return reply.status(410).send({ message: 'Gift redemption link has expired.' });
    }

    if (link.status !== 'pending') {
      return reply.status(409).send({
        message: `Gift redemption link cannot be redeemed in status ${link.status}.`
      });
    }

    const normalizedParentEmail = payload.parentEmail.toLowerCase();
    if (normalizedParentEmail !== link.recipient_email.toLowerCase()) {
      return reply.status(403).send({ message: 'Gift redemption email does not match recipient email.' });
    }

    const [user] = await query<UserRow>(
      `
      INSERT INTO users (email)
      VALUES ($1)
      ON CONFLICT (email)
      DO UPDATE SET email = EXCLUDED.email
      RETURNING *
      `,
      [normalizedParentEmail]
    );

    await query(
      `
      UPDATE orders
      SET user_id = $2,
          updated_at = now()
      WHERE id = $1
      `,
      [link.order_id, user.id]
    );

    const [updatedLink] = await query<GiftLinkRow>(
      `
      UPDATE gift_redemption_links
      SET status = 'redeemed',
          redeemed_by_user_id = $2,
          redeemed_at = now(),
          updated_at = now()
      WHERE id = $1
      RETURNING *
      `,
      [link.id, user.id]
    );
    if (!updatedLink) {
      return reply.status(500).send({ message: 'Gift redemption update failed.' });
    }

    return reply.send({
      redeemed: true,
      orderId: link.order_id,
      userId: user.id,
      parentEmail: user.email,
      parentAccessToken: createParentAccessToken({
        userId: user.id,
        email: user.email
      }),
      giftLink: {
        id: updatedLink.id,
        status: updatedLink.status,
        redeemedAt: updatedLink.redeemed_at
      },
      orderStatusUrl: `${env.WEB_APP_BASE_URL}/orders/${link.order_id}`
    });
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

    const jobRows = await query(
      `
      SELECT *
      FROM jobs
      WHERE order_id = $1
      ORDER BY started_at DESC NULLS LAST, finished_at DESC NULLS LAST
      `,
      [params.orderId]
    );

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
    const latestGiftLinkRows = await query<GiftLinkRow>(
      `
      SELECT *
      FROM gift_redemption_links
      WHERE order_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [params.orderId]
    );
    const latestGiftLink = latestGiftLinkRows[0] ?? null;

    return reply.send({
      order,
      latestScript,
      jobs: jobRows,
      artifacts: artifactsRows,
      providerTasks: providerTaskRows,
      parentRetryPolicy,
      latestGiftLink: latestGiftLink
        ? {
            id: latestGiftLink.id,
            recipientEmail: latestGiftLink.recipient_email,
            senderName: latestGiftLink.sender_name,
            giftMessage: latestGiftLink.gift_message,
            tokenHint: latestGiftLink.token_hint,
            status: latestGiftLink.status,
            expiresAt: latestGiftLink.expires_at,
            redeemedAt: latestGiftLink.redeemed_at,
            createdAt: latestGiftLink.created_at
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

    const uploadRows = await query<AssetKeyRow>('SELECT s3_key FROM uploads WHERE order_id = $1', [params.orderId]);
    const artifactRows = await query<AssetKeyRow>('SELECT s3_key FROM artifacts WHERE order_id = $1', [params.orderId]);

    const assetKeys = [...uploadRows, ...artifactRows].map((row) => row.s3_key);
    await Promise.all(assetKeys.map((assetKey) => deleteAssetByKey(assetKey).catch(() => undefined)));

    await query('DELETE FROM uploads WHERE order_id = $1', [params.orderId]);
    await query('DELETE FROM artifacts WHERE order_id = $1', [params.orderId]);

    return reply.send({
      deleted: true,
      orderId: params.orderId,
      note: 'Binary assets removed from metadata store. Provider hard-delete hooks should run here.'
    });
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

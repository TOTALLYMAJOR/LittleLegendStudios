import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import { assertOrderTransition, type OrderStatus } from '@little/shared';
import fastifyRawBody from 'fastify-raw-body';
import Fastify, { type FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { z } from 'zod';

import { createSignedUploadUrl, registerAssetRoutes } from './asset-routes.js';
import { deleteAssetByKey } from './asset-store.js';
import { query } from './db.js';
import { env } from './env.js';
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

const LAUNCH_PRICE_CENTS = 3900;
const MIN_PHOTO_UPLOADS = 5;
const MAX_PHOTO_UPLOADS = 15;
const REQUIRED_VOICE_UPLOADS = 1;
const MAX_SCRIPT_VERSIONS_PER_ORDER = 3;
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

async function getOrder(orderId: string): Promise<OrderRow | null> {
  const rows = await query<OrderRow>('SELECT * FROM orders WHERE id = $1', [orderId]);
  return rows[0] ?? null;
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

async function queueRenderOrder(orderId: string, paymentIntentId: string): Promise<void> {
  await renderQueue.add(
    'render-order',
    {
      orderId,
      paymentIntentId
    },
    {
      jobId: `render:${orderId}`
    }
  );
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
    await setOrderStatus(orderId, 'payment_pending');
  }

  const refreshed = await getOrder(orderId);
  if (!refreshed) {
    return;
  }

  if (refreshed.status !== 'payment_pending') {
    return;
  }

  await updatePaymentIntent(orderId, paymentIntentId);
  const paidOrder = await setOrderStatus(orderId, 'paid');
  await queueRenderOrder(orderId, paidOrder.stripe_payment_intent_id ?? paymentIntentId ?? `pi_missing_${randomUUID().slice(0, 10)}`);
}

async function markPaymentPendingOrderAsCancelled(orderId: string): Promise<void> {
  const order = await getOrder(orderId);
  if (!order || order.status !== 'payment_pending') {
    return;
  }

  await setOrderStatus(orderId, 'awaiting_script_approval');
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
    } catch (error) {
      request.log.error({ err: error, eventId: event.id, eventType: event.type }, 'Stripe webhook processing failed');
      return reply.status(500).send({ message: 'Webhook processing failed' });
    }

    return reply.send({ received: true });
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

    return reply.send(rows[0]);
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

    return reply.send(scriptRow);
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
      payableOrder = await setOrderStatus(params.orderId, 'payment_pending');
    }

    if (payableOrder.status !== 'payment_pending') {
      return reply.status(409).send({ message: `Cannot pay order in status ${payableOrder.status}` });
    }

    if (isStripePaymentsEnabled()) {
      const [user] = await query<Pick<UserRow, 'email'>>('SELECT email FROM users WHERE id = $1', [order.user_id]);

      const checkoutSession = await createCheckoutSession({
        orderId: params.orderId,
        amountCents: payableOrder.amount_cents,
        currency: payableOrder.currency,
        parentEmail: user?.email
      });

      if (!checkoutSession.url) {
        return reply.status(500).send({ message: 'Stripe Checkout session did not return a URL.' });
      }

      return reply.send({
        order: payableOrder,
        provider: 'stripe',
        checkoutSessionId: checkoutSession.id,
        checkoutUrl: checkoutSession.url
      });
    }

    const paymentIntentId = `pi_dev_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    await updatePaymentIntent(params.orderId, paymentIntentId);
    const paidOrder = await setOrderStatus(params.orderId, 'paid');
    await queueRenderOrder(params.orderId, paymentIntentId);

    return reply.send({
      order: paidOrder,
      paymentIntentId,
      provider: 'stripe_stub'
    });
  });

  app.get('/orders/:orderId/status', async (request, reply) => {
    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);

    const order = await getOrder(params.orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }

    const latestScriptRows = await query(
      `
      SELECT *
      FROM scripts
      WHERE order_id = $1
      ORDER BY version DESC
      LIMIT 1
      `,
      [params.orderId]
    );

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

    return reply.send({
      order,
      latestScript: latestScriptRows[0] ?? null,
      jobs: jobRows,
      artifacts: artifactsRows
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

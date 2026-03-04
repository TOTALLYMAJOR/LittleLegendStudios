import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import { assertOrderTransition, type OrderStatus } from '@little/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { query } from './db.js';
import { env } from './env.js';
import { renderQueue } from './queue.js';
import { generateScript } from './script.js';
import { seedThemes } from './seed.js';

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

const createUserSchema = z.object({
  email: z.string().email()
});

const createOrderSchema = z.object({
  userId: z.string().uuid(),
  themeSlug: z.string().min(1),
  amountCents: z.number().int().min(500).max(20000).default(1999),
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

async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: true,
    credentials: true
  });

  await seedThemes();

  app.get('/health', async () => ({ ok: true }));

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
      [payload.userId, theme.id, payload.currency.toLowerCase(), payload.amountCents]
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

    const uploadId = randomUUID();
    const s3Key = `${order.user_id}/${params.orderId}/${payload.kind}/${uploadId}`;

    await query(
      `
      INSERT INTO uploads (id, order_id, kind, s3_key, content_type, bytes, sha256)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [uploadId, params.orderId, payload.kind, s3Key, payload.contentType, payload.bytes, payload.sha256 ?? null]
    );

    const signedUploadUrl = `${env.PUBLIC_ASSET_BASE_URL}/upload/${encodeURIComponent(s3Key)}?token=dev`;

    return reply.send({
      uploadId,
      s3Key,
      signedUploadUrl,
      expiresInSec: 900
    });
  });

  app.post('/orders/:orderId/script/generate', async (request, reply) => {
    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const payload = generateScriptSchema.parse(request.body);

    const order = await getOrder(params.orderId);
    if (!order) {
      return reply.status(404).send({ message: 'Order not found' });
    }

    const [theme] = await query<ThemeRow>('SELECT * FROM themes WHERE id = $1', [order.theme_id]);
    if (!theme) {
      return reply.status(404).send({ message: 'Theme not found for order' });
    }

    const script = generateScript({
      childName: payload.childName,
      themeName: theme.name
    });

    const [versionRow] = await query<{ next_version: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM scripts WHERE order_id = $1',
      [params.orderId]
    );

    const version = versionRow.next_version;

    const [scriptRow] = await query(
      `
      INSERT INTO scripts (order_id, version, script_json)
      VALUES ($1, $2, $3::jsonb)
      RETURNING *
      `,
      [params.orderId, version, JSON.stringify(script)]
    );

    if (order.status === 'draft') {
      await setOrderStatus(params.orderId, 'awaiting_script_approval');
    }

    return reply.send(scriptRow);
  });

  app.post('/orders/:orderId/script/approve', async (request, reply) => {
    const params = z.object({ orderId: z.string().uuid() }).parse(request.params);
    const payload = approveScriptSchema.parse(request.body);

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

    return reply.send(approved);
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

    if (order.status !== 'awaiting_script_approval') {
      return reply.status(409).send({ message: `Cannot pay order in status ${order.status}` });
    }

    const paymentIntentId = `pi_dev_${randomUUID().replaceAll('-', '').slice(0, 24)}`;

    await query('UPDATE orders SET stripe_payment_intent_id = $2 WHERE id = $1', [params.orderId, paymentIntentId]);

    const paidOrder = await setOrderStatus(params.orderId, 'paid');

    await renderQueue.add('render-order', {
      orderId: params.orderId,
      paymentIntentId
    });

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

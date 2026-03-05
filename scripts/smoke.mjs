#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';

import pg from 'pg';

const { Client } = pg;

function loadDotEnvIfPresent() {
  if (!existsSync('.env')) {
    return;
  }

  const raw = readFileSync('.env', 'utf8');
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytesForLabel(label, size) {
  const normalized = label.padEnd(size, '#').slice(0, size);
  return Buffer.from(normalized, 'utf8');
}

function createSmokeClient(baseUrl) {
  async function request(path, options = {}) {
    const method = options.method ?? 'GET';
    const headers = {
      ...(options.headers ?? {})
    };
    let body;
    if (options.jsonBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.jsonBody);
    } else if (options.body !== undefined) {
      body = options.body;
    }

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body
    });

    const text = await response.text();
    let data = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { rawText: text };
      }
    }

    if (!response.ok) {
      const detail = data ? JSON.stringify(data) : `HTTP ${response.status}`;
      throw new Error(`${method} ${path} failed (${response.status}): ${detail}`);
    }

    return data;
  }

  return {
    request
  };
}

function alignAssetUrlWithApiBase(url, apiBase) {
  const signed = new URL(url);
  const api = new URL(apiBase);
  signed.protocol = api.protocol;
  signed.host = api.host;
  return signed.toString();
}

async function uploadSignedAsset({ signedUploadUrl, contentType, bytes }) {
  const put = async (url) =>
    fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType
      },
      body: bytes
    });

  let response = await put(signedUploadUrl);
  let text = await response.text();

  if (!response.ok && response.status === 404) {
    const parsed = new URL(signedUploadUrl);
    const prefix = '/assets/upload/';
    if (parsed.pathname.startsWith(prefix)) {
      const currentKey = parsed.pathname.slice(prefix.length);
      const decodedKey = decodeURIComponent(currentKey);
      parsed.pathname = `${prefix}${encodeURIComponent(encodeURIComponent(decodedKey))}`;
      response = await put(parsed.toString());
      text = await response.text();
    }
  }

  if (!response.ok) {
    throw new Error(`Signed upload failed (${response.status}): ${text}`);
  }
}

async function waitForOrderTerminalStatus(client, orderId, timeoutMs) {
  const started = Date.now();
  const terminalStatuses = new Set(['delivered', 'failed_hard', 'manual_review', 'refunded', 'expired']);
  let lastStatus = 'unknown';

  while (Date.now() - started <= timeoutMs) {
    const statusPayload = await client.request(`/orders/${orderId}/status`);
    lastStatus = statusPayload.order.status;
    process.stdout.write(`[smoke] order ${orderId} status: ${lastStatus}\n`);

    if (terminalStatuses.has(lastStatus)) {
      return statusPayload;
    }

    await sleep(3000);
  }

  throw new Error(`Timed out waiting for terminal order status. Last seen status: ${lastStatus}`);
}

async function main() {
  loadDotEnvIfPresent();

  const apiBase = process.env.SMOKE_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for smoke test verification.');
  }

  const client = createSmokeClient(apiBase);
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();

  try {
    const smokeSeed = `${Date.now()}`;
    const parentEmail = `smoke-parent+${smokeSeed}@example.com`;
    const giftEmail = `smoke-gift+${smokeSeed}@example.com`;
    const childName = `Smoke${smokeSeed.slice(-4)}`;

    process.stdout.write(`[smoke] API base: ${apiBase}\n`);

    await client.request('/health');
    process.stdout.write('[smoke] health check passed\n');

    const user = await client.request('/users/upsert', {
      method: 'POST',
      jsonBody: { email: parentEmail }
    });
    process.stdout.write(`[smoke] user ready: ${user.id}\n`);

    const themes = await client.request('/themes');
    if (!Array.isArray(themes) || themes.length === 0) {
      throw new Error('No active themes returned by /themes.');
    }
    const selectedTheme = themes[0];
    process.stdout.write(`[smoke] selected theme: ${selectedTheme.slug}\n`);

    const order = await client.request('/orders', {
      method: 'POST',
      jsonBody: {
        userId: user.id,
        themeSlug: selectedTheme.slug,
        currency: 'usd'
      }
    });
    const orderId = order.id;
    process.stdout.write(`[smoke] order created: ${orderId}\n`);

    await client.request(`/orders/${orderId}/consent`, {
      method: 'POST',
      jsonBody: {
        userId: user.id,
        version: 'smoke-v1',
        userAgent: 'smoke-script'
      }
    });
    process.stdout.write('[smoke] consent captured\n');

    for (let index = 0; index < 5; index += 1) {
      const bytes = bytesForLabel(`photo-${index}-${smokeSeed}`, 2048);
      const contentType = 'image/jpeg';
      const signed = await client.request(`/orders/${orderId}/uploads/sign`, {
        method: 'POST',
        jsonBody: {
          kind: 'photo',
          contentType,
          bytes: bytes.length,
          sha256: sha256Hex(bytes)
        }
      });

      await uploadSignedAsset({
        signedUploadUrl: alignAssetUrlWithApiBase(signed.signedUploadUrl, apiBase),
        contentType,
        bytes
      });
    }
    process.stdout.write('[smoke] uploaded 5 photos\n');

    {
      const bytes = bytesForLabel(`voice-${smokeSeed}`, 4096);
      const contentType = 'audio/wav';
      const signed = await client.request(`/orders/${orderId}/uploads/sign`, {
        method: 'POST',
        jsonBody: {
          kind: 'voice',
          contentType,
          bytes: bytes.length,
          sha256: sha256Hex(bytes)
        }
      });

      await uploadSignedAsset({
        signedUploadUrl: alignAssetUrlWithApiBase(signed.signedUploadUrl, apiBase),
        contentType,
        bytes
      });
    }
    process.stdout.write('[smoke] uploaded voice sample\n');

    const generated = await client.request(`/orders/${orderId}/script/generate`, {
      method: 'POST',
      jsonBody: {
        childName,
        keywords: ['smoke', 'automation']
      }
    });
    process.stdout.write(`[smoke] script generated v${generated.version}\n`);

    await client.request(`/orders/${orderId}/script/approve`, {
      method: 'POST',
      jsonBody: {
        version: generated.version
      }
    });
    process.stdout.write('[smoke] script approved\n');

    const payResult = await client.request(`/orders/${orderId}/pay`, {
      method: 'POST',
      jsonBody: {}
    });
    process.stdout.write(`[smoke] pay provider: ${payResult.provider}\n`);

    if (payResult.provider === 'stripe') {
      throw new Error(
        'Smoke script requires stub payment mode for automation. Unset STRIPE_SECRET_KEY or switch to stub environment.'
      );
    }

    const terminalPayload = await waitForOrderTerminalStatus(client, orderId, 240000);
    process.stdout.write(`[smoke] terminal status after initial run: ${terminalPayload.order.status}\n`);

    const forcedPaymentIntent = `pi_dev_smoke_${smokeSeed}`;
    await db.query(
      `
      UPDATE orders
      SET status = 'failed_hard',
          stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $2),
          updated_at = now()
      WHERE id = $1
      `,
      [orderId, forcedPaymentIntent]
    );
    process.stdout.write('[smoke] forced order to failed_hard for parent retry test\n');

    const retryResult = await client.request(`/orders/${orderId}/retry`, {
      method: 'POST',
      jsonBody: {
        reason: 'smoke test parent retry'
      }
    });
    process.stdout.write(`[smoke] parent retry queued: ${retryResult.retryJobId}\n`);

    const giftLink = await client.request(`/orders/${orderId}/gift-link`, {
      method: 'POST',
      jsonBody: {
        recipientEmail: giftEmail,
        senderName: 'Smoke Test',
        giftMessage: 'Gift flow smoke test',
        sendEmail: true
      }
    });
    if (!giftLink.redemptionUrl) {
      throw new Error('Gift link response missing redemptionUrl.');
    }
    process.stdout.write('[smoke] gift link created\n');

    const redemptionToken = new URL(giftLink.redemptionUrl).pathname.split('/').filter(Boolean).pop();
    if (!redemptionToken) {
      throw new Error('Could not extract redemption token from URL.');
    }

    await client.request(`/gift/redeem/${redemptionToken}`);
    const redeemResult = await client.request(`/gift/redeem/${redemptionToken}`, {
      method: 'POST',
      jsonBody: {
        parentEmail: giftEmail
      }
    });
    process.stdout.write(`[smoke] gift redeemed for order: ${redeemResult.orderId}\n`);

    await sleep(2000);

    const emailRows = await db.query(
      `
      SELECT notification_type, status, recipient_email, created_at
      FROM email_notifications
      WHERE order_id = $1
      ORDER BY created_at DESC
      `,
      [orderId]
    );

    if (!emailRows.rows.length) {
      throw new Error('No email_notifications rows found for smoke order.');
    }

    const summary = {
      ok: true,
      orderId,
      parentEmail,
      giftEmail,
      finalObservedStatus: terminalPayload.order.status,
      parentRetryJobId: retryResult.retryJobId ?? null,
      giftRedemptionUrl: giftLink.redemptionUrl,
      giftEmailDeliveryStatus: giftLink.emailDelivery?.status ?? 'unknown',
      emailNotifications: emailRows.rows
    };

    process.stdout.write(`\n[smoke] SUCCESS\n${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  process.stderr.write(`[smoke] FAILED: ${(error && error.stack) || String(error)}\n`);
  process.exitCode = 1;
});

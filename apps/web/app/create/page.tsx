'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';

type Theme = {
  id: string;
  slug: string;
  name: string;
  description: string;
};

type GeneratedScript = {
  id: string;
  version: number;
  script_json: {
    title: string;
    narration: string[];
    shots: Array<{
      shotNumber: number;
      durationSec: number;
      action: string;
      dialogue: string;
    }>;
  };
  previewArtifact?: {
    kind: 'preview_video';
    s3Key: string;
    meta: {
      signedDownloadUrl?: string;
      [key: string]: unknown;
    };
  };
};

type PayResponse = {
  provider: 'stripe' | 'stripe_stub';
  checkoutUrl?: string;
  paymentIntentId?: string;
};

type UploadSignResponse = {
  uploadId: string;
  s3Key: string;
  signedUploadUrl: string;
  expiresInSec: number;
};

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';
const launchPriceLabel = '$39';

function sanitizeReturnTo(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return null;
  }

  return value;
}

function createIdempotencyKey(prefix: string): string {
  return `${prefix}:${Date.now()}:${crypto.randomUUID()}`;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

async function fileSha256(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function uploadFileToSignedUrl(args: {
  signedUploadUrl: string;
  contentType: string;
  file: File;
}): Promise<void> {
  const response = await fetch(args.signedUploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': args.contentType
    },
    body: args.file
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Signed upload failed (${response.status}).`);
  }
}

function CreateOrderPageContent(): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [themes, setThemes] = useState<Theme[]>([]);
  const [email, setEmail] = useState('');
  const [childName, setChildName] = useState('');
  const [themeSlug, setThemeSlug] = useState('');
  const [userId, setUserId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [paymentIdempotencyKey, setPaymentIdempotencyKey] = useState('');
  const [script, setScript] = useState<GeneratedScript | null>(null);
  const [isScriptApproved, setIsScriptApproved] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [photoFiles, setPhotoFiles] = useState<FileList | null>(null);
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const returnTo = sanitizeReturnTo(searchParams.get('returnTo'));
  const recoveringOrderId = returnTo?.match(/^\/orders\/([^/?#]+)/)?.[1] ?? null;

  const canCreateUser = useMemo(() => email.length > 3, [email]);
  const canCreateOrder = useMemo(() => userId.length > 0 && themeSlug.length > 0, [themeSlug, userId]);
  const canGenerateScript = useMemo(() => {
    const photoCount = photoFiles?.length ?? 0;
    return Boolean(orderId.length > 0 && childName.length > 0 && photoCount >= 5 && photoCount <= 15 && voiceFile);
  }, [orderId, childName, photoFiles, voiceFile]);
  const canPay = useMemo(() => orderId.length > 0 && Boolean(script) && isScriptApproved, [isScriptApproved, orderId, script]);

  async function loadThemes(): Promise<void> {
    setLoading(true);
    try {
      const data = await apiFetch<Theme[]>('/themes');
      setThemes(data);
      if (!themeSlug && data[0]) {
        setThemeSlug(data[0].slug);
      }
      setStatusMessage(`Loaded ${data.length} active themes.`);
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function upsertUser(): Promise<void> {
    setLoading(true);
    try {
      const user = await apiFetch<{ id: string; parentAccessToken: string }>('/users/upsert', {
        method: 'POST',
        body: JSON.stringify({ email })
      });

      setUserId(user.id);
      if (returnTo) {
        setStatusMessage(`Parent session restored. Returning to ${recoveringOrderId ?? 'your order'}...`);
        router.push(returnTo as Route);
        return;
      }

      setStatusMessage(`User ready: ${user.id}`);
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function createOrder(): Promise<void> {
    setLoading(true);
    try {
      const order = await apiFetch<{ id: string }>('/orders', {
        method: 'POST',
        body: JSON.stringify({
          userId,
          themeSlug,
          currency: 'usd'
        })
      });

      setOrderId(order.id);
      setPaymentIdempotencyKey(createIdempotencyKey(`pay:${order.id}`));

      await apiFetch(`/orders/${order.id}/consent`, {
        method: 'POST',
        body: JSON.stringify({
          userId,
          version: 'mvp-v1',
          userAgent: window.navigator.userAgent
        })
      });

      setStatusMessage(`Order created + consent captured: ${order.id}`);
      setScript(null);
      setIsScriptApproved(false);
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function signUploads(): Promise<void> {
    if (!orderId) return;

    setLoading(true);
    try {
      const photoCount = photoFiles?.length ?? 0;
      if (photoCount < 5 || photoCount > 15) {
        throw new Error('Please select 5-15 photos before signing uploads.');
      }

      if (!voiceFile) {
        throw new Error('Please select one voice sample (30-60 seconds) before signing uploads.');
      }

      for (const file of Array.from(photoFiles ?? [])) {
        const contentType = file.type || 'image/jpeg';
        const sha256 = await fileSha256(file);
        const signed = await apiFetch<UploadSignResponse>(`/orders/${orderId}/uploads/sign`, {
          method: 'POST',
          body: JSON.stringify({
            kind: 'photo',
            contentType,
            bytes: file.size,
            sha256
          })
        });

        await uploadFileToSignedUrl({
          signedUploadUrl: signed.signedUploadUrl,
          contentType,
          file
        });
      }

      const voiceContentType = voiceFile.type || 'audio/wav';
      const voiceSha256 = await fileSha256(voiceFile);
      const signedVoice = await apiFetch<UploadSignResponse>(`/orders/${orderId}/uploads/sign`, {
        method: 'POST',
        body: JSON.stringify({
          kind: 'voice',
          contentType: voiceContentType,
          bytes: voiceFile.size,
          sha256: voiceSha256
        })
      });

      await uploadFileToSignedUrl({
        signedUploadUrl: signedVoice.signedUploadUrl,
        contentType: voiceContentType,
        file: voiceFile
      });

      setStatusMessage(`Uploaded ${photoCount + 1} files to signed asset URLs.`);
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function generateAndPreviewScript(): Promise<void> {
    if (!orderId) return;

    setLoading(true);
    try {
      const generated = await apiFetch<GeneratedScript>(`/orders/${orderId}/script/generate`, {
        method: 'POST',
        body: JSON.stringify({
          childName,
          keywords: ['cinematic', 'keepsake']
        })
      });

      setScript(generated);
      setIsScriptApproved(false);
      setStatusMessage(`Generated script v${generated.version}.`);
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function approveScript(): Promise<void> {
    if (!script || !orderId) return;

    setLoading(true);
    try {
      await apiFetch(`/orders/${orderId}/script/approve`, {
        method: 'POST',
        body: JSON.stringify({ version: script.version })
      });

      setStatusMessage(`Approved script version ${script.version}.`);
      setIsScriptApproved(true);
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function payAndRender(): Promise<void> {
    if (!orderId) return;

    setLoading(true);
    try {
      const idempotencyKey = paymentIdempotencyKey || createIdempotencyKey(`pay:${orderId}`);
      if (!paymentIdempotencyKey) {
        setPaymentIdempotencyKey(idempotencyKey);
      }

      const payResponse = await apiFetch<PayResponse>(`/orders/${orderId}/pay`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify({})
      });

      if (payResponse.provider === 'stripe' && payResponse.checkoutUrl) {
        window.location.href = payResponse.checkoutUrl;
        return;
      }

      setStatusMessage('Payment captured (stub). Async render started.');
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <h1>Create Keepsake Order</h1>
      <p>
        Guided MVP intake matching your spec: photos + voice upload intent, theme selection, script approval, {launchPriceLabel}{' '}
        checkout, and async delivery.
      </p>

      {returnTo ? (
        <section className="card">
          <h2>Recover Parent Session</h2>
          <p>
            Your parent session is missing or expired. Re-enter the parent email for{' '}
            {recoveringOrderId ? <span className="mono">{recoveringOrderId}</span> : 'this order'} to restore access and return.
          </p>
          <p>
            If you reached this order from a gift email instead, reopen that gift redemption link to establish the correct session.
          </p>
          <p>
            Return target: <span className="mono">{returnTo}</span>
          </p>
        </section>
      ) : null}

      <section className="grid two">
        <article className="card">
          <h2>1. Parent Identity</h2>
          <label htmlFor="email">Parent Email</label>
          <input
            id="email"
            type="email"
            placeholder="parent@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <button disabled={!canCreateUser || loading} onClick={upsertUser}>
            {returnTo ? 'Restore Parent Session' : 'Create/Load Parent'}
          </button>
          {userId ? <p className="mono">user_id: {userId}</p> : null}
        </article>

        <article className="card">
          <h2>2. Theme + Child</h2>
          <button disabled={loading} onClick={loadThemes}>
            Load Themes
          </button>
          <label htmlFor="theme">Theme</label>
          <select id="theme" value={themeSlug} onChange={(event) => setThemeSlug(event.target.value)}>
            <option value="">Select theme</option>
            {themes.map((theme) => (
              <option key={theme.id} value={theme.slug}>
                {theme.name}
              </option>
            ))}
          </select>

          <label htmlFor="childName">Child Name</label>
          <input
            id="childName"
            placeholder="Avery"
            value={childName}
            onChange={(event) => setChildName(event.target.value)}
          />

          <button disabled={!canCreateOrder || loading} onClick={createOrder}>
            Create Order + Capture Consent
          </button>
          {orderId ? <p className="mono">order_id: {orderId}</p> : null}
        </article>
      </section>

      <section className="grid two">
        <article className="card">
          <h2>3. Upload Intake</h2>
          <p>Photos: 5-15 JPG/PNG. Voice: one 30-60 second WAV/M4A sample.</p>

          <label htmlFor="photos">Child Photos</label>
          <input
            id="photos"
            type="file"
            accept="image/png,image/jpeg"
            multiple
            onChange={(event) => setPhotoFiles(event.target.files)}
          />

          <label htmlFor="voice">Voice Sample</label>
          <input
            id="voice"
            type="file"
            accept="audio/wav,audio/m4a"
            onChange={(event) => setVoiceFile(event.target.files?.[0] ?? null)}
          />

          <button disabled={!orderId || loading} onClick={signUploads}>
            Sign Upload Intents
          </button>
        </article>

        <article className="card">
          <h2>4. Script, Approve, Pay</h2>
          <button disabled={!canGenerateScript || loading} onClick={generateAndPreviewScript}>
            Generate / Regenerate Script
          </button>
          <button disabled={!script || loading} onClick={approveScript}>
            Approve Script
          </button>
          <button disabled={!canPay || loading} onClick={payAndRender}>
            Pay {launchPriceLabel} + Start Render
          </button>
          {orderId ? <Link href={`/orders/${orderId}`}>Open live order status</Link> : null}
        </article>
      </section>

      {script ? (
        <section className="card">
          <h3>{script.script_json.title}</h3>
          {script.previewArtifact?.meta?.signedDownloadUrl ? (
            <p>
              <a href={script.previewArtifact.meta.signedDownloadUrl} target="_blank" rel="noreferrer">
                Open Watermarked Preview (720p)
              </a>
            </p>
          ) : null}
          <p>Narration:</p>
          <ul>
            {script.script_json.narration.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p>Shot Plan:</p>
          <ul>
            {script.script_json.shots.map((shot) => (
              <li key={shot.shotNumber}>
                Shot {shot.shotNumber} ({shot.durationSec}s): {shot.action} / {shot.dialogue}
              </li>
            ))}
          </ul>
          <p className="mono">Script approved: {isScriptApproved ? 'yes' : 'no'}</p>
        </section>
      ) : null}

      <section className="card">
        <span className="status-chip">Status</span>
        <p>{statusMessage || 'No actions yet.'}</p>
      </section>
    </main>
  );
}

export default function CreateOrderPage(): JSX.Element {
  return (
    <Suspense
      fallback={
        <main>
          <section className="card">
            <h1>Create Keepsake Order</h1>
            <p>Loading order flow...</p>
          </section>
        </main>
      }
    >
      <CreateOrderPageContent />
    </Suspense>
  );
}

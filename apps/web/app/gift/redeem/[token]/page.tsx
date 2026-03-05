'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

interface GiftPreviewResponse {
  giftLink: {
    id: string;
    orderId: string;
    recipientEmail: string;
    senderName: string | null;
    giftMessage: string | null;
    status: 'pending' | 'redeemed' | 'expired' | 'revoked';
    tokenHint: string;
    expiresAt: string;
    redeemedAt: string | null;
    createdAt: string;
  };
  order: {
    id: string;
    status: string;
    themeName: string;
  };
}

async function parseResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export default function GiftRedeemPage(): JSX.Element {
  const params = useParams<{ token: string }>();
  const token = typeof params.token === 'string' ? params.token : '';

  const [preview, setPreview] = useState<GiftPreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState('');
  const [parentEmail, setParentEmail] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [redeemedOrderId, setRedeemedOrderId] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadPreview(): Promise<void> {
      if (!token) {
        setLoading(false);
        setStatusMessage('Missing redemption token.');
        return;
      }

      setLoading(true);
      setStatusMessage('');
      try {
        const response = await fetch(`${apiBase}/gift/redeem/${token}`, {
          cache: 'no-store'
        });
        const data = await parseResponse(response);
        if (!response.ok) {
          throw new Error(data.message || `Failed to load gift link (${response.status}).`);
        }

        if (cancelled) {
          return;
        }

        setPreview(data as GiftPreviewResponse);
        setParentEmail((data as GiftPreviewResponse).giftLink.recipientEmail);
      } catch (error) {
        if (!cancelled) {
          setStatusMessage((error as Error).message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadPreview().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [token]);

  async function redeemGift(): Promise<void> {
    if (!parentEmail.trim()) {
      setStatusMessage('Please enter the recipient email address.');
      return;
    }

    if (!token) {
      setStatusMessage('Missing redemption token.');
      return;
    }

    setRedeeming(true);
    setStatusMessage('');
    try {
      const response = await fetch(`${apiBase}/gift/redeem/${token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          parentEmail: parentEmail.trim()
        })
      });
      const data = await parseResponse(response);
      if (!response.ok) {
        throw new Error(data.message || `Gift redemption failed (${response.status}).`);
      }

      const orderId = String(data.orderId ?? '');
      setRedeemedOrderId(orderId);
      setStatusMessage('Gift redeemed successfully.');
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setRedeeming(false);
    }
  }

  return (
    <main>
      <section className="card">
        <h1>Redeem Gift</h1>
        <p>Claim this order to your parent account so you can continue the creation flow.</p>
        {statusMessage ? <p>{statusMessage}</p> : null}
      </section>

      {loading ? (
        <section className="card">
          <p>Loading gift details...</p>
        </section>
      ) : null}

      {!loading && preview ? (
        <section className="grid two">
          <article className="card">
            <h2>Gift Details</h2>
            <p>
              Theme: <strong>{preview.order.themeName}</strong>
            </p>
            <p>Status: {preview.order.status}</p>
            <p>Recipient: {preview.giftLink.recipientEmail}</p>
            {preview.giftLink.senderName ? <p>From: {preview.giftLink.senderName}</p> : null}
            {preview.giftLink.giftMessage ? <p>Message: {preview.giftLink.giftMessage}</p> : null}
          </article>

          <article className="card">
            <h2>Confirm Recipient Email</h2>
            <label htmlFor="parentEmail">Recipient Email</label>
            <input
              id="parentEmail"
              type="email"
              value={parentEmail}
              onChange={(event) => setParentEmail(event.target.value)}
              placeholder="recipient@example.com"
            />
            <button disabled={redeeming || redeemedOrderId.length > 0} onClick={redeemGift}>
              Redeem Gift
            </button>
            {redeemedOrderId ? (
              <p>
                Gift claimed. <Link href={`/orders/${redeemedOrderId}`}>Open your order status</Link>
              </p>
            ) : null}
          </article>
        </section>
      ) : null}

      {!loading && !preview ? (
        <section className="card">
          <p>This gift link is unavailable. It may be expired, revoked, or already redeemed.</p>
        </section>
      ) : null}
    </main>
  );
}

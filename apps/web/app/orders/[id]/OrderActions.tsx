'use client';

import { useMemo, useState } from 'react';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

interface ParentRetryPolicy {
  limit: number;
  used: number;
  remaining: number;
  canRetry: boolean;
  reason: string | null;
}

interface LatestGiftLink {
  id: string;
  recipientEmail: string;
  senderName: string | null;
  giftMessage: string | null;
  tokenHint: string;
  status: 'pending' | 'redeemed' | 'expired' | 'revoked';
  expiresAt: string;
  redeemedAt: string | null;
  createdAt: string;
}

interface OrderActionsProps {
  orderId: string;
  parentRetryPolicy: ParentRetryPolicy;
  latestGiftLink: LatestGiftLink | null;
  parentAccessToken: string | null;
  recoveryHref: string;
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

export function OrderActions({
  orderId,
  parentRetryPolicy: initialRetryPolicy,
  latestGiftLink,
  parentAccessToken,
  recoveryHref
}: OrderActionsProps): JSX.Element {
  const [retryPolicy, setRetryPolicy] = useState<ParentRetryPolicy>(initialRetryPolicy);
  const [retryReason, setRetryReason] = useState('');
  const [retryLoading, setRetryLoading] = useState(false);
  const [retryMessage, setRetryMessage] = useState('');

  const [giftLinkState, setGiftLinkState] = useState<LatestGiftLink | null>(latestGiftLink);
  const [recipientEmail, setRecipientEmail] = useState(latestGiftLink?.recipientEmail ?? '');
  const [senderName, setSenderName] = useState(latestGiftLink?.senderName ?? '');
  const [giftMessage, setGiftMessage] = useState(latestGiftLink?.giftMessage ?? '');
  const [sendEmail, setSendEmail] = useState(true);
  const [giftLoading, setGiftLoading] = useState(false);
  const [giftActionMessage, setGiftActionMessage] = useState('');
  const [redemptionUrl, setRedemptionUrl] = useState('');
  const [sessionRecoveryMessage, setSessionRecoveryMessage] = useState(
    parentAccessToken ? '' : 'Parent session missing. Restore it before retrying order actions.'
  );

  const retryDisabled = useMemo(
    () => retryLoading || !retryPolicy.canRetry || !parentAccessToken || Boolean(sessionRecoveryMessage),
    [parentAccessToken, retryLoading, retryPolicy.canRetry, sessionRecoveryMessage]
  );
  const hasPendingGiftLink = giftLinkState?.status === 'pending';
  const resendGiftDisabled = giftLoading || !parentAccessToken || !hasPendingGiftLink || Boolean(sessionRecoveryMessage);
  const revokeGiftDisabled = giftLoading || !parentAccessToken || !hasPendingGiftLink || Boolean(sessionRecoveryMessage);
  const createGiftActionLabel = giftLinkState ? 'Regenerate Gift Redemption Link' : 'Create Gift Redemption Link';

  function markSessionExpired(): Error {
    setSessionRecoveryMessage('Parent session expired. Restore it, then return to this order.');
    return new Error('Parent session expired. Restore it, then return to this order.');
  }

  async function retryRender(): Promise<void> {
    setRetryLoading(true);
    setRetryMessage('');

    try {
      const response = await fetch(`${apiBase}/orders/${orderId}/retry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(parentAccessToken
            ? {
                Authorization: `Bearer ${parentAccessToken}`
              }
            : {})
        },
        body: JSON.stringify({
          reason: retryReason.trim().length > 0 ? retryReason.trim() : undefined
        })
      });
      const data = await parseResponse(response);
      if (response.status === 401) {
        throw markSessionExpired();
      }
      if (!response.ok) {
        throw new Error(data.message || `Retry request failed (${response.status}).`);
      }

      setSessionRecoveryMessage('');
      const nextUsed = Number(data.parentRetryUsed ?? retryPolicy.used + 1);
      const nextLimit = Number(data.parentRetryLimit ?? retryPolicy.limit);
      const nextRemaining = Number(data.parentRetryRemaining ?? Math.max(0, nextLimit - nextUsed));
      setRetryPolicy({
        limit: nextLimit,
        used: nextUsed,
        remaining: nextRemaining,
        canRetry: false,
        reason:
          nextRemaining > 0
            ? 'Retry queued. Refresh after processing to check whether another retry is needed.'
            : 'Parent retry limit reached for this order.'
      });
      setRetryMessage('Re-render queued. Refresh in a few seconds to see status changes.');
    } catch (error) {
      setRetryMessage((error as Error).message);
    } finally {
      setRetryLoading(false);
    }
  }

  async function createGiftLink(): Promise<void> {
    if (!recipientEmail.trim()) {
      setGiftActionMessage('Recipient email is required.');
      return;
    }

    setGiftLoading(true);
    setGiftActionMessage('');
    setRedemptionUrl('');

    try {
      const response = await fetch(`${apiBase}/orders/${orderId}/gift-link`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(parentAccessToken
            ? {
                Authorization: `Bearer ${parentAccessToken}`
              }
            : {})
        },
        body: JSON.stringify({
          recipientEmail: recipientEmail.trim(),
          senderName: senderName.trim().length > 0 ? senderName.trim() : undefined,
          giftMessage: giftMessage.trim().length > 0 ? giftMessage.trim() : undefined,
          sendEmail
        })
      });
      const data = await parseResponse(response);
      if (response.status === 401) {
        throw markSessionExpired();
      }
      if (!response.ok) {
        throw new Error(data.message || `Gift link creation failed (${response.status}).`);
      }

      setSessionRecoveryMessage('');
      setRedemptionUrl(String(data.redemptionUrl ?? ''));
      setGiftLinkState((data.giftLink as LatestGiftLink | undefined) ?? null);
      const emailStatus = String(data.emailDelivery?.status ?? 'skipped');
      const actionVerb = giftLinkState ? 'regenerated' : 'created';
      setGiftActionMessage(
        emailStatus === 'failed'
          ? `Gift link ${actionVerb}, but email delivery failed: ${String(data.emailDelivery?.errorText ?? 'unknown error')}`
          : `Gift link ${actionVerb} (${emailStatus}).`
      );
    } catch (error) {
      setGiftActionMessage((error as Error).message);
    } finally {
      setGiftLoading(false);
    }
  }

  async function revokeGiftLink(): Promise<void> {
    setGiftLoading(true);
    setGiftActionMessage('');
    setRedemptionUrl('');

    try {
      const response = await fetch(`${apiBase}/orders/${orderId}/gift-link/revoke`, {
        method: 'POST',
        headers: parentAccessToken
          ? {
              Authorization: `Bearer ${parentAccessToken}`
            }
          : undefined
      });
      const data = await parseResponse(response);
      if (response.status === 401) {
        throw markSessionExpired();
      }
      if (!response.ok) {
        throw new Error(data.message || `Gift link revoke failed (${response.status}).`);
      }

      setSessionRecoveryMessage('');
      setGiftLinkState((data.giftLink as LatestGiftLink | undefined) ?? giftLinkState);
      setGiftActionMessage('Gift link revoked. You can generate a replacement when ready.');
    } catch (error) {
      setGiftActionMessage((error as Error).message);
    } finally {
      setGiftLoading(false);
    }
  }

  async function resendGiftEmail(): Promise<void> {
    setGiftLoading(true);
    setGiftActionMessage('');
    setRedemptionUrl('');

    try {
      const response = await fetch(`${apiBase}/orders/${orderId}/gift-link/resend`, {
        method: 'POST',
        headers: parentAccessToken
          ? {
              Authorization: `Bearer ${parentAccessToken}`
            }
          : undefined
      });
      const data = await parseResponse(response);
      if (response.status === 401) {
        throw markSessionExpired();
      }
      if (!response.ok) {
        throw new Error(data.message || `Gift email resend failed (${response.status}).`);
      }

      setSessionRecoveryMessage('');
      setRedemptionUrl(String(data.redemptionUrl ?? ''));
      setGiftLinkState((data.giftLink as LatestGiftLink | undefined) ?? giftLinkState);
      const emailStatus = String(data.emailDelivery?.status ?? 'sent');
      setGiftActionMessage(
        emailStatus === 'failed'
          ? `Gift email resend failed: ${String(data.emailDelivery?.errorText ?? 'unknown error')}`
          : `Gift email resent (${emailStatus}).`
      );
    } catch (error) {
      setGiftActionMessage((error as Error).message);
    } finally {
      setGiftLoading(false);
    }
  }

  return (
    <section className="grid two">
      <article className="card">
        <h2>Parent Retry</h2>
        {sessionRecoveryMessage ? (
          <p>
            {sessionRecoveryMessage} <a href={recoveryHref}>Restore parent session</a>
          </p>
        ) : null}
        <p>
          Retries used: <strong>{retryPolicy.used}</strong> / {retryPolicy.limit} (remaining {retryPolicy.remaining})
        </p>
        {retryPolicy.reason ? <p>{retryPolicy.reason}</p> : null}
        <label htmlFor="retryReason">Retry Reason (optional)</label>
        <input
          id="retryReason"
          placeholder="Provider outage, try another pass"
          value={retryReason}
          onChange={(event) => setRetryReason(event.target.value)}
        />
        <button disabled={retryDisabled} onClick={retryRender}>
          Retry Render
        </button>
        {retryMessage ? <p>{retryMessage}</p> : null}
      </article>

      <article className="card">
        <h2>Gift Mode</h2>
        {sessionRecoveryMessage ? (
          <p>
            {sessionRecoveryMessage} <a href={recoveryHref}>Restore parent session</a>
          </p>
        ) : null}
        {giftLinkState ? (
          <>
            <p>
              Latest gift link status: <strong>{giftLinkState.status}</strong> (token suffix {giftLinkState.tokenHint})
            </p>
            <p>Expires: {new Date(giftLinkState.expiresAt).toLocaleString()}</p>
          </>
        ) : (
          <p>No gift link created for this order yet.</p>
        )}
        <label htmlFor="giftRecipient">Recipient Email</label>
        <input
          id="giftRecipient"
          type="email"
          placeholder="recipient@example.com"
          value={recipientEmail}
          onChange={(event) => setRecipientEmail(event.target.value)}
        />

        <label htmlFor="giftSender">Sender Name (optional)</label>
        <input id="giftSender" value={senderName} onChange={(event) => setSenderName(event.target.value)} />

        <label htmlFor="giftMessage">Gift Message (optional)</label>
        <textarea id="giftMessage" value={giftMessage} onChange={(event) => setGiftMessage(event.target.value)} />

        <label htmlFor="giftSendEmail">Send Redemption Email</label>
        <select
          id="giftSendEmail"
          value={sendEmail ? 'yes' : 'no'}
          onChange={(event) => setSendEmail(event.target.value === 'yes')}
        >
          <option value="yes">Yes, email the link</option>
          <option value="no">No, I will share it manually</option>
        </select>

        <button disabled={giftLoading || !parentAccessToken || Boolean(sessionRecoveryMessage)} onClick={createGiftLink}>
          {createGiftActionLabel}
        </button>
        <button disabled={resendGiftDisabled} onClick={resendGiftEmail}>
          Resend Gift Email
        </button>
        <button disabled={revokeGiftDisabled} onClick={revokeGiftLink}>
          Revoke Gift Link
        </button>

        {redemptionUrl ? (
          <p>
            Redemption URL: <a href={redemptionUrl}>{redemptionUrl}</a>
          </p>
        ) : null}
        {giftActionMessage ? <p>{giftActionMessage}</p> : null}
      </article>
    </section>
  );
}

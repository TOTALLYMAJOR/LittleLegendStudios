'use client';

import { useEffect, useState } from 'react';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

type NotificationType = 'delivery_ready' | 'render_failed' | 'gift_redeem_link';

interface EmailFailureResponse {
  filters: {
    orderId: string | null;
    notificationType: NotificationType | null;
    limit: number;
  };
  summary: {
    totalFailed: number;
    byType: Array<{
      notificationType: NotificationType;
      count: number;
    }>;
    byProvider: Array<{
      provider: string;
      count: number;
    }>;
  };
  failures: Array<{
    id: string;
    orderId: string;
    orderStatus: string;
    parentEmail: string;
    recipientEmail: string;
    notificationType: NotificationType;
    provider: string;
    providerMessageId: string | null;
    subject: string;
    errorText: string | null;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
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

function formatTypeLabel(value: NotificationType): string {
  switch (value) {
    case 'delivery_ready':
      return 'Delivery Ready';
    case 'render_failed':
      return 'Render Failed';
    case 'gift_redeem_link':
      return 'Gift Redeem Link';
  }
}

export default function AdminEmailFailuresPage(): JSX.Element {
  const [adminToken, setAdminToken] = useState('');
  const [orderId, setOrderId] = useState('');
  const [notificationType, setNotificationType] = useState<'all' | NotificationType>('all');
  const [limit, setLimit] = useState('25');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('Enter the admin token, then load recent failed email notifications.');
  const [data, setData] = useState<EmailFailureResponse | null>(null);
  const [isCompactViewport, setIsCompactViewport] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(max-width: 640px)');
    const updateViewport = (): void => setIsCompactViewport(mediaQuery.matches);
    updateViewport();

    mediaQuery.addEventListener('change', updateViewport);
    return () => mediaQuery.removeEventListener('change', updateViewport);
  }, []);

  async function loadFailures(): Promise<void> {
    if (!adminToken.trim()) {
      setMessage('Admin token is required.');
      return;
    }

    setLoading(true);
    setMessage('');

    const params = new URLSearchParams({
      limit
    });
    if (orderId.trim()) {
      params.set('orderId', orderId.trim());
    }
    if (notificationType !== 'all') {
      params.set('notificationType', notificationType);
    }

    try {
      const response = await fetch(`${apiBase}/admin/email-notifications/failures?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${adminToken.trim()}`
        },
        cache: 'no-store'
      });
      const payload = (await parseResponse(response)) as EmailFailureResponse | { message?: string };
      if (!response.ok) {
        const errorMessage = 'message' in payload ? payload.message : undefined;
        throw new Error(errorMessage || `Request failed (${response.status}).`);
      }

      setData(payload as EmailFailureResponse);
      setMessage(`Loaded ${String((payload as EmailFailureResponse).failures.length)} failed notifications.`);
    } catch (error) {
      setData(null);
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="admin-page">
      <section className="card admin-intro-card">
        <h1>Email Notification Failures</h1>
        <p>
          Admin visibility for rows in <span className="mono">email_notifications</span> with status{' '}
          <span className="mono">failed</span>.
        </p>
      </section>

      <section className="grid two">
        <article className="card">
          <h2>Access + Filters</h2>
          <label htmlFor="adminToken">Admin API Token</label>
          <input
            id="adminToken"
            type="password"
            placeholder="ADMIN_API_TOKEN"
            value={adminToken}
            onChange={(event) => setAdminToken(event.target.value)}
          />

          <label htmlFor="orderId">Order ID (optional)</label>
          <input
            id="orderId"
            placeholder="2d74c5a2-..."
            value={orderId}
            onChange={(event) => setOrderId(event.target.value)}
          />

          <label htmlFor="notificationType">Notification Type</label>
          <select
            id="notificationType"
            value={notificationType}
            onChange={(event) => setNotificationType(event.target.value as 'all' | NotificationType)}
          >
            <option value="all">All failed types</option>
            <option value="delivery_ready">Delivery Ready</option>
            <option value="render_failed">Render Failed</option>
            <option value="gift_redeem_link">Gift Redeem Link</option>
          </select>

          <label htmlFor="limit">Rows</label>
          <select id="limit" value={limit} onChange={(event) => setLimit(event.target.value)}>
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>

          <button disabled={loading} onClick={loadFailures}>
            {loading ? 'Loading Failures...' : 'Load Failures'}
          </button>
        </article>

        <article className="card">
          <h2>Summary</h2>
          {data ? (
            <>
              <p>
                Total failed notifications: <strong>{data.summary.totalFailed}</strong>
              </p>
              <div className="summary-grid">
                <div className="summary-block">
                  <h3>By Type</h3>
                  {data.summary.byType.length > 0 ? (
                    <ul>
                      {data.summary.byType.map((entry) => (
                        <li key={entry.notificationType}>
                          {formatTypeLabel(entry.notificationType)}: {entry.count}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No matching failures.</p>
                  )}
                </div>

                <div className="summary-block">
                  <h3>By Provider</h3>
                  {data.summary.byProvider.length > 0 ? (
                    <ul>
                      {data.summary.byProvider.map((entry) => (
                        <li key={entry.provider}>
                          {entry.provider}: {entry.count}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No matching failures.</p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <p>Run a query to load failure counts and the latest matching rows.</p>
          )}
        </article>
      </section>

      <section className="card admin-status-card">
        <span className="status-chip">Status</span>
        <p className="admin-status-message">{message}</p>
      </section>

      <section className="card">
        <h2>Latest Failed Notifications</h2>
        {!data ? <p>No data loaded yet.</p> : null}
        {data && data.failures.length === 0 ? <p>No failed notifications matched the current filters.</p> : null}
        {data && data.failures.length > 0 ? (
          isCompactViewport ? (
            <div className="mobile-data-list">
              {data.failures.map((failure) => (
                <article key={failure.id} className="mobile-data-card">
                  <div className="mobile-data-card-header">
                    <div>
                      <p className="mobile-data-kicker">Order</p>
                      <p className="mono mobile-data-value">{failure.orderId}</p>
                    </div>
                    <span className="status-chip warning">{formatTypeLabel(failure.notificationType)}</span>
                  </div>
                  <p className="mobile-data-value">Status: {failure.orderStatus}</p>
                  <p className="mobile-data-value">Parent: {failure.parentEmail}</p>
                  <p className="mobile-data-value">Recipient: {failure.recipientEmail}</p>
                  <p className="mobile-data-value">
                    Provider: {failure.provider}
                    {failure.providerMessageId ? ` (${failure.providerMessageId})` : ''}
                  </p>
                  <p className="mobile-data-value">Subject: {failure.subject}</p>
                  <p className="mobile-data-value">Created: {new Date(failure.createdAt).toLocaleString()}</p>
                  <p className="mobile-data-value">Error: {failure.errorText ?? 'No provider error text recorded.'}</p>
                  <details>
                    <summary>Payload</summary>
                    <pre>{JSON.stringify(failure.payload, null, 2)}</pre>
                  </details>
                </article>
              ))}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="col-hide-mobile">Created</th>
                    <th>Order</th>
                    <th>Type</th>
                    <th className="col-hide-tablet">Recipient</th>
                    <th className="col-hide-mobile">Provider</th>
                    <th className="col-hide-tablet">Subject</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {data.failures.map((failure) => (
                    <tr key={failure.id}>
                      <td className="col-hide-mobile">{new Date(failure.createdAt).toLocaleString()}</td>
                      <td>
                        <div className="mono">{failure.orderId}</div>
                        <div>{failure.orderStatus}</div>
                        <div>{failure.parentEmail}</div>
                      </td>
                      <td>{formatTypeLabel(failure.notificationType)}</td>
                      <td className="col-hide-tablet">{failure.recipientEmail}</td>
                      <td className="col-hide-mobile">
                        <div>{failure.provider}</div>
                        {failure.providerMessageId ? <div className="mono">{failure.providerMessageId}</div> : null}
                      </td>
                      <td className="col-hide-tablet">{failure.subject}</td>
                      <td>
                        <p>{failure.errorText ?? 'No provider error text recorded.'}</p>
                        <details>
                          <summary>Payload</summary>
                          <pre>{JSON.stringify(failure.payload, null, 2)}</pre>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </section>
    </main>
  );
}

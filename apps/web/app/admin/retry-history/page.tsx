'use client';

import { useEffect, useState } from 'react';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

type RetryActor = 'parent' | 'admin';

interface RetryHistoryResponse {
  filters: {
    orderId: string | null;
    actor: RetryActor | null;
    accepted: boolean | null;
    limit: number;
  };
  summary: {
    totalRequests: number;
    actorBreakdown: Array<{
      actor: RetryActor;
      count: number;
    }>;
    outcomeBreakdown: Array<{
      accepted: boolean;
      count: number;
    }>;
  };
  retryRequests: Array<{
    id: string;
    orderId: string;
    currentOrderStatus: string;
    parentEmail: string;
    actor: RetryActor;
    requestedStatus: string;
    accepted: boolean;
    reason: string | null;
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

function formatActorLabel(value: RetryActor): string {
  return value === 'admin' ? 'Admin' : 'Parent';
}

export default function AdminRetryHistoryPage(): JSX.Element {
  const [adminToken, setAdminToken] = useState('');
  const [orderId, setOrderId] = useState('');
  const [actor, setActor] = useState<'all' | RetryActor>('all');
  const [accepted, setAccepted] = useState<'all' | 'accepted' | 'rejected'>('all');
  const [limit, setLimit] = useState('25');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('Enter the admin token, then load retry request history.');
  const [data, setData] = useState<RetryHistoryResponse | null>(null);
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

  async function loadRetryHistory(): Promise<void> {
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
    if (actor !== 'all') {
      params.set('actor', actor);
    }
    if (accepted === 'accepted') {
      params.set('accepted', 'true');
    } else if (accepted === 'rejected') {
      params.set('accepted', 'false');
    }

    try {
      const response = await fetch(`${apiBase}/admin/retry-requests?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${adminToken.trim()}`
        },
        cache: 'no-store'
      });
      const payload = (await parseResponse(response)) as RetryHistoryResponse | { message?: string };
      if (!response.ok) {
        const errorMessage = 'message' in payload ? payload.message : undefined;
        throw new Error(errorMessage || `Request failed (${response.status}).`);
      }

      setData(payload as RetryHistoryResponse);
      setMessage(`Loaded ${String((payload as RetryHistoryResponse).retryRequests.length)} retry requests.`);
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
        <h1>Retry Request History</h1>
        <p>
          Admin visibility for rows in <span className="mono">order_retry_requests</span>, including accepted and rejected
          requests from parents and admins.
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

          <label htmlFor="actor">Actor</label>
          <select id="actor" value={actor} onChange={(event) => setActor(event.target.value as 'all' | RetryActor)}>
            <option value="all">All actors</option>
            <option value="parent">Parent</option>
            <option value="admin">Admin</option>
          </select>

          <label htmlFor="accepted">Outcome</label>
          <select
            id="accepted"
            value={accepted}
            onChange={(event) => setAccepted(event.target.value as 'all' | 'accepted' | 'rejected')}
          >
            <option value="all">Accepted + rejected</option>
            <option value="accepted">Accepted only</option>
            <option value="rejected">Rejected only</option>
          </select>

          <label htmlFor="limit">Rows</label>
          <select id="limit" value={limit} onChange={(event) => setLimit(event.target.value)}>
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>

          <button disabled={loading} onClick={loadRetryHistory}>
            {loading ? 'Loading Retry History...' : 'Load Retry History'}
          </button>
        </article>

        <article className="card">
          <h2>Summary</h2>
          {data ? (
            <>
              <p>
                Total retry requests: <strong>{data.summary.totalRequests}</strong>
              </p>
              <div className="summary-grid">
                <div className="summary-block">
                  <h3>By Actor</h3>
                  {data.summary.actorBreakdown.length > 0 ? (
                    <ul>
                      {data.summary.actorBreakdown.map((entry) => (
                        <li key={entry.actor}>
                          {formatActorLabel(entry.actor)}: {entry.count}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No matching retry requests.</p>
                  )}
                </div>

                <div className="summary-block">
                  <h3>By Outcome</h3>
                  {data.summary.outcomeBreakdown.length > 0 ? (
                    <ul>
                      {data.summary.outcomeBreakdown.map((entry) => (
                        <li key={String(entry.accepted)}>
                          {entry.accepted ? 'Accepted' : 'Rejected'}: {entry.count}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No matching retry requests.</p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <p>Run a query to load retry counts and the latest matching rows.</p>
          )}
        </article>
      </section>

      <section className="card admin-status-card">
        <span className="status-chip">Status</span>
        <p className="admin-status-message">{message}</p>
      </section>

      <section className="card">
        <h2>Latest Retry Requests</h2>
        {!data ? <p>No data loaded yet.</p> : null}
        {data && data.retryRequests.length === 0 ? <p>No retry requests matched the current filters.</p> : null}
        {data && data.retryRequests.length > 0 ? (
          isCompactViewport ? (
            <div className="mobile-data-list">
              {data.retryRequests.map((retry) => (
                <article key={retry.id} className="mobile-data-card">
                  <div className="mobile-data-card-header">
                    <div>
                      <p className="mobile-data-kicker">Order</p>
                      <p className="mono mobile-data-value">{retry.orderId}</p>
                    </div>
                    <span className={`status-chip ${retry.accepted ? 'success' : 'warning'}`}>
                      {retry.accepted ? 'Accepted' : 'Rejected'}
                    </span>
                  </div>
                  <p className="mobile-data-value">Created: {new Date(retry.createdAt).toLocaleString()}</p>
                  <p className="mobile-data-value">Actor: {formatActorLabel(retry.actor)}</p>
                  <p className="mobile-data-value">Current status: {retry.currentOrderStatus}</p>
                  <p className="mobile-data-value">Requested status: {retry.requestedStatus}</p>
                  <p className="mobile-data-value">Parent: {retry.parentEmail}</p>
                  <p className="mobile-data-value">Reason: {retry.reason ?? 'No reason provided.'}</p>
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
                    <th className="col-hide-tablet">Actor</th>
                    <th className="col-hide-mobile">Requested Status</th>
                    <th>Outcome</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {data.retryRequests.map((retry) => (
                    <tr key={retry.id}>
                      <td className="col-hide-mobile">{new Date(retry.createdAt).toLocaleString()}</td>
                      <td>
                        <div className="mono">{retry.orderId}</div>
                        <div>Current: {retry.currentOrderStatus}</div>
                        <div>{retry.parentEmail}</div>
                      </td>
                      <td className="col-hide-tablet">{formatActorLabel(retry.actor)}</td>
                      <td className="col-hide-mobile">{retry.requestedStatus}</td>
                      <td>
                        <span className={`status-chip ${retry.accepted ? 'success' : 'warning'}`}>
                          {retry.accepted ? 'Accepted' : 'Rejected'}
                        </span>
                      </td>
                      <td>{retry.reason ?? 'No reason provided.'}</td>
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

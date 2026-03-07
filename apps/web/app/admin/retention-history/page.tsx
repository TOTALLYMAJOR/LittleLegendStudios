'use client';

import { useState } from 'react';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

type TriggerSource = 'manual_parent' | 'manual_admin' | 'retention_sweep';
type PurgeOutcome = 'succeeded' | 'failed';

interface RetentionHistoryResponse {
  retention: {
    enabled: boolean;
    windowDays: number;
    intervalMs: number;
    batchLimit: number;
  };
  filters: {
    orderId: string | null;
    triggerSource: TriggerSource | null;
    outcome: PurgeOutcome | null;
    limit: number;
  };
  summary: {
    totalEvents: number;
    totalDeletedAssets: number;
    triggerBreakdown: Array<{
      triggerSource: TriggerSource;
      count: number;
    }>;
    outcomeBreakdown: Array<{
      outcome: PurgeOutcome;
      count: number;
    }>;
  };
  purgeEvents: Array<{
    id: string;
    orderId: string;
    parentEmail: string;
    triggerSource: TriggerSource;
    actor: 'parent' | 'admin' | null;
    previousOrderStatus: string;
    resultingOrderStatus: string;
    outcome: PurgeOutcome;
    deletedAssetCount: number;
    providerDeletion: {
      discoveredTargetCount?: number;
      attempted?: number;
      deleted?: number;
      skipped?: number;
      failed?: number;
      verified?: number;
      targets?: Array<{
        provider: string;
        target: string;
        targetType: string;
        identifierSource: string;
      }>;
      byProvider?: Array<{
        provider: string;
        discoveredTargetCount: number;
        attempted: number;
        deleted: number;
        skipped: number;
        failed: number;
        verified: number;
      }>;
      results?: Array<{
        provider: string;
        target: string;
        targetType: string;
        identifierSource: string;
        status: string;
        verification: string;
        detail: string;
      }>;
    };
    retentionWindowDays: number | null;
    errorText: string | null;
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

function formatTriggerLabel(value: TriggerSource): string {
  switch (value) {
    case 'manual_parent':
      return 'Manual Parent';
    case 'manual_admin':
      return 'Manual Admin';
    case 'retention_sweep':
      return 'Retention Sweep';
  }
}

function formatOutcomeLabel(value: PurgeOutcome): string {
  return value === 'succeeded' ? 'Succeeded' : 'Failed';
}

export default function AdminRetentionHistoryPage(): JSX.Element {
  const [adminToken, setAdminToken] = useState('');
  const [orderId, setOrderId] = useState('');
  const [triggerSource, setTriggerSource] = useState<'all' | TriggerSource>('all');
  const [outcome, setOutcome] = useState<'all' | PurgeOutcome>('all');
  const [limit, setLimit] = useState('25');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('Enter the admin token, then load purge and retention history.');
  const [data, setData] = useState<RetentionHistoryResponse | null>(null);

  async function loadHistory(): Promise<void> {
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
    if (triggerSource !== 'all') {
      params.set('triggerSource', triggerSource);
    }
    if (outcome !== 'all') {
      params.set('outcome', outcome);
    }

    try {
      const response = await fetch(`${apiBase}/admin/order-data-purges?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${adminToken.trim()}`
        },
        cache: 'no-store'
      });
      const payload = (await parseResponse(response)) as RetentionHistoryResponse | { message?: string };
      if (!response.ok) {
        const errorMessage = 'message' in payload ? payload.message : undefined;
        throw new Error(errorMessage || `Request failed (${response.status}).`);
      }

      const nextData = payload as RetentionHistoryResponse;
      setData(nextData);
      setMessage(`Loaded ${String(nextData.purgeEvents.length)} purge events.`);
    } catch (error) {
      setData(null);
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <section className="card">
        <h1>Retention + Purge History</h1>
        <p>
          Admin visibility for manual order-data deletions and automated retention sweeps recorded in{' '}
          <span className="mono">order_data_purge_events</span>.
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

          <label htmlFor="triggerSource">Trigger</label>
          <select
            id="triggerSource"
            value={triggerSource}
            onChange={(event) => setTriggerSource(event.target.value as 'all' | TriggerSource)}
          >
            <option value="all">All triggers</option>
            <option value="manual_parent">Manual Parent</option>
            <option value="manual_admin">Manual Admin</option>
            <option value="retention_sweep">Retention Sweep</option>
          </select>

          <label htmlFor="outcome">Outcome</label>
          <select id="outcome" value={outcome} onChange={(event) => setOutcome(event.target.value as 'all' | PurgeOutcome)}>
            <option value="all">Succeeded + failed</option>
            <option value="succeeded">Succeeded only</option>
            <option value="failed">Failed only</option>
          </select>

          <label htmlFor="limit">Rows</label>
          <select id="limit" value={limit} onChange={(event) => setLimit(event.target.value)}>
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>

          <button disabled={loading} onClick={loadHistory}>
            {loading ? 'Loading Purge History...' : 'Load Purge History'}
          </button>
        </article>

        <article className="card">
          <h2>Summary</h2>
          {data ? (
            <>
              <p>
                Total purge events: <strong>{data.summary.totalEvents}</strong>
              </p>
              <p>
                Total deleted assets: <strong>{data.summary.totalDeletedAssets}</strong>
              </p>
              <p>
                Retention automation: <strong>{data.retention.enabled ? 'Enabled' : 'Disabled'}</strong>
              </p>
              <p>
                Window: <strong>{data.retention.windowDays} days</strong> | Sweep interval:{' '}
                <strong>{Math.round(data.retention.intervalMs / 60000)} minutes</strong> | Batch limit:{' '}
                <strong>{data.retention.batchLimit}</strong>
              </p>
              <div className="summary-grid">
                <div className="summary-block">
                  <h3>By Trigger</h3>
                  {data.summary.triggerBreakdown.length > 0 ? (
                    <ul>
                      {data.summary.triggerBreakdown.map((entry) => (
                        <li key={entry.triggerSource}>
                          {formatTriggerLabel(entry.triggerSource)}: {entry.count}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No matching purge events.</p>
                  )}
                </div>

                <div className="summary-block">
                  <h3>By Outcome</h3>
                  {data.summary.outcomeBreakdown.length > 0 ? (
                    <ul>
                      {data.summary.outcomeBreakdown.map((entry) => (
                        <li key={entry.outcome}>
                          {formatOutcomeLabel(entry.outcome)}: {entry.count}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No matching purge events.</p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <p>Run a query to load purge counts and the latest retention outcomes.</p>
          )}
        </article>
      </section>

      <section className="card">
        <span className="status-chip">Status</span>
        <p>{message}</p>
      </section>

      <section className="card">
        <h2>Latest Purge Events</h2>
        {!data ? <p>No data loaded yet.</p> : null}
        {data && data.purgeEvents.length === 0 ? <p>No purge events matched the current filters.</p> : null}
        {data && data.purgeEvents.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Order</th>
                  <th>Trigger</th>
                  <th>Outcome</th>
                  <th>Deleted Assets</th>
                  <th>Provider Cleanup</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {data.purgeEvents.map((event) => (
                  <tr key={event.id}>
                    <td>{new Date(event.createdAt).toLocaleString()}</td>
                    <td>
                      <div className="mono">{event.orderId}</div>
                      <div>{event.parentEmail}</div>
                      <div>
                        {event.previousOrderStatus} to {event.resultingOrderStatus}
                      </div>
                    </td>
                    <td>
                      <div>{formatTriggerLabel(event.triggerSource)}</div>
                      {event.actor ? <div>Actor: {event.actor}</div> : null}
                      {event.retentionWindowDays !== null ? <div>Window: {event.retentionWindowDays} days</div> : null}
                    </td>
                    <td>
                      <span className={`status-chip ${event.outcome === 'succeeded' ? 'success' : 'warning'}`}>
                        {formatOutcomeLabel(event.outcome)}
                      </span>
                    </td>
                    <td>{event.deletedAssetCount}</td>
                    <td>
                      <div>Discovered: {event.providerDeletion.discoveredTargetCount ?? 0}</div>
                      <div>Attempted: {event.providerDeletion.attempted ?? 0}</div>
                      <div>Deleted: {event.providerDeletion.deleted ?? 0}</div>
                      <div>Skipped: {event.providerDeletion.skipped ?? 0}</div>
                      <div>Failed: {event.providerDeletion.failed ?? 0}</div>
                      <div>Verified: {event.providerDeletion.verified ?? 0}</div>
                      {event.providerDeletion.byProvider && event.providerDeletion.byProvider.length > 0 ? (
                        <details>
                          <summary>By provider</summary>
                          <pre>{JSON.stringify(event.providerDeletion.byProvider, null, 2)}</pre>
                        </details>
                      ) : null}
                      {event.providerDeletion.targets && event.providerDeletion.targets.length > 0 ? (
                        <details>
                          <summary>Discovered targets</summary>
                          <pre>{JSON.stringify(event.providerDeletion.targets, null, 2)}</pre>
                        </details>
                      ) : null}
                      {event.providerDeletion.results && event.providerDeletion.results.length > 0 ? (
                        <details>
                          <summary>Provider results</summary>
                          <pre>{JSON.stringify(event.providerDeletion.results, null, 2)}</pre>
                        </details>
                      ) : null}
                    </td>
                    <td>{event.errorText ?? 'No error recorded.'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </main>
  );
}

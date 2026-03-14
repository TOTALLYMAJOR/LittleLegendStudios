'use client';

import { useMemo, useState } from 'react';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

interface ProviderTask {
  providerTaskId: string;
  provider: string;
  orderId: string | null;
  jobType: string | null;
  status: 'queued' | 'processing' | 'succeeded' | 'failed';
  artifactKey: string | null;
  output: Record<string, unknown>;
  errorText: string | null;
  lastPolledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProviderTaskListResponse {
  count: number;
  tasks: ProviderTask[];
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

function buildAuthHeaders(providerToken: string): HeadersInit | undefined {
  if (!providerToken.trim()) {
    return undefined;
  }

  return {
    Authorization: `Bearer ${providerToken.trim()}`
  };
}

export default function AdminProviderTaskTriagePage(): JSX.Element {
  const [providerToken, setProviderToken] = useState('');
  const [orderId, setOrderId] = useState('');
  const [provider, setProvider] = useState('');
  const [limit, setLimit] = useState('50');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('Load failed provider tasks to inspect provider errors and retry individual tasks.');
  const [tasks, setTasks] = useState<ProviderTask[]>([]);
  const [activeTaskId, setActiveTaskId] = useState('');

  const providerSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      counts.set(task.provider, (counts.get(task.provider) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  }, [tasks]);

  const jobTypeSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const key = task.jobType ?? 'unknown';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  }, [tasks]);

  async function loadFailedTasks(): Promise<void> {
    setLoading(true);
    setMessage('');

    const params = new URLSearchParams({
      status: 'failed',
      limit
    });
    if (orderId.trim()) {
      params.set('orderId', orderId.trim());
    }
    if (provider.trim()) {
      params.set('provider', provider.trim());
    }

    try {
      const response = await fetch(`${apiBase}/provider-tasks?${params.toString()}`, {
        headers: buildAuthHeaders(providerToken),
        cache: 'no-store'
      });
      const payload = (await parseResponse(response)) as ProviderTaskListResponse | { message?: string };
      if (!response.ok) {
        const errorMessage = 'message' in payload ? payload.message : undefined;
        throw new Error(errorMessage || `Request failed (${response.status}).`);
      }

      const nextTasks = (payload as ProviderTaskListResponse).tasks;
      setTasks(nextTasks);
      setMessage(`Loaded ${String(nextTasks.length)} failed provider tasks.`);
    } catch (error) {
      setTasks([]);
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshTask(providerTaskId: string): Promise<void> {
    setActiveTaskId(providerTaskId);
    setMessage('');

    try {
      const response = await fetch(`${apiBase}/provider-tasks/${providerTaskId}`, {
        headers: buildAuthHeaders(providerToken),
        cache: 'no-store'
      });
      const payload = (await parseResponse(response)) as ProviderTask | { message?: string };
      if (!response.ok) {
        const errorMessage = 'message' in payload ? payload.message : undefined;
        throw new Error(errorMessage || `Refresh failed (${response.status}).`);
      }

      const refreshed = payload as ProviderTask;
      setTasks((current) =>
        current
          .map((task) => (task.providerTaskId === providerTaskId ? refreshed : task))
          .filter((task) => task.status === 'failed')
      );
      setMessage(`Refreshed provider task ${providerTaskId}.`);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setActiveTaskId('');
    }
  }

  async function retryTask(providerTaskId: string): Promise<void> {
    setActiveTaskId(providerTaskId);
    setMessage('');

    try {
      const response = await fetch(`${apiBase}/provider-tasks/${providerTaskId}/retry`, {
        method: 'POST',
        headers: buildAuthHeaders(providerToken)
      });
      const payload = (await parseResponse(response)) as ProviderTask | { message?: string };
      if (!response.ok) {
        const errorMessage = 'message' in payload ? payload.message : undefined;
        throw new Error(errorMessage || `Retry failed (${response.status}).`);
      }

      const retried = payload as ProviderTask;
      setTasks((current) => current.filter((task) => task.providerTaskId !== providerTaskId));
      setMessage(`Retry requested for provider task ${retried.providerTaskId}; it moved to ${retried.status}.`);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setActiveTaskId('');
    }
  }

  return (
    <main className="admin-page">
      <section className="card admin-intro-card">
        <h1>Provider Task Failure Triage</h1>
        <p>
          Operational view for failed rows from <span className="mono">provider_tasks</span>. Filter by order/provider,
          inspect error payloads, refresh current state, and retry failed tasks.
        </p>
      </section>

      <section className="grid two">
        <article className="card">
          <h2>Access + Filters</h2>
          <label htmlFor="providerToken">Provider Auth Token (optional)</label>
          <input
            id="providerToken"
            type="password"
            placeholder="PROVIDER_AUTH_TOKEN"
            value={providerToken}
            onChange={(event) => setProviderToken(event.target.value)}
          />

          <label htmlFor="orderId">Order ID (optional)</label>
          <input
            id="orderId"
            placeholder="2d74c5a2-..."
            value={orderId}
            onChange={(event) => setOrderId(event.target.value)}
          />

          <label htmlFor="provider">Provider (optional)</label>
          <input
            id="provider"
            placeholder="elevenlabs / heygen / shotstack / stub"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          />

          <label htmlFor="limit">Rows</label>
          <select id="limit" value={limit} onChange={(event) => setLimit(event.target.value)}>
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
          </select>

          <button disabled={loading} onClick={loadFailedTasks}>
            {loading ? 'Loading Failed Tasks...' : 'Load Failed Tasks'}
          </button>
        </article>

        <article className="card">
          <h2>Summary</h2>
          {tasks.length === 0 ? (
            <p>No failed tasks loaded yet.</p>
          ) : (
            <>
              <p>
                Loaded failed tasks: <strong>{tasks.length}</strong>
              </p>
              <div className="summary-grid">
                <div className="summary-block">
                  <h3>By Provider</h3>
                  <ul>
                    {providerSummary.map((entry) => (
                      <li key={entry.name}>
                        {entry.name}: {entry.count}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="summary-block">
                  <h3>By Job Type</h3>
                  <ul>
                    {jobTypeSummary.map((entry) => (
                      <li key={entry.name}>
                        {entry.name}: {entry.count}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </>
          )}
        </article>
      </section>

      <section className="card admin-status-card">
        <span className="status-chip">Status</span>
        <p className="admin-status-message">{message}</p>
      </section>

      <section className="card">
        <h2>Failed Provider Tasks</h2>
        {tasks.length === 0 ? (
          <p>No failed provider tasks matched the current filters.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="col-hide-mobile">Updated</th>
                  <th>Provider Task</th>
                  <th>Order</th>
                  <th className="col-hide-tablet">Provider</th>
                  <th>Error</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.providerTaskId}>
                    <td className="col-hide-mobile">
                      <div>{new Date(task.updatedAt).toLocaleString()}</div>
                      {task.lastPolledAt ? <div>Polled: {new Date(task.lastPolledAt).toLocaleString()}</div> : null}
                    </td>
                    <td>
                      <div className="mono">{task.providerTaskId}</div>
                      <div>{task.jobType ?? 'unknown'}</div>
                      {task.artifactKey ? <div className="mono">{task.artifactKey}</div> : null}
                    </td>
                    <td>{task.orderId ? <span className="mono">{task.orderId}</span> : 'None'}</td>
                    <td className="col-hide-tablet">{task.provider}</td>
                    <td>
                      <p>{task.errorText ?? 'No provider error text recorded.'}</p>
                      <details>
                        <summary>Output</summary>
                        <pre>{JSON.stringify(task.output, null, 2)}</pre>
                      </details>
                    </td>
                    <td>
                      <div className="admin-inline-actions">
                        <button disabled={Boolean(activeTaskId)} onClick={() => refreshTask(task.providerTaskId)}>
                          {activeTaskId === task.providerTaskId ? 'Working...' : 'Refresh'}
                        </button>
                        <button disabled={Boolean(activeTaskId)} onClick={() => retryTask(task.providerTaskId)}>
                          {activeTaskId === task.providerTaskId ? 'Working...' : 'Retry'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

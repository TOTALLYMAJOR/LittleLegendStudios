'use client';

import { useMemo, useState } from 'react';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

interface WorkerHeartbeatRow {
  workerId: string;
  serviceName: string;
  status: 'idle' | 'processing' | 'error';
  activeJobs: number;
  latestOrderId: string | null;
  lastHeartbeatAt: string;
  updatedAt: string;
  ageSec: number | null;
  stale: boolean;
  meta?: Record<string, unknown>;
}

interface WorkerHealthResponse {
  ok: boolean;
  staleAfterSec?: number;
  activeWorkers?: number;
  processingWorkers?: number;
  latestHeartbeatAt?: string | null;
  workerCount?: number;
  workers?: WorkerHeartbeatRow[];
  checkedAt?: string;
  message?: string;
}

interface QueueDeadLetterResponse {
  queue: {
    name: string;
    failedCount: number;
    waitingCount: number;
    activeCount: number;
    delayedCount: number;
  };
  failedJobs: Array<{
    jobId: string;
    name: string;
    attemptsMade: number;
    maxAttempts: number;
    failedReason: string | null;
    data: Record<string, unknown>;
    timestamp: number;
    processedOn: number | null;
    finishedOn: number | null;
  }>;
  recentFailedSteps: Array<{
    order_id: string;
    type: string;
    attempt: number;
    provider: string;
    error_text: string | null;
    finished_at: string | null;
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

function buildAdminHeaders(adminToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${adminToken.trim()}`
  };
}

function formatMillisTimestamp(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 'n/a';
  }
  return new Date(value).toLocaleString();
}

function formatIsoTimestamp(value: string | null | undefined): string {
  if (!value) {
    return 'n/a';
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(timestamp).toLocaleString();
}

export default function AdminRenderIncidentPage(): JSX.Element {
  const [adminToken, setAdminToken] = useState('');
  const [limit, setLimit] = useState('25');
  const [loading, setLoading] = useState(false);
  const [activeRetryJobId, setActiveRetryJobId] = useState('');
  const [message, setMessage] = useState('Enter admin token, then load render incident diagnostics.');
  const [workerHealth, setWorkerHealth] = useState<WorkerHealthResponse | null>(null);
  const [workerHealthError, setWorkerHealthError] = useState<string | null>(null);
  const [queueData, setQueueData] = useState<QueueDeadLetterResponse | null>(null);

  const incidentStatusClass = useMemo(() => {
    const hasWorkerRisk = workerHealth ? !workerHealth.ok : Boolean(workerHealthError);
    const failedCount = queueData?.queue.failedCount ?? 0;
    if (hasWorkerRisk || failedCount > 0) {
      return 'status-chip warning';
    }
    if (workerHealth?.ok && queueData) {
      return 'status-chip success';
    }
    return 'status-chip';
  }, [queueData, workerHealth, workerHealthError]);

  async function loadIncidentSnapshot(): Promise<void> {
    if (!adminToken.trim()) {
      setMessage('Admin token is required.');
      return;
    }

    setLoading(true);
    setMessage('');

    try {
      const queueResponse = await fetch(`${apiBase}/admin/queue/render/dead-letter?limit=${encodeURIComponent(limit)}`, {
        headers: buildAdminHeaders(adminToken),
        cache: 'no-store'
      });
      const queuePayload = (await parseResponse(queueResponse)) as QueueDeadLetterResponse | { message?: string };
      if (!queueResponse.ok) {
        const errorMessage = 'message' in queuePayload ? queuePayload.message : undefined;
        throw new Error(errorMessage || `Dead-letter request failed (${queueResponse.status}).`);
      }
      setQueueData(queuePayload as QueueDeadLetterResponse);

      try {
        const workerResponse = await fetch(`${apiBase}/health/worker`, {
          cache: 'no-store'
        });
        const workerPayload = (await parseResponse(workerResponse)) as WorkerHealthResponse | { message?: string };
        if ('ok' in workerPayload && typeof workerPayload.ok === 'boolean') {
          setWorkerHealth(workerPayload as WorkerHealthResponse);
          setWorkerHealthError(null);
        } else if (!workerResponse.ok) {
          setWorkerHealth(null);
          setWorkerHealthError(
            ('message' in workerPayload ? workerPayload.message : undefined) ||
              `Worker health request failed (${workerResponse.status}).`
          );
        } else {
          setWorkerHealth(null);
          setWorkerHealthError('Worker health response shape was invalid.');
        }
      } catch (error) {
        setWorkerHealth(null);
        setWorkerHealthError((error as Error).message || 'Worker health request failed.');
      }

      setMessage(
        `Loaded render incident snapshot. Queue failed=${String((queuePayload as QueueDeadLetterResponse).queue.failedCount)}, waiting=${String((queuePayload as QueueDeadLetterResponse).queue.waitingCount)}.`
      );
    } catch (error) {
      setQueueData(null);
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function retryFailedJob(jobId: string): Promise<void> {
    if (!adminToken.trim()) {
      setMessage('Admin token is required before retrying queue jobs.');
      return;
    }

    setActiveRetryJobId(jobId);
    setMessage('');

    try {
      const response = await fetch(`${apiBase}/admin/queue/render/dead-letter/${encodeURIComponent(jobId)}/retry`, {
        method: 'POST',
        headers: buildAdminHeaders(adminToken)
      });
      const payload = (await parseResponse(response)) as { message?: string; queued?: boolean };
      if (!response.ok) {
        throw new Error(payload.message || `Retry request failed (${response.status}).`);
      }

      setMessage(`Retry queued for job ${jobId}. Refreshing snapshot...`);
      await loadIncidentSnapshot();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setActiveRetryJobId('');
    }
  }

  return (
    <main>
      <section className="card">
        <h1>Render Incident Dashboard</h1>
        <p>
          Combines worker heartbeat health and render queue dead-letter visibility so operators can quickly confirm whether
          paid orders should progress or need intervention.
        </p>
      </section>

      <section className="grid two">
        <article className="card">
          <h2>Access + Snapshot Controls</h2>
          <label htmlFor="adminToken">Admin API Token</label>
          <input
            id="adminToken"
            type="password"
            placeholder="ADMIN_API_TOKEN"
            value={adminToken}
            onChange={(event) => setAdminToken(event.target.value)}
          />

          <label htmlFor="limit">Rows</label>
          <select id="limit" value={limit} onChange={(event) => setLimit(event.target.value)}>
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>

          <button disabled={loading} onClick={loadIncidentSnapshot}>
            {loading ? 'Loading Snapshot...' : 'Load Incident Snapshot'}
          </button>
        </article>

        <article className="card">
          <h2>Snapshot Summary</h2>
          <p className={incidentStatusClass}>
            Incident state:{' '}
            {workerHealth && queueData
              ? workerHealth.ok && queueData.queue.failedCount === 0
                ? 'healthy'
                : 'attention needed'
              : 'unknown'}
          </p>
          <ul>
            <li>Worker health: {workerHealth ? (workerHealth.ok ? 'online' : 'offline/stale') : workerHealthError ? 'error' : 'unknown'}</li>
            <li>Active workers: {workerHealth?.activeWorkers ?? 0}</li>
            <li>Processing workers: {workerHealth?.processingWorkers ?? 0}</li>
            <li>Queue failed jobs: {queueData?.queue.failedCount ?? 0}</li>
            <li>Queue waiting jobs: {queueData?.queue.waitingCount ?? 0}</li>
            <li>Queue active jobs: {queueData?.queue.activeCount ?? 0}</li>
          </ul>
          {workerHealthError ? <p>{workerHealthError}</p> : null}
        </article>
      </section>

      <section className="card">
        <span className={incidentStatusClass}>Status</span>
        <p>{message}</p>
      </section>

      <section className="card">
        <h2>Worker Heartbeats</h2>
        {!workerHealth && !workerHealthError ? <p>No worker snapshot loaded yet.</p> : null}
        {workerHealthError ? <p>{workerHealthError}</p> : null}
        {workerHealth ? (
          <>
            <p>
              stale_after_sec: <strong>{workerHealth.staleAfterSec ?? 'n/a'}</strong> | checked_at:{' '}
              <strong>{formatIsoTimestamp(workerHealth.checkedAt)}</strong>
            </p>
            {!workerHealth.workers || workerHealth.workers.length === 0 ? (
              <p>No worker heartbeat rows found.</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Worker</th>
                      <th>Status</th>
                      <th>Active Jobs</th>
                      <th>Latest Order</th>
                      <th>Age (sec)</th>
                      <th>Heartbeat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workerHealth.workers.map((worker) => (
                      <tr key={worker.workerId}>
                        <td>
                          <div className="mono">{worker.workerId}</div>
                          <div>{worker.serviceName}</div>
                        </td>
                        <td>
                          <span className={`status-chip ${worker.stale || worker.status === 'error' ? 'warning' : 'success'}`}>
                            {worker.status}
                            {worker.stale ? ' (stale)' : ''}
                          </span>
                        </td>
                        <td>{worker.activeJobs}</td>
                        <td className="mono">{worker.latestOrderId ?? 'n/a'}</td>
                        <td>{worker.ageSec ?? 'n/a'}</td>
                        <td>{formatIsoTimestamp(worker.lastHeartbeatAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </section>

      <section className="card">
        <h2>Render Queue Dead-Letter</h2>
        {!queueData ? (
          <p>No queue snapshot loaded yet.</p>
        ) : (
          <>
            <p>
              queue: <strong>{queueData.queue.name}</strong> | failed: <strong>{queueData.queue.failedCount}</strong> |
              waiting: <strong>{queueData.queue.waitingCount}</strong> | active: <strong>{queueData.queue.activeCount}</strong>{' '}
              | delayed: <strong>{queueData.queue.delayedCount}</strong>
            </p>
            {queueData.failedJobs.length === 0 ? (
              <p>No failed queue jobs in the selected window.</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Queue Job</th>
                      <th>Order</th>
                      <th>Reason</th>
                      <th>Attempts</th>
                      <th>Finished</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queueData.failedJobs.map((job) => {
                      const orderId = typeof job.data?.orderId === 'string' ? job.data.orderId : null;
                      return (
                        <tr key={job.jobId}>
                          <td>
                            <div className="mono">{job.jobId}</div>
                            <div>{job.name}</div>
                          </td>
                          <td className="mono">{orderId ?? 'n/a'}</td>
                          <td>
                            <p>{job.failedReason ?? 'No failure reason recorded.'}</p>
                          </td>
                          <td>
                            {job.attemptsMade}/{job.maxAttempts}
                          </td>
                          <td>{formatMillisTimestamp(job.finishedOn)}</td>
                          <td>
                            <button disabled={Boolean(activeRetryJobId) || loading} onClick={() => retryFailedJob(job.jobId)}>
                              {activeRetryJobId === job.jobId ? 'Retrying...' : 'Retry'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h2>Recent Failed Pipeline Steps</h2>
        {!queueData ? (
          <p>No data loaded yet.</p>
        ) : queueData.recentFailedSteps.length === 0 ? (
          <p>No recent failed pipeline steps were found.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Finished</th>
                  <th>Order</th>
                  <th>Step</th>
                  <th>Provider</th>
                  <th>Attempt</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {queueData.recentFailedSteps.map((step, index) => (
                  <tr key={`${step.order_id}-${step.type}-${step.attempt}-${index}`}>
                    <td>{formatIsoTimestamp(step.finished_at)}</td>
                    <td className="mono">{step.order_id}</td>
                    <td>{step.type}</td>
                    <td>{step.provider}</td>
                    <td>{step.attempt}</td>
                    <td>{step.error_text ?? 'No error text recorded.'}</td>
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

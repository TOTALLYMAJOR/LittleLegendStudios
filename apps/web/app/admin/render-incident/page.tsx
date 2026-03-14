'use client';

import { useEffect, useMemo, useState } from 'react';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

type SnapshotSource = 'manual' | 'auto' | 'retry';

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
  filters?: {
    orderId: string | null;
    failedReason: string | null;
  };
  pagination?: {
    page: number;
    limit: number;
    offset: number;
    totalMatchedFailedJobs: number;
    totalPages: number;
    hasPrevPage: boolean;
    hasNextPage: boolean;
    mode: 'direct' | 'filtered_scan';
    scanCount: number | null;
    scanTruncated: boolean;
  };
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
  recentFailedStepsPagination?: {
    page: number;
    limit: number;
    offset: number;
    total: number;
    totalPages: number;
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
  const [autoRefreshIntervalSec, setAutoRefreshIntervalSec] = useState('off');
  const [loading, setLoading] = useState(false);
  const [autoRefreshing, setAutoRefreshing] = useState(false);
  const [activeRetryJobId, setActiveRetryJobId] = useState('');
  const [message, setMessage] = useState('Enter admin token, then load render incident diagnostics.');
  const [workerHealth, setWorkerHealth] = useState<WorkerHealthResponse | null>(null);
  const [workerHealthError, setWorkerHealthError] = useState<string | null>(null);
  const [queueData, setQueueData] = useState<QueueDeadLetterResponse | null>(null);
  const [lastSnapshotAtIso, setLastSnapshotAtIso] = useState<string | null>(null);
  const [lastAutoRefreshAtIso, setLastAutoRefreshAtIso] = useState<string | null>(null);
  const [failedJobOrderFilter, setFailedJobOrderFilter] = useState('');
  const [failedJobReasonFilter, setFailedJobReasonFilter] = useState('');
  const [failedJobPage, setFailedJobPage] = useState(1);
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

  const incidentSeverity = useMemo(() => {
    const failedCount = queueData?.queue.failedCount ?? 0;
    const waitingCount = queueData?.queue.waitingCount ?? 0;
    const activeCount = queueData?.queue.activeCount ?? 0;

    if (workerHealthError) {
      return {
        label: 'critical',
        className: 'status-chip critical',
        detail: 'Worker health check failed.'
      };
    }

    if (workerHealth && !workerHealth.ok) {
      return {
        label: 'critical',
        className: 'status-chip critical',
        detail: 'No fresh worker heartbeat detected.'
      };
    }

    if (failedCount >= 25) {
      return {
        label: 'critical',
        className: 'status-chip critical',
        detail: `Render queue has ${String(failedCount)} failed jobs.`
      };
    }

    if (failedCount > 0) {
      return {
        label: 'warning',
        className: 'status-chip warning',
        detail: `Render queue has ${String(failedCount)} failed jobs.`
      };
    }

    if (queueData && waitingCount > 0 && activeCount === 0) {
      return {
        label: 'warning',
        className: 'status-chip warning',
        detail: 'Queue has waiting jobs but no active workers.'
      };
    }

    if (workerHealth?.ok && queueData) {
      return {
        label: 'healthy',
        className: 'status-chip success',
        detail: 'Worker heartbeat and queue health are both in a healthy range.'
      };
    }

    return {
      label: 'unknown',
      className: 'status-chip',
      detail: 'Load a snapshot to evaluate incident state.'
    };
  }, [queueData, workerHealth, workerHealthError]);

  const pagination = queueData?.pagination;
  const totalMatchedFailedJobs = pagination?.totalMatchedFailedJobs ?? queueData?.failedJobs.length ?? 0;
  const failedJobTotalPages = Math.max(1, pagination?.totalPages ?? 1);

  async function loadIncidentSnapshot(args?: {
    source?: SnapshotSource;
    quiet?: boolean;
    pageOverride?: number;
    orderIdOverride?: string;
    failedReasonOverride?: string;
  }): Promise<void> {
    const source = args?.source ?? 'manual';
    const quiet = args?.quiet ?? false;
    const effectivePage = Math.max(1, args?.pageOverride ?? failedJobPage);
    const effectiveOrderFilter = (args?.orderIdOverride ?? failedJobOrderFilter).trim();
    const effectiveReasonFilter = (args?.failedReasonOverride ?? failedJobReasonFilter).trim();

    if (!adminToken.trim()) {
      if (!quiet) {
        setMessage('Admin token is required.');
      }
      return;
    }

    if (source === 'auto') {
      setAutoRefreshing(true);
    } else {
      setLoading(true);
    }

    if (!quiet) {
      setMessage('');
    }

    try {
      const deadLetterParams = new URLSearchParams({
        limit,
        page: String(effectivePage)
      });
      if (effectiveOrderFilter) {
        deadLetterParams.set('orderId', effectiveOrderFilter);
      }
      if (effectiveReasonFilter) {
        deadLetterParams.set('failedReason', effectiveReasonFilter);
      }

      const queueResponse = await fetch(`${apiBase}/admin/queue/render/dead-letter?${deadLetterParams.toString()}`, {
        headers: buildAdminHeaders(adminToken),
        cache: 'no-store'
      });
      const queuePayload = (await parseResponse(queueResponse)) as QueueDeadLetterResponse | { message?: string };
      if (!queueResponse.ok) {
        const errorMessage = 'message' in queuePayload ? queuePayload.message : undefined;
        throw new Error(errorMessage || `Dead-letter request failed (${queueResponse.status}).`);
      }

      const normalizedQueuePayload = queuePayload as QueueDeadLetterResponse;
      setQueueData(normalizedQueuePayload);
      setFailedJobPage(normalizedQueuePayload.pagination?.page ?? effectivePage);

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

      const nowIso = new Date().toISOString();
      setLastSnapshotAtIso(nowIso);
      if (source === 'auto') {
        setLastAutoRefreshAtIso(nowIso);
      }

      if (!quiet) {
        const matchedCount = normalizedQueuePayload.pagination?.totalMatchedFailedJobs ?? normalizedQueuePayload.failedJobs.length;
        setMessage(
          `Loaded render incident snapshot. Queue failed=${String(normalizedQueuePayload.queue.failedCount)}, matched=${String(matchedCount)}, waiting=${String(normalizedQueuePayload.queue.waitingCount)}.`
        );
      }
    } catch (error) {
      if (source !== 'auto') {
        setQueueData(null);
      }
      const errorMessage = (error as Error).message;
      setMessage(source === 'auto' ? `Auto-refresh failed: ${errorMessage}` : errorMessage);
    } finally {
      if (source === 'auto') {
        setAutoRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    if (autoRefreshIntervalSec === 'off') {
      return;
    }
    if (!adminToken.trim()) {
      return;
    }

    const intervalMs = Number(autoRefreshIntervalSec) * 1000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadIncidentSnapshot({ source: 'auto', quiet: true });
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [adminToken, autoRefreshIntervalSec, limit, failedJobPage, failedJobOrderFilter, failedJobReasonFilter]);

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
      await loadIncidentSnapshot({ source: 'retry' });
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setActiveRetryJobId('');
    }
  }

  async function goToFailedJobPage(nextPage: number): Promise<void> {
    const boundedPage = Math.max(1, Math.min(failedJobTotalPages, nextPage));
    setFailedJobPage(boundedPage);
    await loadIncidentSnapshot({ source: 'manual', pageOverride: boundedPage });
  }

  return (
    <main className="admin-page">
      <section className="card admin-intro-card">
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

          <label htmlFor="limit">Rows Per Page</label>
          <select
            id="limit"
            value={limit}
            onChange={(event) => {
              setLimit(event.target.value);
              setFailedJobPage(1);
            }}
          >
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>

          <label htmlFor="autoRefreshIntervalSec">Auto Refresh</label>
          <select
            id="autoRefreshIntervalSec"
            value={autoRefreshIntervalSec}
            onChange={(event) => setAutoRefreshIntervalSec(event.target.value)}
          >
            <option value="off">Off</option>
            <option value="15">Every 15s</option>
            <option value="30">Every 30s</option>
            <option value="60">Every 60s</option>
          </select>

          <button disabled={loading} onClick={() => void loadIncidentSnapshot({ source: 'manual', pageOverride: 1 })}>
            {loading ? 'Loading Snapshot...' : 'Load Incident Snapshot'}
          </button>
          <p className={autoRefreshIntervalSec === 'off' ? 'status-chip' : 'status-chip success'}>
            Auto-refresh: {autoRefreshIntervalSec === 'off' ? 'off' : `every ${autoRefreshIntervalSec}s`}
            {autoRefreshing ? ' (refreshing...)' : ''}
          </p>
          <p>
            Last snapshot: <strong>{formatIsoTimestamp(lastSnapshotAtIso)}</strong>
          </p>
          <p>
            Last auto-refresh: <strong>{formatIsoTimestamp(lastAutoRefreshAtIso)}</strong>
          </p>
        </article>

        <article className="card">
          <h2>Snapshot Summary</h2>
          <p className={incidentSeverity.className}>Incident state: {incidentSeverity.label}</p>
          <p>{incidentSeverity.detail}</p>
          <ul>
            <li>
              Worker health: {workerHealth ? (workerHealth.ok ? 'online' : 'offline/stale') : workerHealthError ? 'error' : 'unknown'}
            </li>
            <li>Active workers: {workerHealth?.activeWorkers ?? 0}</li>
            <li>Processing workers: {workerHealth?.processingWorkers ?? 0}</li>
            <li>Queue failed jobs: {queueData?.queue.failedCount ?? 0}</li>
            <li>Queue waiting jobs: {queueData?.queue.waitingCount ?? 0}</li>
            <li>Queue active jobs: {queueData?.queue.activeCount ?? 0}</li>
          </ul>
          {workerHealthError ? <p>{workerHealthError}</p> : null}
        </article>
      </section>

      <section className="card admin-status-card">
        <span className={incidentSeverity.className}>Status</span>
        <p className="admin-status-message">{message}</p>
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
              isCompactViewport ? (
                <div className="mobile-data-list">
                  {workerHealth.workers.map((worker) => (
                    <article key={worker.workerId} className="mobile-data-card">
                      <div className="mobile-data-card-header">
                        <div>
                          <p className="mobile-data-kicker">Worker</p>
                          <p className="mono mobile-data-value">{worker.workerId}</p>
                        </div>
                        <span className={`status-chip ${worker.stale || worker.status === 'error' ? 'warning' : 'success'}`}>
                          {worker.status}
                          {worker.stale ? ' (stale)' : ''}
                        </span>
                      </div>
                      <p className="mobile-data-value">{worker.serviceName}</p>
                      <p className="mobile-data-value">Active jobs: {worker.activeJobs}</p>
                      <p className="mobile-data-value">Latest order: {worker.latestOrderId ?? 'n/a'}</p>
                      <p className="mobile-data-value">Age (sec): {worker.ageSec ?? 'n/a'}</p>
                      <p className="mobile-data-value">Heartbeat: {formatIsoTimestamp(worker.lastHeartbeatAt)}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Worker</th>
                        <th>Status</th>
                        <th>Active Jobs</th>
                        <th className="col-hide-tablet">Latest Order</th>
                        <th className="col-hide-mobile">Age (sec)</th>
                        <th className="col-hide-tablet">Heartbeat</th>
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
                          <td className="mono col-hide-tablet">{worker.latestOrderId ?? 'n/a'}</td>
                          <td className="col-hide-mobile">{worker.ageSec ?? 'n/a'}</td>
                          <td className="col-hide-tablet">{formatIsoTimestamp(worker.lastHeartbeatAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
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
            <div className="grid two">
              <div>
                <label htmlFor="failedJobOrderFilter">Filter by Order ID</label>
                <input
                  id="failedJobOrderFilter"
                  placeholder="order uuid contains..."
                  value={failedJobOrderFilter}
                  onChange={(event) => setFailedJobOrderFilter(event.target.value)}
                />
              </div>
              <div>
                <label htmlFor="failedJobReasonFilter">Filter by Reason Text</label>
                <input
                  id="failedJobReasonFilter"
                  placeholder="timeout / provider / validation..."
                  value={failedJobReasonFilter}
                  onChange={(event) => setFailedJobReasonFilter(event.target.value)}
                />
              </div>
            </div>
            <div className="grid two">
              <div>
                <label htmlFor="failedJobPage">Page</label>
                <div className="admin-inline-actions">
                  <button
                    disabled={!(pagination?.hasPrevPage ?? false)}
                    onClick={() => void goToFailedJobPage((pagination?.page ?? failedJobPage) - 1)}
                  >
                    Prev
                  </button>
                  <span className="mono">
                    {pagination?.page ?? failedJobPage}/{failedJobTotalPages}
                  </span>
                  <button
                    disabled={!(pagination?.hasNextPage ?? false)}
                    onClick={() => void goToFailedJobPage((pagination?.page ?? failedJobPage) + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
              <div>
                <label>Actions</label>
                <div className="admin-inline-actions">
                  <button onClick={() => void loadIncidentSnapshot({ source: 'manual', pageOverride: 1 })}>Apply Filters</button>
                  <button
                    onClick={() => {
                      setFailedJobOrderFilter('');
                      setFailedJobReasonFilter('');
                      setFailedJobPage(1);
                      void loadIncidentSnapshot({
                        source: 'manual',
                        pageOverride: 1,
                        orderIdOverride: '',
                        failedReasonOverride: ''
                      });
                    }}
                  >
                    Clear Filters
                  </button>
                </div>
              </div>
            </div>
            <p>
              Matched failed jobs: <strong>{totalMatchedFailedJobs}</strong> (showing {queueData.failedJobs.length} on this page)
            </p>
            {pagination?.mode === 'filtered_scan' && pagination.scanCount !== null ? (
              <p className={pagination.scanTruncated ? 'status-chip warning' : 'status-chip'}>
                Filter mode scans first {pagination.scanCount} failed jobs from queue
                {pagination.scanTruncated ? ` (of ${queueData.queue.failedCount} total).` : '.'}
              </p>
            ) : null}
            {queueData.failedJobs.length === 0 ? (
              <p>No failed queue jobs in the selected page/filter window.</p>
            ) : (
              isCompactViewport ? (
                <div className="mobile-data-list">
                  {queueData.failedJobs.map((job) => {
                    const orderId = typeof job.data?.orderId === 'string' ? job.data.orderId : null;
                    return (
                      <article key={job.jobId} className="mobile-data-card">
                        <div className="mobile-data-card-header">
                          <div>
                            <p className="mobile-data-kicker">Queue Job</p>
                            <p className="mono mobile-data-value">{job.jobId}</p>
                          </div>
                          <p className="mobile-data-value">{job.name}</p>
                        </div>
                        <p className="mobile-data-value">Order: {orderId ?? 'n/a'}</p>
                        <p className="mobile-data-value">Reason: {job.failedReason ?? 'No failure reason recorded.'}</p>
                        <p className="mobile-data-value">
                          Attempts: {job.attemptsMade}/{job.maxAttempts}
                        </p>
                        <p className="mobile-data-value">Finished: {formatMillisTimestamp(job.finishedOn)}</p>
                        <div className="admin-inline-actions">
                          <button disabled={Boolean(activeRetryJobId) || loading} onClick={() => retryFailedJob(job.jobId)}>
                            {activeRetryJobId === job.jobId ? 'Retrying...' : 'Retry'}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Queue Job</th>
                        <th>Order</th>
                        <th>Reason</th>
                        <th className="col-hide-mobile">Attempts</th>
                        <th className="col-hide-tablet">Finished</th>
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
                            <td className="col-hide-mobile">
                              {job.attemptsMade}/{job.maxAttempts}
                            </td>
                            <td className="col-hide-tablet">{formatMillisTimestamp(job.finishedOn)}</td>
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
              )
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
          <>
            {queueData.recentFailedStepsPagination ? (
              <p>
                Steps page {queueData.recentFailedStepsPagination.page}/{queueData.recentFailedStepsPagination.totalPages} (
                total {queueData.recentFailedStepsPagination.total})
              </p>
            ) : null}
            {isCompactViewport ? (
              <div className="mobile-data-list">
                {queueData.recentFailedSteps.map((step, index) => (
                  <article key={`${step.order_id}-${step.type}-${step.attempt}-${index}`} className="mobile-data-card">
                    <div className="mobile-data-card-header">
                      <div>
                        <p className="mobile-data-kicker">Order</p>
                        <p className="mono mobile-data-value">{step.order_id}</p>
                      </div>
                      <p className="mobile-data-value">{step.type}</p>
                    </div>
                    <p className="mobile-data-value">Finished: {formatIsoTimestamp(step.finished_at)}</p>
                    <p className="mobile-data-value">Provider: {step.provider}</p>
                    <p className="mobile-data-value">Attempt: {step.attempt}</p>
                    <p className="mobile-data-value">Error: {step.error_text ?? 'No error text recorded.'}</p>
                  </article>
                ))}
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Finished</th>
                      <th>Order</th>
                      <th>Step</th>
                      <th className="col-hide-tablet">Provider</th>
                      <th className="col-hide-mobile">Attempt</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queueData.recentFailedSteps.map((step, index) => (
                      <tr key={`${step.order_id}-${step.type}-${step.attempt}-${index}`}>
                        <td>{formatIsoTimestamp(step.finished_at)}</td>
                        <td className="mono">{step.order_id}</td>
                        <td>{step.type}</td>
                        <td className="col-hide-tablet">{step.provider}</td>
                        <td className="col-hide-mobile">{step.attempt}</td>
                        <td>{step.error_text ?? 'No error text recorded.'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}

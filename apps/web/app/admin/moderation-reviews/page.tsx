'use client';

import { useMemo, useState } from 'react';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

type ModerationDecision = 'pass' | 'manual_review' | 'reject' | 'unknown';
type ModerationStepStatus = 'queued' | 'running' | 'succeeded' | 'failed';

interface ModerationReview {
  id: string;
  orderId: string;
  orderStatus: string;
  parentEmail: string;
  stepStatus: ModerationStepStatus;
  provider: string;
  attempt: number;
  decision: ModerationDecision;
  checks: Record<string, string>;
  summary: string[];
  rejectReasons: string[];
  reviewReasons: string[];
  aggregateScores: Record<string, unknown>;
  modelProfile: Record<string, unknown>;
  thresholdProfile: Record<string, unknown>;
  evidence: Record<string, unknown>;
  details: Record<string, unknown>;
  localChecks: Record<string, unknown>;
  errorText: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

interface ModerationReviewsResponse {
  filters: {
    orderId: string | null;
    stepStatus: ModerationStepStatus | null;
    decision: ModerationDecision | null;
    limit: number;
  };
  summary: {
    totalReviews: number;
    decisionBreakdown: Array<{
      decision: ModerationDecision;
      count: number;
    }>;
    stepStatusBreakdown: Array<{
      stepStatus: ModerationStepStatus;
      count: number;
    }>;
  };
  reviews: ModerationReview[];
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

function getDecisionChipClass(decision: ModerationDecision): string {
  if (decision === 'pass') {
    return 'status-chip success';
  }
  if (decision === 'manual_review' || decision === 'reject') {
    return 'status-chip warning';
  }
  return 'status-chip';
}

export default function AdminModerationReviewsPage(): JSX.Element {
  const [adminToken, setAdminToken] = useState('');
  const [orderId, setOrderId] = useState('');
  const [decision, setDecision] = useState<'all' | ModerationDecision>('all');
  const [stepStatus, setStepStatus] = useState<'all' | ModerationStepStatus>('all');
  const [limit, setLimit] = useState('25');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('Load moderation review records with scored evidence and reasons.');
  const [data, setData] = useState<ModerationReviewsResponse | null>(null);

  const scoreAverages = useMemo(() => {
    if (!data || data.reviews.length === 0) {
      return [] as Array<{ key: string; average: number }>;
    }

    const accumulators = new Map<string, { total: number; count: number }>();
    for (const review of data.reviews) {
      for (const [key, value] of Object.entries(review.aggregateScores ?? {})) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          continue;
        }

        const current = accumulators.get(key) ?? { total: 0, count: 0 };
        current.total += value;
        current.count += 1;
        accumulators.set(key, current);
      }
    }

    return Array.from(accumulators.entries())
      .map(([key, value]) => ({
        key,
        average: value.count > 0 ? value.total / value.count : 0
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }, [data]);

  async function loadReviews(): Promise<void> {
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
    if (decision !== 'all') {
      params.set('decision', decision);
    }
    if (stepStatus !== 'all') {
      params.set('stepStatus', stepStatus);
    }

    try {
      const response = await fetch(`${apiBase}/admin/moderation-reviews?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${adminToken.trim()}`
        },
        cache: 'no-store'
      });
      const payload = (await parseResponse(response)) as ModerationReviewsResponse | { message?: string };
      if (!response.ok) {
        const errorMessage = 'message' in payload ? payload.message : undefined;
        throw new Error(errorMessage || `Request failed (${response.status}).`);
      }

      setData(payload as ModerationReviewsResponse);
      setMessage(`Loaded ${String((payload as ModerationReviewsResponse).reviews.length)} moderation reviews.`);
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
        <h1>Moderation Reviews</h1>
        <p>
          Admin workflow for moderation outcomes pulled from <span className="mono">jobs</span> type{' '}
          <span className="mono">moderation</span>, including decision bands, aggregate scores, and evidence payloads.
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

          <label htmlFor="decision">Decision</label>
          <select id="decision" value={decision} onChange={(event) => setDecision(event.target.value as 'all' | ModerationDecision)}>
            <option value="all">All decisions</option>
            <option value="pass">Pass</option>
            <option value="manual_review">Manual review</option>
            <option value="reject">Reject</option>
            <option value="unknown">Unknown</option>
          </select>

          <label htmlFor="stepStatus">Step Status</label>
          <select id="stepStatus" value={stepStatus} onChange={(event) => setStepStatus(event.target.value as 'all' | ModerationStepStatus)}>
            <option value="all">All step statuses</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
          </select>

          <label htmlFor="limit">Rows</label>
          <select id="limit" value={limit} onChange={(event) => setLimit(event.target.value)}>
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>

          <button disabled={loading} onClick={loadReviews}>
            {loading ? 'Loading Moderation Reviews...' : 'Load Moderation Reviews'}
          </button>
        </article>

        <article className="card">
          <h2>Summary</h2>
          {!data ? (
            <p>Run a query to load moderation decisions and score breakdowns.</p>
          ) : (
            <>
              <p>
                Loaded moderation records: <strong>{data.summary.totalReviews}</strong>
              </p>
              <div className="summary-grid">
                <div className="summary-block">
                  <h3>Decision Breakdown</h3>
                  {data.summary.decisionBreakdown.length > 0 ? (
                    <ul>
                      {data.summary.decisionBreakdown.map((entry) => (
                        <li key={entry.decision}>
                          {entry.decision}: {entry.count}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No decision rows.</p>
                  )}
                </div>
                <div className="summary-block">
                  <h3>Step Status Breakdown</h3>
                  {data.summary.stepStatusBreakdown.length > 0 ? (
                    <ul>
                      {data.summary.stepStatusBreakdown.map((entry) => (
                        <li key={entry.stepStatus}>
                          {entry.stepStatus}: {entry.count}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No status rows.</p>
                  )}
                </div>
                <div className="summary-block">
                  <h3>Average Scores</h3>
                  {scoreAverages.length > 0 ? (
                    <ul>
                      {scoreAverages.map((entry) => (
                        <li key={entry.key}>
                          {entry.key}: {entry.average.toFixed(3)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No score metrics found.</p>
                  )}
                </div>
              </div>
            </>
          )}
        </article>
      </section>

      <section className="card">
        <span className="status-chip">Status</span>
        <p>{message}</p>
      </section>

      <section className="card">
        <h2>Moderation Records</h2>
        {!data ? <p>No data loaded yet.</p> : null}
        {data && data.reviews.length === 0 ? <p>No moderation reviews matched the current filters.</p> : null}
        {data && data.reviews.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Order</th>
                  <th>Decision</th>
                  <th>Checks + Scores</th>
                  <th>Reasons</th>
                </tr>
              </thead>
              <tbody>
                {data.reviews.map((review) => (
                  <tr key={review.id}>
                    <td>
                      <div>{new Date(review.createdAt).toLocaleString()}</div>
                      {review.startedAt ? <div>Started: {new Date(review.startedAt).toLocaleString()}</div> : null}
                      {review.finishedAt ? <div>Finished: {new Date(review.finishedAt).toLocaleString()}</div> : null}
                    </td>
                    <td>
                      <div className="mono">{review.orderId}</div>
                      <div>Status: {review.orderStatus}</div>
                      <div>Step: {review.stepStatus}</div>
                      <div>Provider: {review.provider}</div>
                      <div>Attempt: {review.attempt}</div>
                      <div>{review.parentEmail}</div>
                    </td>
                    <td>
                      <span className={getDecisionChipClass(review.decision)}>{review.decision}</span>
                      {review.summary.length > 0 ? (
                        <ul>
                          {review.summary.slice(0, 3).map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                      ) : (
                        <p>No summary lines.</p>
                      )}
                    </td>
                    <td>
                      {Object.keys(review.checks).length > 0 ? (
                        <ul>
                          {Object.entries(review.checks).map(([key, value]) => (
                            <li key={key}>
                              {key}: {value}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>No checks.</p>
                      )}
                      {Object.keys(review.aggregateScores).length > 0 ? (
                        <ul>
                          {Object.entries(review.aggregateScores).map(([key, value]) => (
                            <li key={key}>
                              {key}: {typeof value === 'number' ? value.toFixed(3) : JSON.stringify(value)}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </td>
                    <td>
                      {review.rejectReasons.length > 0 ? (
                        <>
                          <p>Reject:</p>
                          <ul>
                            {review.rejectReasons.map((reason) => (
                              <li key={reason}>{reason}</li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                      {review.reviewReasons.length > 0 ? (
                        <>
                          <p>Review:</p>
                          <ul>
                            {review.reviewReasons.map((reason) => (
                              <li key={reason}>{reason}</li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                      <details>
                        <summary>Evidence</summary>
                        <pre>
                          {JSON.stringify(
                            {
                              modelProfile: review.modelProfile,
                              thresholdProfile: review.thresholdProfile,
                              localChecks: review.localChecks,
                              evidence: review.evidence,
                              details: review.details,
                              errorText: review.errorText
                            },
                            null,
                            2
                          )}
                        </pre>
                      </details>
                    </td>
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

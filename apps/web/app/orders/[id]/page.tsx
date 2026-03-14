import Link from 'next/link';
import type { Route } from 'next';
import { cookies } from 'next/headers';

import { AuthRecoveryCard } from './AuthRecoveryCard';
import { OrderActions } from './OrderActions';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

type OrderStatus =
  | 'draft'
  | 'intake_validating'
  | 'needs_user_fix'
  | 'awaiting_script_approval'
  | 'script_regenerate'
  | 'payment_pending'
  | 'paid'
  | 'running'
  | 'failed_soft'
  | 'failed_hard'
  | 'refund_queued'
  | 'manual_review'
  | 'delivered'
  | 'refunded'
  | 'expired';

interface ScriptShape {
  title: string;
  narration: string[];
  shots: Array<{
    shotNumber: number;
    durationSec: number;
    action: string;
    dialogue: string;
  }>;
}

interface LatestScript {
  id: string;
  version: number;
  script_json: ScriptShape;
}

interface JobRow {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  provider?: string;
  attempt?: number;
  error_text?: string | null;
  output_json?: Record<string, unknown>;
}

interface ArtifactRow {
  id: string;
  kind: string;
  meta_json?: {
    signedDownloadUrl?: string;
    [key: string]: unknown;
  };
}

interface ProviderTaskRow {
  provider_task_id: string;
  provider: string;
  job_type: string | null;
  status: 'queued' | 'processing' | 'succeeded' | 'failed';
  artifact_key: string | null;
  error_text: string | null;
  updated_at: string;
}

interface WorkerHealthWorker {
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
  workers?: WorkerHealthWorker[];
  checkedAt?: string;
  message?: string;
}

interface OrderStatusResponse {
  order: {
    id: string;
    status: OrderStatus;
  };
  latestScript: LatestScript | null;
  jobs: JobRow[];
  latestModeration: {
    jobId: string;
    provider: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    attempt: number;
    startedAt: string | null;
    finishedAt: string | null;
    decision: 'pass' | 'manual_review' | 'reject' | 'unknown';
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
  } | null;
  artifacts: ArtifactRow[];
  providerTasks: ProviderTaskRow[];
  parentRetryPolicy: {
    limit: number;
    used: number;
    remaining: number;
    canRetry: boolean;
    reason: string | null;
  };
  latestGiftLink: {
    id: string;
    recipientEmail: string;
    senderName: string | null;
    giftMessage: string | null;
    tokenHint: string;
    status: 'pending' | 'redeemed' | 'expired' | 'revoked';
    expiresAt: string;
    redeemedAt: string | null;
    createdAt: string;
  } | null;
  scenePlanThemeName: string | null;
  scenePlanError: string | null;
  scenePlan: Array<{
    shotNumber: number;
    shotType: 'narration' | 'dialogue';
    durationSec: number;
    sceneFallbackUsed: boolean;
    sceneRenderSpec: {
      sceneId: string;
      sceneName: string;
      sceneArchitecture: string;
      camera: string;
      lighting: string;
      modelProfile: {
        avatarModel: string;
        compositorModel: string;
      };
    };
  }>;
}

interface LifecycleStep {
  label: string;
  statuses: OrderStatus[];
}

interface StatusPageProps {
  params: {
    id: string;
  };
}

const lifecycleSteps: LifecycleStep[] = [
  {
    label: 'Intake',
    statuses: ['draft', 'intake_validating', 'needs_user_fix']
  },
  {
    label: 'Script Review',
    statuses: ['awaiting_script_approval', 'script_regenerate']
  },
  {
    label: 'Payment',
    statuses: ['payment_pending', 'paid']
  },
  {
    label: 'Rendering',
    statuses: ['running', 'failed_soft']
  },
  {
    label: 'Resolution',
    statuses: ['failed_hard', 'refund_queued', 'manual_review', 'refunded']
  },
  {
    label: 'Delivery',
    statuses: ['delivered', 'expired']
  }
];

const statusLabelMap: Record<OrderStatus, string> = {
  draft: 'Draft',
  intake_validating: 'Validating Intake',
  needs_user_fix: 'Needs User Fix',
  awaiting_script_approval: 'Awaiting Script Approval',
  script_regenerate: 'Regenerating Script',
  payment_pending: 'Payment Pending',
  paid: 'Paid',
  running: 'Rendering In Progress',
  failed_soft: 'Transient Failure, Retrying',
  failed_hard: 'Hard Failure',
  refund_queued: 'Refund Queued',
  manual_review: 'Manual Review',
  delivered: 'Delivered',
  refunded: 'Refunded',
  expired: 'Expired'
};

const statusMessageMap: Record<OrderStatus, string> = {
  draft: 'Start by uploading photos/voice, then generate and approve a script in the create flow.',
  intake_validating: 'We are validating media requirements and consent.',
  needs_user_fix: 'Please re-upload valid photos/voice and try generating the script again.',
  awaiting_script_approval: 'Review and approve the generated script to continue.',
  script_regenerate: 'A new script version is being generated.',
  payment_pending: 'Script approved. Complete checkout to start rendering.',
  paid: 'Payment captured. Render is queued and should start shortly.',
  running: 'Your cinematic video is rendering now.',
  failed_soft: 'A transient provider issue occurred. Automatic retry is in progress.',
  failed_hard: 'Rendering failed after retries or hit a hard policy/provider error.',
  refund_queued: 'Automatic refund is being processed.',
  manual_review: 'Refund requires manual support review.',
  refunded: 'Refund completed successfully.',
  delivered: 'Final video is ready for download.',
  expired: 'The asset retention window elapsed and download was revoked.'
};

const workerSensitiveStatuses: OrderStatus[] = ['paid', 'running', 'failed_soft'];

interface NextActionInfo {
  title: string;
  detail: string;
  ctaHref: string | null;
  ctaLabel: string | null;
}

function resolveNextAction(args: {
  status: OrderStatus;
  workerHealth: WorkerHealthResponse | null;
  workerHealthError: string | null;
}): NextActionInfo {
  const { status, workerHealth, workerHealthError } = args;

  if (workerSensitiveStatuses.includes(status) && workerHealth && !workerHealth.ok) {
    const latestAgeSec = workerHealth.workers?.[0]?.ageSec;
    const staleAfterSec = workerHealth.staleAfterSec;
    const timingHint =
      typeof latestAgeSec === 'number' && typeof staleAfterSec === 'number'
        ? `Latest heartbeat age is ${latestAgeSec}s (stale after ${staleAfterSec}s).`
        : null;

    return {
      title: 'Worker Service Needs Attention',
      detail: `${workerHealth.message ?? 'No fresh worker heartbeat detected.'} Rendering will not progress until the worker service is running with DATABASE_URL and REDIS_URL configured.${timingHint ? ` ${timingHint}` : ''}`,
      ctaHref: null,
      ctaLabel: null
    };
  }

  if (workerSensitiveStatuses.includes(status) && workerHealthError) {
    return {
      title: 'Verify Worker Health Endpoint',
      detail: `Worker diagnostics are currently unavailable (${workerHealthError}). Rendering may still be running; refresh this page and check deployment logs.`,
      ctaHref: null,
      ctaLabel: null
    };
  }

  switch (status) {
    case 'draft':
    case 'intake_validating':
    case 'needs_user_fix':
    case 'awaiting_script_approval':
    case 'script_regenerate':
    case 'payment_pending':
      return {
        title: 'Continue In Create Flow',
        detail: 'Generate/approve script and complete payment to start rendering.',
        ctaHref: '/create',
        ctaLabel: 'Open Create Flow'
      };
    case 'paid':
      return {
        title: 'Confirm Render Starts',
        detail: 'If status stays queued for more than a couple minutes, use Parent Retry below to requeue rendering.',
        ctaHref: null,
        ctaLabel: null
      };
    case 'running':
    case 'failed_soft':
      return {
        title: 'Wait For Render Progress',
        detail: 'Render is processing. Refresh this page every 20-30 seconds.',
        ctaHref: null,
        ctaLabel: null
      };
    case 'failed_hard':
    case 'refund_queued':
    case 'manual_review':
      return {
        title: 'Use Retry Or Support Actions',
        detail: 'Check Parent Retry below. If retry is unavailable, review gift/support options.',
        ctaHref: null,
        ctaLabel: null
      };
    case 'delivered':
      return {
        title: 'Download Final Video',
        detail: 'Your keepsake is ready in the Delivery card below.',
        ctaHref: null,
        ctaLabel: null
      };
    case 'refunded':
    case 'expired':
      return {
        title: 'Start A New Order',
        detail: 'This order is closed. Create a new keepsake when ready.',
        ctaHref: '/create',
        ctaLabel: 'Create New Order'
      };
    default:
      return {
        title: 'Review Current Order Status',
        detail: 'Use lifecycle and action cards below to continue.',
        ctaHref: null,
        ctaLabel: null
      };
  }
}

function getCurrentStepIndex(status: OrderStatus): number {
  return lifecycleSteps.findIndex((step) => step.statuses.includes(status));
}

function getStatusChipClass(status: OrderStatus): string {
  if (['failed_soft', 'failed_hard', 'refund_queued', 'manual_review'].includes(status)) {
    return 'status-chip warning';
  }
  if (['delivered', 'refunded', 'expired'].includes(status)) {
    return 'status-chip success';
  }
  return 'status-chip';
}

function getModerationChipClass(decision: 'pass' | 'manual_review' | 'reject' | 'unknown'): string {
  if (decision === 'pass') {
    return 'status-chip success';
  }
  if (decision === 'manual_review' || decision === 'reject') {
    return 'status-chip warning';
  }
  return 'status-chip';
}

async function loadOrder(args: {
  orderId: string;
  parentAccessToken: string | null;
}): Promise<{
  data: OrderStatusResponse | null;
  unauthorized: boolean;
  notFound: boolean;
  errorMessage: string | null;
}> {
  try {
    const response = await fetch(`${apiBase}/orders/${args.orderId}/status`, {
      cache: 'no-store',
      headers: args.parentAccessToken
        ? {
            Authorization: `Bearer ${args.parentAccessToken}`
          }
        : undefined
    });

    if (response.status === 401) {
      return { data: null, unauthorized: true, notFound: false, errorMessage: null };
    }

    if (response.status === 404) {
      return { data: null, unauthorized: false, notFound: true, errorMessage: null };
    }

    if (!response.ok) {
      const raw = await response.text();
      let message = raw.trim();
      if (message.startsWith('{') && message.endsWith('}')) {
        try {
          const parsed = JSON.parse(message) as { message?: string };
          message = parsed.message?.trim() || message;
        } catch {
          // keep raw response text
        }
      }
      return {
        data: null,
        unauthorized: false,
        notFound: false,
        errorMessage: message || `Order status request failed (${response.status}).`
      };
    }

    return {
      data: (await response.json()) as OrderStatusResponse,
      unauthorized: false,
      notFound: false,
      errorMessage: null
    };
  } catch (error) {
    return {
      data: null,
      unauthorized: false,
      notFound: false,
      errorMessage:
        (error as Error).message ||
        'Order status is temporarily unavailable. Verify NEXT_PUBLIC_API_BASE_URL points to a reachable API.'
    };
  }
}

async function loadWorkerHealth(): Promise<{
  data: WorkerHealthResponse | null;
  errorMessage: string | null;
}> {
  try {
    const response = await fetch(`${apiBase}/health/worker`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3500)
    });
    const raw = await response.text();
    if (!raw.trim()) {
      return {
        data: null,
        errorMessage: response.ok ? 'Worker health response was empty.' : `Worker health request failed (${response.status}).`
      };
    }

    let parsed: WorkerHealthResponse | null = null;
    try {
      parsed = JSON.parse(raw) as WorkerHealthResponse;
    } catch {
      return {
        data: null,
        errorMessage: response.ok ? 'Worker health response was not valid JSON.' : `Worker health request failed (${response.status}).`
      };
    }

    if (!parsed || typeof parsed.ok !== 'boolean') {
      return {
        data: null,
        errorMessage: 'Worker health response shape was invalid.'
      };
    }

    return {
      data: parsed,
      errorMessage: null
    };
  } catch (error) {
    return {
      data: null,
      errorMessage: (error as Error).message || 'Worker health request failed.'
    };
  }
}

export default async function OrderStatusPage({ params }: StatusPageProps): Promise<JSX.Element> {
  const parentAccessToken = cookies().get('parent_access_token')?.value ?? null;
  const recoveryHref = `/create?returnTo=${encodeURIComponent(`/orders/${params.id}`)}`;
  const { data, unauthorized, notFound, errorMessage } = await loadOrder({
    orderId: params.id,
    parentAccessToken
  });

  if (!data) {
    return (
      <main>
        <section className="card">
          <h1>{unauthorized ? 'Parent auth required' : notFound ? 'Order not found' : 'Order status unavailable'}</h1>
          {unauthorized ? (
            <AuthRecoveryCard orderId={params.id} recoveryHref={recoveryHref} />
          ) : (
            <>
              {errorMessage ? <p>{errorMessage}</p> : null}
              <p>
                If this happened right after payment redirect, wait a few seconds and refresh. If it persists, verify
                web env <span className="mono">NEXT_PUBLIC_API_BASE_URL</span> points to your live API.
              </p>
              <Link href="/create">Back to create flow</Link>
            </>
          )}
        </section>
      </main>
    );
  }

  const finalArtifact = data.artifacts.find((artifact) => artifact.kind === 'final_video');
  const previewArtifact = data.artifacts.find((artifact) => artifact.kind === 'preview_video');
  const currentStepIndex = getCurrentStepIndex(data.order.status);
  const shouldLoadWorkerHealth = workerSensitiveStatuses.includes(data.order.status);
  const workerHealthState = shouldLoadWorkerHealth
    ? await loadWorkerHealth()
    : { data: null as WorkerHealthResponse | null, errorMessage: null as string | null };
  const workerHealth = workerHealthState.data;
  const latestWorker = workerHealth?.workers?.[0];
  const nextAction = resolveNextAction({
    status: data.order.status,
    workerHealth,
    workerHealthError: workerHealthState.errorMessage
  });

  const failedJobs = data.jobs.filter((job) => job.status === 'failed').length;
  const runningJobs = data.jobs.filter((job) => job.status === 'running').length;
  const succeededJobs = data.jobs.filter((job) => job.status === 'succeeded').length;
  const moderationScoreEntries = Object.entries(data.latestModeration?.aggregateScores ?? {});
  const moderationCheckEntries = Object.entries(data.latestModeration?.checks ?? {});

  return (
    <main>
      <section className="card">
        <h1>Order Status</h1>
        <p className="mono">order_id: {data.order.id}</p>
        <p className={getStatusChipClass(data.order.status)}>
          {statusLabelMap[data.order.status]} ({data.order.status})
        </p>
        <p>{statusMessageMap[data.order.status]}</p>
        <Link href="/create">Create another order</Link>
      </section>

      <section className="card">
        <h2>Lifecycle Progress</h2>
        <div className="timeline">
          {lifecycleSteps.map((step, index) => {
            const state =
              index < currentStepIndex ? 'done' : index === currentStepIndex ? 'current' : 'upcoming';
            return (
              <div className={`timeline-row ${state}`} key={step.label}>
                <span className="timeline-index">{index + 1}</span>
                <span>{step.label}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card">
        <h2>What To Do Next</h2>
        <p>
          <strong>{nextAction.title}</strong>
        </p>
        <p>{nextAction.detail}</p>
        {shouldLoadWorkerHealth ? (
          <>
            {workerHealth ? (
              <p className={workerHealth.ok ? 'status-chip success' : 'status-chip warning'}>
                Worker health: {workerHealth.ok ? 'online' : 'offline/stale'} (active workers:{' '}
                {workerHealth.activeWorkers ?? 0}, processing: {workerHealth.processingWorkers ?? 0})
              </p>
            ) : (
              <p className="status-chip warning">
                Worker health check unavailable: {workerHealthState.errorMessage ?? 'unknown error'}
              </p>
            )}
          </>
        ) : null}
        {nextAction.ctaHref && nextAction.ctaLabel ? (
          <Link href={nextAction.ctaHref as Route}>{nextAction.ctaLabel}</Link>
        ) : null}
      </section>

      <section className="grid two">
        <article className="card">
          <h2>Latest Script</h2>
          {data.latestScript ? (
            <>
              <p>Version: {data.latestScript.version}</p>
              <p className="mono">{data.latestScript.script_json.title}</p>
              {previewArtifact?.meta_json?.signedDownloadUrl ? (
                <a href={previewArtifact.meta_json.signedDownloadUrl} target="_blank" rel="noreferrer">
                  Open Watermarked Preview
                </a>
              ) : null}
              <ul>
                {data.latestScript.script_json.shots.map((shot) => (
                  <li key={shot.shotNumber}>
                    Shot {shot.shotNumber} ({shot.durationSec}s)
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p>No script generated yet.</p>
              <p>
                Continue in <Link href="/create">Create Flow</Link> to generate + approve script and start payment.
              </p>
            </>
          )}
        </article>

        <article className="card">
          <h2>Delivery</h2>
          {finalArtifact ? (
            <>
              <p>Final video artifact created.</p>
              <a href={finalArtifact.meta_json?.signedDownloadUrl} target="_blank" rel="noreferrer">
                Download MP4 (signed URL stub)
              </a>
            </>
          ) : (
            <>
              <p>Final video is not ready yet. Refresh this page while worker runs.</p>
              {shouldLoadWorkerHealth && workerHealth && !workerHealth.ok ? (
                <p className="status-chip warning">
                  Worker heartbeat is stale/offline. Rendering will not complete until the worker service is healthy.
                </p>
              ) : null}
              {shouldLoadWorkerHealth && latestWorker ? (
                <p className="mono">
                  latest_worker: {latestWorker.serviceName} / {latestWorker.status} / age=
                  {latestWorker.ageSec ?? 'unknown'}s
                </p>
              ) : null}
            </>
          )}
        </article>
      </section>

      <OrderActions
        orderId={data.order.id}
        parentRetryPolicy={data.parentRetryPolicy}
        latestGiftLink={data.latestGiftLink}
        parentAccessToken={parentAccessToken}
        recoveryHref={recoveryHref}
      />

      <section className="card">
        <h2>Moderation Report</h2>
        {!data.latestModeration ? (
          <p>No moderation step recorded yet.</p>
        ) : (
          <>
            <p className={getModerationChipClass(data.latestModeration.decision)}>
              Decision: {data.latestModeration.decision} ({data.latestModeration.status})
            </p>
            <p>
              Provider: <strong>{data.latestModeration.provider}</strong> | Attempt:{' '}
              <strong>{data.latestModeration.attempt}</strong>
            </p>
            {data.latestModeration.summary.length > 0 ? (
              <ul>
                {data.latestModeration.summary.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : (
              <p>No moderation summary text recorded.</p>
            )}
            {moderationCheckEntries.length > 0 ? (
              <>
                <h3>Checks</h3>
                <ul>
                  {moderationCheckEntries.map(([key, value]) => (
                    <li key={key}>
                      {key}: {value}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {moderationScoreEntries.length > 0 ? (
              <>
                <h3>Aggregate Scores</h3>
                <ul>
                  {moderationScoreEntries.map(([key, value]) => (
                    <li key={key}>
                      {key}: {typeof value === 'number' ? value.toFixed(3) : JSON.stringify(value)}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {data.latestModeration.rejectReasons.length > 0 ? (
              <>
                <h3>Reject Reasons</h3>
                <ul>
                  {data.latestModeration.rejectReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {data.latestModeration.reviewReasons.length > 0 ? (
              <>
                <h3>Review Reasons</h3>
                <ul>
                  {data.latestModeration.reviewReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </>
            ) : null}
            <details>
              <summary>Moderation Evidence JSON</summary>
              <pre className="mono">
                {JSON.stringify(
                  {
                    modelProfile: data.latestModeration.modelProfile,
                    thresholdProfile: data.latestModeration.thresholdProfile,
                    localChecks: data.latestModeration.localChecks,
                    evidence: data.latestModeration.evidence,
                    details: data.latestModeration.details
                  },
                  null,
                  2
                )}
              </pre>
            </details>
          </>
        )}
      </section>

      <section className="card">
        <h2>Technical Diagnostics (Advanced)</h2>
        <p>Use these details for support/debugging when normal parent actions are not enough.</p>
        <details>
          <summary>Jobs JSON</summary>
          <p>
            Succeeded: <strong>{succeededJobs}</strong> | Running: <strong>{runningJobs}</strong> | Failed:{' '}
            <strong>{failedJobs}</strong>
          </p>
          <pre className="mono">{JSON.stringify(data.jobs, null, 2)}</pre>
        </details>
        <details>
          <summary>Provider Tasks JSON</summary>
          {data.providerTasks.length === 0 ? (
            <p>No provider tasks recorded yet.</p>
          ) : (
            <pre className="mono">{JSON.stringify(data.providerTasks, null, 2)}</pre>
          )}
        </details>
        <details>
          <summary>Scene Plan + Models</summary>
          {data.scenePlanError ? <p>{data.scenePlanError}</p> : null}
          {data.scenePlan.length === 0 ? (
            <p>No scene plan yet. Generate a script to see per-shot scene specs.</p>
          ) : (
            <>
              <p>
                Theme: <strong>{data.scenePlanThemeName ?? 'Unknown'}</strong>
              </p>
              <ul>
                {data.scenePlan.map((entry) => (
                  <li key={`${entry.shotNumber}-${entry.sceneRenderSpec.sceneId}`}>
                    Shot {entry.shotNumber} ({entry.shotType}, {entry.durationSec}s): {entry.sceneRenderSpec.sceneName}{' '}
                    [{entry.sceneRenderSpec.camera} / {entry.sceneRenderSpec.lighting}] model=
                    {entry.sceneRenderSpec.modelProfile.avatarModel} + {entry.sceneRenderSpec.modelProfile.compositorModel}
                    {entry.sceneFallbackUsed ? ' (fallback scene match)' : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
        </details>
      </section>
    </main>
  );
}

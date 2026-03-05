import Link from 'next/link';

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

interface OrderStatusResponse {
  order: {
    id: string;
    status: OrderStatus;
  };
  latestScript: LatestScript | null;
  jobs: JobRow[];
  artifacts: ArtifactRow[];
  providerTasks: ProviderTaskRow[];
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
  draft: 'Start by uploading photos and a voice sample.',
  intake_validating: 'We are validating media requirements and consent.',
  needs_user_fix: 'Please re-upload valid photos/voice and try generating the script again.',
  awaiting_script_approval: 'Review and approve the generated script to continue.',
  script_regenerate: 'A new script version is being generated.',
  payment_pending: 'Script approved. Complete checkout to start rendering.',
  paid: 'Payment captured. The render job is queued.',
  running: 'Your cinematic video is rendering now.',
  failed_soft: 'A transient provider issue occurred. Automatic retry is in progress.',
  failed_hard: 'Rendering failed after retries or hit a hard policy/provider error.',
  refund_queued: 'Automatic refund is being processed.',
  manual_review: 'Refund requires manual support review.',
  refunded: 'Refund completed successfully.',
  delivered: 'Final video is ready for download.',
  expired: 'The asset retention window elapsed and download was revoked.'
};

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

async function loadOrder(orderId: string): Promise<OrderStatusResponse | null> {
  const response = await fetch(`${apiBase}/orders/${orderId}/status`, {
    cache: 'no-store'
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

export default async function OrderStatusPage({ params }: StatusPageProps): Promise<JSX.Element> {
  const data = await loadOrder(params.id);

  if (!data) {
    return (
      <main>
        <section className="card">
          <h1>Order not found</h1>
          <p>The order id may be invalid or not yet created.</p>
          <Link href="/create">Back to create flow</Link>
        </section>
      </main>
    );
  }

  const finalArtifact = data.artifacts.find((artifact) => artifact.kind === 'final_video');
  const currentStepIndex = getCurrentStepIndex(data.order.status);

  const failedJobs = data.jobs.filter((job) => job.status === 'failed').length;
  const runningJobs = data.jobs.filter((job) => job.status === 'running').length;
  const succeededJobs = data.jobs.filter((job) => job.status === 'succeeded').length;

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

      <section className="grid two">
        <article className="card">
          <h2>Latest Script</h2>
          {data.latestScript ? (
            <>
              <p>Version: {data.latestScript.version}</p>
              <p className="mono">{data.latestScript.script_json.title}</p>
              <ul>
                {data.latestScript.script_json.shots.map((shot) => (
                  <li key={shot.shotNumber}>
                    Shot {shot.shotNumber} ({shot.durationSec}s)
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>No script generated yet.</p>
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
            <p>Final video is not ready yet. Refresh this page while worker runs.</p>
          )}
        </article>
      </section>

      <section className="card">
        <h2>Job Summary</h2>
        <p>
          Succeeded: <strong>{succeededJobs}</strong> | Running: <strong>{runningJobs}</strong> | Failed:{' '}
          <strong>{failedJobs}</strong>
        </p>
        <pre className="mono">{JSON.stringify(data.jobs, null, 2)}</pre>
      </section>

      <section className="card">
        <h2>Provider Tasks</h2>
        {data.providerTasks.length === 0 ? (
          <p>No provider tasks recorded yet.</p>
        ) : (
          <pre className="mono">{JSON.stringify(data.providerTasks, null, 2)}</pre>
        )}
      </section>
    </main>
  );
}

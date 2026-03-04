import Link from 'next/link';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

interface StatusPageProps {
  params: {
    id: string;
  };
}

async function loadOrder(orderId: string): Promise<any> {
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

  const finalArtifact = (data.artifacts ?? []).find((artifact: any) => artifact.kind === 'final_video');

  return (
    <main>
      <section className="card">
        <h1>Order Status</h1>
        <p className="mono">order_id: {data.order.id}</p>
        <p>
          Current lifecycle status: <strong>{data.order.status}</strong>
        </p>
        <Link href="/create">Create another order</Link>
      </section>

      <section className="grid two">
        <article className="card">
          <h2>Latest Script</h2>
          {data.latestScript ? (
            <>
              <p>Version: {data.latestScript.version}</p>
              <pre className="mono">{JSON.stringify(data.latestScript.script_json, null, 2)}</pre>
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
              <a href={finalArtifact.meta_json?.signedDownloadUrl} target="_blank">
                Download MP4 (signed URL stub)
              </a>
            </>
          ) : (
            <p>Final video is not ready yet. Refresh this page while worker runs.</p>
          )}
        </article>
      </section>

      <section className="card">
        <h2>Jobs</h2>
        <pre className="mono">{JSON.stringify(data.jobs, null, 2)}</pre>
      </section>
    </main>
  );
}

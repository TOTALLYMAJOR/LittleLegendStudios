import Link from 'next/link';
import type { Route } from 'next';

export default function HomePage(): JSX.Element {
  return (
    <main>
      <section className="grid two">
        <article className="card">
          <h1>Little Legend Studios MVP</h1>
          <p>
            This scaffold implements the core order lifecycle for personalized 64-84 second cinematic children stories,
            including intake, script approval, payment, async rendering, and delivery status.
          </p>
          <Link href="/create">Start a new keepsake order</Link>
        </article>

        <article className="card">
          <h2>Admin Tools</h2>
          <p>Support and operational views for failures, retries, provider triage, and retention sweeps.</p>
          <p>
            <Link href={'/admin/email-notifications' as Route}>Review email notification failures</Link>
          </p>
          <p>
            <Link href={'/admin/retry-history' as Route}>Review retry request history</Link>
          </p>
          <p>
            <Link href={'/admin/retention-history' as Route}>Review retention and purge history</Link>
          </p>
          <Link href={'/admin/provider-task-triage' as Route}>Triage provider task failures</Link>
        </article>
      </section>
    </main>
  );
}

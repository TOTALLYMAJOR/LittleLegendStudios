import Link from 'next/link';
import type { Route } from 'next';

export default function HomePage(): JSX.Element {
  return (
    <main>
      <section className="grid two">
        <article className="card">
          <h1>Little Legend Studios MVP</h1>
          <p>
            This scaffold implements the core order lifecycle for personalized 20-40 second cinematic children stories,
            including intake, script approval, payment, async rendering, and delivery status.
          </p>
          <Link href="/create">Start a new keepsake order</Link>
        </article>

        <article className="card">
          <h2>Admin Tools</h2>
          <p>Support and operational views for failures, retries, and provider triage.</p>
          <p>
            <Link href={'/admin/email-notifications' as Route}>Review email notification failures</Link>
          </p>
          <Link href={'/admin/retry-history' as Route}>Review retry request history</Link>
        </article>
      </section>
    </main>
  );
}

import Link from 'next/link';

export default function HomePage(): JSX.Element {
  return (
    <main>
      <section className="card">
        <h1>Little Legend Studios MVP</h1>
        <p>
          This scaffold implements the core order lifecycle for personalized 20-40 second cinematic children stories,
          including intake, script approval, payment, async rendering, and delivery status.
        </p>
        <Link href="/create">Start a new keepsake order</Link>
      </section>
    </main>
  );
}

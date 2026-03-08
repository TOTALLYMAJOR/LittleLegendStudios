import Link from 'next/link';
import type { Route } from 'next';

const featuredWorld = {
  name: 'Space Adventure',
  tone: 'Galactic keepsake film',
  description:
    'Rocket launchpads, luminous nebula skies, and a brave little hero moving through a full cinematic arc built from family photos and voice.',
  accent: 'Starlit epic'
};

const supportingWorlds = [
  {
    name: 'Fantasy Kingdom',
    tone: 'Enchanted fairytale',
    description: 'Castle courtyards, moonlit forests, and a storybook ending framed like a premium animated short.'
  },
  {
    name: 'Underwater Kingdom',
    tone: 'Dreamy underwater odyssey',
    description: 'Glowing reefs, pearl-lit halls, and a magical journey with soft light, motion, and wonder.'
  },
  {
    name: 'Superhero City',
    tone: 'Comic-scale hero film',
    description: 'Skyline flyovers, rooftop momentum, and a child-centered origin story with cinematic energy.'
  }
];

const processSteps = [
  {
    label: 'Upload',
    title: 'Share photos and one voice sample',
    text: 'Parents provide the raw material once. The system turns it into a guided cinematic world, not a generic slideshow.'
  },
  {
    label: 'Review',
    title: 'Approve the story before render',
    text: 'Each order generates a script preview first, so the emotional beat and world direction are checked before final delivery.'
  },
  {
    label: 'Deliver',
    title: 'Receive a finished keepsake film',
    text: 'The render pipeline assembles voice, scenes, music, subtitles, and final composition into a premium family keepsake.'
  }
];

const trustPoints = [
  'Parent-gated order access and ownership enforcement',
  'Manual deletion plus retention automation with purge history',
  'Structured moderation checks before the render pipeline runs',
  'Async status tracking, retries, provider task visibility, and delivery notifications'
];

const adminLinks = [
  { href: '/admin/email-notifications' as Route, label: 'Email failures' },
  { href: '/admin/retry-history' as Route, label: 'Retry history' },
  { href: '/admin/provider-task-triage' as Route, label: 'Provider triage' },
  { href: '/admin/retention-history' as Route, label: 'Retention history' }
];

export default function HomePage(): JSX.Element {
  return (
    <main className="landing-shell">
      <section className="hero">
        <div className="hero-backdrop" aria-hidden="true">
          <div className="hero-noise" />
          <div className="hero-orb hero-orb-left" />
          <div className="hero-orb hero-orb-right" />
          <div className="hero-beam" />
          <div className="hero-grid" />
          <div className="hero-particles">
            {Array.from({ length: 18 }, (_, index) => (
              <span key={index} className={`hero-particle hero-particle-${(index % 6) + 1}`} />
            ))}
          </div>
        </div>

        <div className="hero-copy">
          <div className="studio-ident" aria-label="Little Legend Studios">
            <div className="studio-ident-beams" aria-hidden="true">
              <span className="studio-beam studio-beam-1" />
              <span className="studio-beam studio-beam-2" />
              <span className="studio-beam studio-beam-3" />
            </div>
            <span className="hero-kicker">Little Legend Studios</span>
            <div className="studio-ident-wordmark">
              <span className="studio-ident-little">Little Legend</span>
              <span className="studio-ident-studios">Studios</span>
            </div>
          </div>
          <p className="hero-layer hero-layer-top">Boutique cinematic keepsakes</p>
          <h1>
            Story worlds your child can
            <span> step inside.</span>
          </h1>
          <p className="hero-summary">
            We turn family photos, one voice sample, and a guided story arc into a premium short film that feels magical,
            intimate, and crafted with intention.
          </p>

          <div className="hero-actions">
            <Link className="button-primary" href="/create">
              Start a Keepsake Order
            </Link>
            <a className="button-secondary" href="#worlds">
              Explore Story Worlds
            </a>
          </div>

          <div className="hero-metrics" aria-label="Current product highlights">
            <div className="metric-card">
              <strong>64-84 sec</strong>
              <span>premium cinematic runtime</span>
            </div>
            <div className="metric-card">
              <strong>8 beats</strong>
              <span>planned story arc per film</span>
            </div>
            <div className="metric-card">
              <strong>Async render</strong>
              <span>review, approve, then deliver</span>
            </div>
          </div>
        </div>

        <div className="hero-poster">
          <div className="poster-stack">
            <div className="poster-glow" />
            <div className="poster-frame">
              <div className="poster-badge">Featured World</div>
              <p className="poster-overline">{featuredWorld.accent}</p>
              <h2>{featuredWorld.name}</h2>
              <p className="poster-tone">{featuredWorld.tone}</p>
              <p>{featuredWorld.description}</p>
              <div className="poster-footer">
                <span>Personalized child hero</span>
                <span>Layered audio + final compose</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="worlds-section" id="worlds">
        <div className="section-heading">
          <span className="section-kicker">Story Worlds</span>
          <h2>Designed like miniature films, not template cards.</h2>
          <p>
            Each world is structured as a premium narrative arc with distinct scene beats, tone, and atmosphere. The page
            should feel like browsing a studio slate, not sorting a marketplace grid.
          </p>
        </div>

        <div className="worlds-grid">
          <article className="world-card world-card-featured">
            <span className="world-card-chip">Central Focus</span>
            <h3>{featuredWorld.name}</h3>
            <p className="world-card-tone">{featuredWorld.tone}</p>
            <p>{featuredWorld.description}</p>
          </article>

          <div className="world-card-rail">
            {supportingWorlds.map((world) => (
              <article key={world.name} className="world-card world-card-mini">
                <span className="world-card-chip world-card-chip-soft">{world.tone}</span>
                <h3>{world.name}</h3>
                <p>{world.description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="process-section">
        <div className="section-heading">
          <span className="section-kicker">How It Works</span>
          <h2>A premium parent flow with review before delivery.</h2>
        </div>

        <div className="process-grid">
          {processSteps.map((step) => (
            <article key={step.label} className="process-card">
              <span className="process-step">{step.label}</span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="trust-section">
        <div className="trust-panel">
          <span className="section-kicker">Trust + Operations</span>
          <h2>Built like a real product, not a static concept page.</h2>
          <p>
            The landing page can be cinematic without hiding the fact that the underlying system already supports ownership,
            moderation, retries, cleanup, and operational visibility.
          </p>
          <ul className="trust-list">
            {trustPoints.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>

        <div className="support-panel">
          <span className="section-kicker">Studio Access</span>
          <h2>Parent and admin entry points stay close at hand.</h2>
          <div className="support-links">
            <Link className="support-link support-link-primary" href="/create">
              Open order flow
            </Link>
            {adminLinks.map((link) => (
              <Link key={link.href} className="support-link" href={link.href}>
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

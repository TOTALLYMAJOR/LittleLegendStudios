import Link from 'next/link';
import type { Route } from 'next';
import { notFound } from 'next/navigation';

import { resolveChildInterfaceConfig } from '@little/shared/child-director';

import { resolveChildDirectorFlags } from '../../lib/child-director-flags';
import { ChildDirectorExplorerBoard } from './ChildDirectorExplorerBoard';

export default function ChildDirectorCreatePage(): JSX.Element {
  const flags = resolveChildDirectorFlags();

  if (!flags.childDirectorExperienceEnabled) {
    notFound();
  }

  const explorerConfig = resolveChildInterfaceConfig('explorer');

  return (
    <main>
      <section className="card">
        <h1>Child Director Prototype</h1>
        <p>
          Explorer mode vertical slice for ages 6-8. This route is feature-gated and additive so the parent create flow stays
          unchanged.
        </p>
        <p>
          Active mode: <strong>{explorerConfig.ageGroup}</strong> | complexity <strong>{explorerConfig.complexityLevel}</strong>
          {' '}| parent controls <strong>{explorerConfig.parentControls ? 'on' : 'off'}</strong>
        </p>
        <p>
          <Link href={'/create' as Route}>Return to parent create flow</Link>
        </p>
      </section>

      <ChildDirectorExplorerBoard />
    </main>
  );
}

import { resolveBooleanFlag } from '@little/shared/child-director';

export interface ChildDirectorFlags {
  childDirectorExperienceEnabled: boolean;
}

export function resolveChildDirectorFlags(env: Record<string, string | undefined> = process.env): ChildDirectorFlags {
  return {
    childDirectorExperienceEnabled: resolveBooleanFlag(env.NEXT_PUBLIC_CHILD_DIRECTOR_ENABLED)
  };
}

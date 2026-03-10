import { resolveBooleanFlag } from '@little/shared/child-director';

export interface ChildDirectorFlags {
  childDirectorExperienceEnabled: boolean;
}

export function resolveChildDirectorFlags(env?: Record<string, string | undefined>): ChildDirectorFlags {
  const childDirectorFlag = env
    ? env.NEXT_PUBLIC_CHILD_DIRECTOR_ENABLED
    : process.env.NEXT_PUBLIC_CHILD_DIRECTOR_ENABLED;

  return {
    childDirectorExperienceEnabled: resolveBooleanFlag(childDirectorFlag)
  };
}

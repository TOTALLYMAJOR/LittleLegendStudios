import { resolveBooleanFlag } from '@little/shared/child-director';

export interface ChildDirectorFlags {
  childDirectorExperienceEnabled: boolean;
  childDirectorRelease2Enabled: boolean;
}

export function resolveChildDirectorFlags(env?: Record<string, string | undefined>): ChildDirectorFlags {
  const childDirectorFlag = env
    ? env.NEXT_PUBLIC_CHILD_DIRECTOR_ENABLED
    : process.env.NEXT_PUBLIC_CHILD_DIRECTOR_ENABLED;
  const childDirectorRelease2Flag = env
    ? env.NEXT_PUBLIC_CHILD_DIRECTOR_RELEASE2_ENABLED
    : process.env.NEXT_PUBLIC_CHILD_DIRECTOR_RELEASE2_ENABLED;
  const childDirectorExperienceEnabled = resolveBooleanFlag(childDirectorFlag);

  return {
    childDirectorExperienceEnabled,
    childDirectorRelease2Enabled: childDirectorExperienceEnabled && resolveBooleanFlag(childDirectorRelease2Flag)
  };
}

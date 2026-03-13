import { resolveBooleanFlag } from '@little/shared/child-director';

export interface ChildDirectorFlags {
  childDirectorExperienceEnabled: boolean;
  childDirectorRelease2Enabled: boolean;
}

function hasExplicitFlag(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function resolveChildDirectorFlags(env?: Record<string, string | undefined>): ChildDirectorFlags {
  const childDirectorFlag = env
    ? env.NEXT_PUBLIC_CHILD_DIRECTOR_ENABLED
    : process.env.NEXT_PUBLIC_CHILD_DIRECTOR_ENABLED;
  const childDirectorRelease2Flag = env
    ? env.NEXT_PUBLIC_CHILD_DIRECTOR_RELEASE2_ENABLED
    : process.env.NEXT_PUBLIC_CHILD_DIRECTOR_RELEASE2_ENABLED;
  const vercelEnv = env ? env.VERCEL_ENV : process.env.VERCEL_ENV;
  const enablePreviewFallback = vercelEnv === 'preview';
  const childDirectorExperienceEnabled = hasExplicitFlag(childDirectorFlag)
    ? resolveBooleanFlag(childDirectorFlag)
    : enablePreviewFallback;
  const childDirectorRelease2Enabled = hasExplicitFlag(childDirectorRelease2Flag)
    ? resolveBooleanFlag(childDirectorRelease2Flag)
    : enablePreviewFallback;

  return {
    childDirectorExperienceEnabled,
    childDirectorRelease2Enabled: childDirectorExperienceEnabled && childDirectorRelease2Enabled
  };
}

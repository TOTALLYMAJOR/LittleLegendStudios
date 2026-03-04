export const JOB_TYPES = [
  'moderation',
  'voice_clone',
  'voice_render',
  'character_pack',
  'shot_render',
  'final_render'
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

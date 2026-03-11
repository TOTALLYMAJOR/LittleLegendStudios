export const AGE_GROUPS = ['toddler', 'explorer', 'director'] as const;

export type AgeGroup = (typeof AGE_GROUPS)[number];

export const CHILD_INPUT_METHODS = ['touch', 'voice', 'text'] as const;

export type ChildInputMethod = (typeof CHILD_INPUT_METHODS)[number];

export interface ChildInterfaceConfig {
  ageGroup: AgeGroup;
  inputMethods: ChildInputMethod[];
  complexityLevel: 1 | 2 | 3;
  parentControls: boolean;
}

export const PARENT_APPROVAL_REASONS = [
  'complexity_too_high',
  'content_review',
  'runtime_limit',
  'policy_boundary'
] as const;

export type ParentApprovalReason = (typeof PARENT_APPROVAL_REASONS)[number];

export const PARENT_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;

export type ParentApprovalStatus = (typeof PARENT_APPROVAL_STATUSES)[number];

export interface ParentApprovalRequest {
  id: string;
  reason: ParentApprovalReason;
  status: ParentApprovalStatus;
}

export interface ParentApprovalPolicy {
  maxComplexityWithoutApproval: 1 | 2 | 3;
  maxRuntimeSecWithoutApproval: number;
  maxMajorDecisionsWithoutApproval: number;
  maxContentRiskWithoutApproval: number;
}

export interface ParentApprovalPolicyInput {
  complexityLevel: 1 | 2 | 3;
  estimatedRuntimeSec: number;
  requiresContentReview?: boolean;
  policyBoundaryCrossed?: boolean;
  majorDecisionCount?: number;
  contentRiskScore?: number;
}

export interface ParentApprovalGateEvaluation {
  required: boolean;
  reasons: ParentApprovalReason[];
}

export interface StoryChoiceCard {
  id: string;
  title: string;
  detail: string;
}

export interface ExplorerStoryLane {
  ageGroup: 'explorer';
  maxChoicesPerNode: 3;
  maxDepth: 1;
  choices: StoryChoiceCard[];
}

export interface ExplorerPreviewSessionInput {
  choices: readonly StoryChoiceCard[];
  runtimeTargetSec: number;
  majorDecisionCount: number;
  contentRiskScore: number;
}

export interface ExplorerPreviewBranchChoice {
  id: string;
  title: string;
}

export interface ExplorerPreviewSession {
  id: string;
  ageGroup: 'explorer';
  releaseTrack: 'release-2';
  createdAtIso: string;
  runtimeTargetSec: number;
  majorDecisionCount: number;
  contentRiskScore: number;
  choiceOrder: string[];
  branchChoices: ExplorerPreviewBranchChoice[];
  thumbnailLabel: string;
  shortAudioPrompt: string;
}

const defaultChildInterfaceByAge: Record<AgeGroup, ChildInterfaceConfig> = {
  toddler: {
    ageGroup: 'toddler',
    inputMethods: ['touch', 'voice'],
    complexityLevel: 1,
    parentControls: true
  },
  explorer: {
    ageGroup: 'explorer',
    inputMethods: ['touch', 'voice', 'text'],
    complexityLevel: 2,
    parentControls: true
  },
  director: {
    ageGroup: 'director',
    inputMethods: ['touch', 'text'],
    complexityLevel: 3,
    parentControls: true
  }
};

const defaultParentApprovalPolicy: ParentApprovalPolicy = {
  maxComplexityWithoutApproval: 2,
  maxRuntimeSecWithoutApproval: 90,
  maxMajorDecisionsWithoutApproval: 2,
  maxContentRiskWithoutApproval: 0.55
};

const explorerStoryChoiceSeed: StoryChoiceCard[] = [
  {
    id: 'opening-scene',
    title: 'Opening Scene',
    detail: 'Pick how the adventure starts: launch pad, forest gate, or coral tunnel.'
  },
  {
    id: 'helper-character',
    title: 'Helpful Friend',
    detail: 'Choose a guide character to join the journey for one big moment.'
  },
  {
    id: 'twist-moment',
    title: 'Twist Moment',
    detail: 'Insert one surprise challenge that changes the plan.'
  },
  {
    id: 'team-choice',
    title: 'Team Choice',
    detail: 'Decide what the team does together to solve the challenge.'
  },
  {
    id: 'ending-beat',
    title: 'Ending Beat',
    detail: 'Choose the final celebration scene for the story ending.'
  }
];

export function resolveBooleanFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function resolveChildInterfaceConfig(ageGroup: AgeGroup): ChildInterfaceConfig {
  const config = defaultChildInterfaceByAge[ageGroup];

  return {
    ...config,
    inputMethods: [...config.inputMethods]
  };
}

export function resolveParentApprovalReason(
  input: ParentApprovalPolicyInput,
  policy: ParentApprovalPolicy = defaultParentApprovalPolicy
): ParentApprovalReason | null {
  return evaluateParentApprovalGate(input, policy).reasons[0] ?? null;
}

export function evaluateParentApprovalGate(
  input: ParentApprovalPolicyInput,
  policy: ParentApprovalPolicy = defaultParentApprovalPolicy
): ParentApprovalGateEvaluation {
  const reasons: ParentApprovalReason[] = [];

  if (input.policyBoundaryCrossed) {
    reasons.push('policy_boundary');
  }

  if (input.requiresContentReview) {
    reasons.push('content_review');
  }

  if ((input.contentRiskScore ?? 0) > policy.maxContentRiskWithoutApproval) {
    reasons.push('content_review');
  }

  if (input.estimatedRuntimeSec > policy.maxRuntimeSecWithoutApproval) {
    reasons.push('runtime_limit');
  }

  const majorDecisions = input.majorDecisionCount ?? 0;
  if (majorDecisions > policy.maxMajorDecisionsWithoutApproval) {
    reasons.push('complexity_too_high');
  }

  if (input.complexityLevel > policy.maxComplexityWithoutApproval) {
    reasons.push('complexity_too_high');
  }

  return {
    required: reasons.length > 0,
    reasons: Array.from(new Set(reasons))
  };
}

export function createParentApprovalRequest(id: string, reason: ParentApprovalReason): ParentApprovalRequest {
  return {
    id,
    reason,
    status: 'pending'
  };
}

export function createExplorerStoryLane(seedChoices: readonly StoryChoiceCard[] = explorerStoryChoiceSeed): ExplorerStoryLane {
  return {
    ageGroup: 'explorer',
    maxChoicesPerNode: 3,
    maxDepth: 1,
    choices: seedChoices.map((choice) => ({ ...choice }))
  };
}

export function createExplorerPreviewSession(
  input: ExplorerPreviewSessionInput,
  options?: { id?: string; now?: Date }
): ExplorerPreviewSession {
  const now = options?.now ?? new Date();
  const runtimeTargetSec = clampNumber(input.runtimeTargetSec, 30, 240);
  const majorDecisionCount = Math.max(0, Math.floor(input.majorDecisionCount));
  const contentRiskScore = clampNumber(input.contentRiskScore, 0, 1);
  const choiceOrder = input.choices.map((choice) => choice.id);
  const branchChoices = input.choices.slice(0, 3).map((choice) => ({ id: choice.id, title: choice.title }));
  const thumbnailLabel = branchChoices.length > 0 ? branchChoices.map((choice) => choice.title).slice(0, 2).join(' + ') : 'Explorer Preview';
  const shortAudioPrompt = `Preview ${String(runtimeTargetSec)}s with ${String(branchChoices.length)} branch choices.`;

  return {
    id: options?.id ?? `explorer-preview-${String(now.getTime().toString(36))}`,
    ageGroup: 'explorer',
    releaseTrack: 'release-2',
    createdAtIso: now.toISOString(),
    runtimeTargetSec,
    majorDecisionCount,
    contentRiskScore,
    choiceOrder,
    branchChoices,
    thumbnailLabel,
    shortAudioPrompt
  };
}

export function reorderExplorerStoryChoices(
  choices: readonly StoryChoiceCard[],
  fromIndex: number,
  toIndex: number
): StoryChoiceCard[] {
  if (choices.length <= 1) {
    return [...choices];
  }

  const from = clampIndex(fromIndex, choices.length);
  const to = clampIndex(toIndex, choices.length);

  if (from === to) {
    return [...choices];
  }

  const next = [...choices];
  const [moved] = next.splice(from, 1);

  if (!moved) {
    return [...choices];
  }

  next.splice(to, 0, moved);
  return next;
}

function clampIndex(value: number, length: number): number {
  if (length <= 0) {
    return 0;
  }

  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  const lastIndex = length - 1;
  if (value > lastIndex) {
    return lastIndex;
  }

  return Math.floor(value);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  if (value < min) {
    return min;
  }

  if (value > max) {
    return max;
  }

  return value;
}

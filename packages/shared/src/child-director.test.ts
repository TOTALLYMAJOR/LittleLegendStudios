import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildExplorerPromptBundle,
  createExplorerPreviewSession,
  createExplorerStoryLane,
  createParentApprovalRequest,
  evaluateParentApprovalGate,
  reorderExplorerStoryChoices,
  resolveBooleanFlag,
  resolveChildInterfaceConfig,
  resolveParentApprovalReason
} from './child-director.js';

test('resolveChildInterfaceConfig returns age-specific defaults and cloned input methods', () => {
  const explorer = resolveChildInterfaceConfig('explorer');

  assert.equal(explorer.ageGroup, 'explorer');
  assert.equal(explorer.complexityLevel, 2);
  assert.deepEqual(explorer.inputMethods, ['touch', 'voice', 'text']);

  explorer.inputMethods.push('touch');

  const secondResolve = resolveChildInterfaceConfig('explorer');
  assert.deepEqual(secondResolve.inputMethods, ['touch', 'voice', 'text']);
});

test('resolveBooleanFlag accepts explicit truthy values only', () => {
  assert.equal(resolveBooleanFlag(undefined), false);
  assert.equal(resolveBooleanFlag('false'), false);
  assert.equal(resolveBooleanFlag('TRUE'), true);
  assert.equal(resolveBooleanFlag('1'), true);
  assert.equal(resolveBooleanFlag('yes'), true);
  assert.equal(resolveBooleanFlag('on'), true);
});

test('resolveParentApprovalReason prioritizes policy boundaries and content review', () => {
  assert.equal(
    resolveParentApprovalReason({ complexityLevel: 3, estimatedRuntimeSec: 120, policyBoundaryCrossed: true }),
    'policy_boundary'
  );

  assert.equal(
    resolveParentApprovalReason({ complexityLevel: 3, estimatedRuntimeSec: 120, requiresContentReview: true }),
    'content_review'
  );

  assert.equal(resolveParentApprovalReason({ complexityLevel: 3, estimatedRuntimeSec: 40 }), 'complexity_too_high');
  assert.equal(resolveParentApprovalReason({ complexityLevel: 2, estimatedRuntimeSec: 140 }), 'runtime_limit');
  assert.equal(resolveParentApprovalReason({ complexityLevel: 2, estimatedRuntimeSec: 70 }), null);
});

test('evaluateParentApprovalGate centralizes runtime, content, and major-decision thresholds', () => {
  const evaluation = evaluateParentApprovalGate({
    complexityLevel: 2,
    estimatedRuntimeSec: 118,
    majorDecisionCount: 4,
    contentRiskScore: 0.72
  });

  assert.equal(evaluation.required, true);
  assert.deepEqual(evaluation.reasons, ['content_review', 'runtime_limit', 'complexity_too_high']);
});

test('reorderExplorerStoryChoices reorders without mutating the original collection', () => {
  const lane = createExplorerStoryLane();
  const originalOrder = lane.choices.map((choice) => choice.id);

  const reordered = reorderExplorerStoryChoices(lane.choices, 0, 3);
  const reorderedIds = reordered.map((choice) => choice.id);

  assert.notDeepEqual(reorderedIds, originalOrder);
  assert.equal(reorderedIds[3], originalOrder[0]);
  assert.deepEqual(
    lane.choices.map((choice) => choice.id),
    originalOrder
  );
});

test('explorer lane happy-path integration: reorder + approval request creation', () => {
  const lane = createExplorerStoryLane();
  const reordered = reorderExplorerStoryChoices(lane.choices, 4, 1);
  const estimatedRuntimeSec = reordered.length * 24;

  const reason = resolveParentApprovalReason({
    complexityLevel: resolveChildInterfaceConfig('explorer').complexityLevel,
    estimatedRuntimeSec
  });

  assert.equal(reason, 'runtime_limit');

  const approvalRequest = createParentApprovalRequest('explorer-preview', reason);
  assert.deepEqual(approvalRequest, {
    id: 'explorer-preview',
    reason: 'runtime_limit',
    status: 'pending'
  });
});

test('createExplorerPreviewSession constrains branch choices and normalizes values', () => {
  const lane = createExplorerStoryLane();
  const session = createExplorerPreviewSession(
    {
      choices: lane.choices,
      runtimeTargetSec: 400,
      majorDecisionCount: 2.9,
      contentRiskScore: 1.8
    },
    {
      id: 'preview-fixed',
      now: new Date('2026-03-11T00:00:00.000Z')
    }
  );

  assert.equal(session.id, 'preview-fixed');
  assert.equal(session.createdAtIso, '2026-03-11T00:00:00.000Z');
  assert.equal(session.runtimeTargetSec, 240);
  assert.equal(session.majorDecisionCount, 2);
  assert.equal(session.contentRiskScore, 1);
  assert.equal(session.branchChoices.length, 3);
  assert.deepEqual(session.choiceOrder, lane.choices.map((choice) => choice.id));
  assert.equal(session.releaseTrack, 'release-2');
  assert.ok(session.promptBundle);
  assert.match(session.promptBundle?.storyDirectorPrompt ?? '', /Build a 240-second release-2 preview/);
  assert.equal(session.shortAudioPrompt, session.promptBundle?.narrationPrompt);
});

test('buildExplorerPromptBundle returns bounded prompts with safety constraints', () => {
  const bundle = buildExplorerPromptBundle({
    runtimeTargetSec: 92,
    majorDecisionCount: 4,
    contentRiskScore: 0.61,
    branchChoices: [
      { id: 'opening', title: 'Opening Scene' },
      { id: 'helper', title: 'Helpful Friend' },
      { id: 'ending', title: 'Ending Beat' }
    ]
  });

  assert.ok(bundle.systemInstructions.length > 40);
  assert.ok(bundle.storyDirectorPrompt.length > 120);
  assert.ok(bundle.narrationPrompt.length > 40);
  assert.ok(bundle.parentSummaryPrompt.length > 80);
  assert.match(bundle.systemInstructions, /child-directed story copilot/);
  assert.match(bundle.storyDirectorPrompt, /Branch priorities/);
  assert.match(bundle.narrationPrompt, /interactive preview/);
  assert.match(bundle.parentSummaryPrompt, /parent-facing summary/);
});

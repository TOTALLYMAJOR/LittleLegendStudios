'use client';

import {
  createExplorerPreviewSession,
  createExplorerStoryLane,
  createParentApprovalRequest,
  evaluateParentApprovalGate,
  reorderExplorerStoryChoices,
  resolveChildInterfaceConfig,
  type ExplorerPreviewSession,
  type ParentApprovalRequest,
  type StoryChoiceCard
} from '@little/shared/child-director';
import { useEffect, useMemo, useState, type DragEvent } from 'react';

import styles from './child-director.module.css';
import {
  readRelease2PreviewSession,
  readRelease2PreviewSessionFromApi,
  saveRelease2PreviewSessionToApi,
  writeRelease2PreviewSession
} from './release2-preview-session';

const dragDataKey = 'application/x-little-story-choice-id';

function readDraggedChoiceId(event: DragEvent<HTMLElement>): string | null {
  const explicitValue = event.dataTransfer.getData(dragDataKey);
  if (explicitValue) {
    return explicitValue;
  }

  const fallbackValue = event.dataTransfer.getData('text/plain');
  return fallbackValue || null;
}

interface ChildDirectorExplorerBoardProps {
  release2Enabled?: boolean;
}

export function ChildDirectorExplorerBoard({ release2Enabled = false }: ChildDirectorExplorerBoardProps): JSX.Element {
  const explorerConfig = useMemo(() => resolveChildInterfaceConfig('explorer'), []);
  const [choices, setChoices] = useState<StoryChoiceCard[]>(() => createExplorerStoryLane().choices);
  const [draggingChoiceId, setDraggingChoiceId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('Drag cards to reorder the story beats.');
  const [runtimeTargetSec, setRuntimeTargetSec] = useState(() => choices.length * 18);
  const [majorDecisionCount, setMajorDecisionCount] = useState(1);
  const [contentRiskPct, setContentRiskPct] = useState(20);
  const [approvalRequests, setApprovalRequests] = useState<ParentApprovalRequest[]>([]);
  const [release2PreviewSession, setRelease2PreviewSession] = useState<ExplorerPreviewSession | null>(null);
  const [release2PersistedAt, setRelease2PersistedAt] = useState<string | null>(null);
  const [release2ParentLinked, setRelease2ParentLinked] = useState(false);
  const [isSavingRelease2Preview, setIsSavingRelease2Preview] = useState(false);

  const gateEvaluation = evaluateParentApprovalGate({
    complexityLevel: explorerConfig.complexityLevel,
    estimatedRuntimeSec: runtimeTargetSec,
    majorDecisionCount,
    contentRiskScore: contentRiskPct / 100
  });

  useEffect(() => {
    if (gateEvaluation.required) {
      return;
    }

    if (approvalRequests.length > 0) {
      setApprovalRequests([]);
    }
  }, [approvalRequests.length, gateEvaluation.required]);

  useEffect(() => {
    if (!release2Enabled) {
      setRelease2PreviewSession(null);
      setRelease2PersistedAt(null);
      setRelease2ParentLinked(false);
      return;
    }

    const storedSession = readRelease2PreviewSession();
    setRelease2PreviewSession(storedSession);
    if (!storedSession) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const persisted = await readRelease2PreviewSessionFromApi(storedSession.id);
        if (!persisted || cancelled) {
          return;
        }

        setRelease2PreviewSession(persisted.preview);
        setRelease2PersistedAt(persisted.updatedAt);
        setRelease2ParentLinked(persisted.parentLinked);
        setApprovalRequests(persisted.parentApprovalRequests);
        writeRelease2PreviewSession(persisted.preview);
      } catch (error) {
        if (!cancelled) {
          setStatusMessage(`Loaded local release-2 preview session. API sync unavailable: ${(error as Error).message}`);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [release2Enabled]);

  function moveChoiceToIndex(choiceId: string, targetIndex: number): void {
    const sourceIndex = choices.findIndex((choice) => choice.id === choiceId);
    if (sourceIndex < 0) {
      return;
    }

    const maxIndex = Math.max(choices.length - 1, 0);
    const boundedTargetIndex = Math.max(0, Math.min(targetIndex, maxIndex));

    if (sourceIndex === boundedTargetIndex) {
      return;
    }

    const sourceTitle = choices[sourceIndex]?.title ?? 'Story beat';
    const nextChoices = reorderExplorerStoryChoices(choices, sourceIndex, boundedTargetIndex);
    setChoices(nextChoices);
    setStatusMessage(
      `Moved ${sourceTitle} from position ${String(sourceIndex + 1)} to ${String(boundedTargetIndex + 1)}.`
    );
  }

  function onDragStart(event: DragEvent<HTMLElement>, choiceId: string): void {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(dragDataKey, choiceId);
    event.dataTransfer.setData('text/plain', choiceId);
    setDraggingChoiceId(choiceId);
  }

  function onDropAtIndex(event: DragEvent<HTMLElement>, targetIndex: number): void {
    event.preventDefault();
    const choiceId = readDraggedChoiceId(event);
    if (!choiceId) {
      return;
    }

    moveChoiceToIndex(choiceId, targetIndex);
    setDraggingChoiceId(null);
  }

  function onDropAtEnd(event: DragEvent<HTMLElement>): void {
    onDropAtIndex(event, choices.length - 1);
  }

  function moveChoiceByDelta(index: number, delta: -1 | 1): void {
    const choiceId = choices[index]?.id;
    if (!choiceId) {
      return;
    }

    moveChoiceToIndex(choiceId, index + delta);
  }

  function requestParentApproval(): void {
    if (!gateEvaluation.required) {
      return;
    }

    const nextRequests = gateEvaluation.reasons.map((reason, index) =>
      createParentApprovalRequest(`explorer-preview-${String(index + 1)}`, reason)
    );

    setApprovalRequests(nextRequests);
    setStatusMessage(`Parent approval requested for ${String(nextRequests.length)} gate reason(s).`);
  }

  async function createRelease2PreviewSession(): Promise<void> {
    if (!release2Enabled) {
      return;
    }

    const session = createExplorerPreviewSession({
      choices,
      runtimeTargetSec,
      majorDecisionCount,
      contentRiskScore: contentRiskPct / 100
    });

    const linkedApprovalRequests =
      gateEvaluation.required && approvalRequests.length === 0
        ? gateEvaluation.reasons.map((reason, index) =>
            createParentApprovalRequest(`${session.id}-approval-${String(index + 1)}`, reason)
          )
        : approvalRequests;

    writeRelease2PreviewSession(session);
    setRelease2PreviewSession(session);
    if (linkedApprovalRequests.length > 0) {
      setApprovalRequests(linkedApprovalRequests);
    }

    setIsSavingRelease2Preview(true);
    try {
      const persisted = await saveRelease2PreviewSessionToApi({
        session,
        parentApprovalRequests: linkedApprovalRequests
      });
      setRelease2PreviewSession(persisted.preview);
      setRelease2PersistedAt(persisted.updatedAt);
      setRelease2ParentLinked(persisted.parentLinked);
      setApprovalRequests(persisted.parentApprovalRequests);
      setStatusMessage(
        `Release 2 preview session saved to API: ${persisted.sessionId} (parent linked: ${persisted.parentLinked ? 'yes' : 'no'}).`
      );
    } catch (error) {
      setRelease2PersistedAt(null);
      setRelease2ParentLinked(false);
      setStatusMessage(`Release 2 preview session saved locally. API persistence failed: ${(error as Error).message}`);
    } finally {
      setIsSavingRelease2Preview(false);
    }
  }

  return (
    <section className="card">
      <header className={styles.header}>
        <h2>Explorer Story Lane</h2>
        <p>
          Child-facing prototype: drag cards to shape the story order. Arrow controls are included as touch and keyboard fallback.
        </p>
      </header>

      <div className={styles.lane} role="list" aria-label="Explorer story beats">
        {choices.map((choice, index) => {
          const isDragging = draggingChoiceId === choice.id;

          return (
            <article
              key={choice.id}
              role="listitem"
              className={`${styles.card} ${isDragging ? styles.cardDragging : ''}`}
              draggable
              onDragStart={(event) => onDragStart(event, choice.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => onDropAtIndex(event, index)}
              onDragEnd={() => setDraggingChoiceId(null)}
            >
              <div className={styles.cardMeta}>
                <span className={styles.cardIndex}>{String(index + 1).padStart(2, '0')}</span>
                <h3>{choice.title}</h3>
              </div>
              <p>{choice.detail}</p>
              <div className={styles.actions}>
                <button type="button" disabled={index === 0} onClick={() => moveChoiceByDelta(index, -1)}>
                  Move Left
                </button>
                <button
                  type="button"
                  disabled={index === choices.length - 1}
                  onClick={() => moveChoiceByDelta(index, 1)}
                >
                  Move Right
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <div className={styles.dropTail} onDragOver={(event) => event.preventDefault()} onDrop={onDropAtEnd}>
        Drop here to move a card to the end.
      </div>

      <section className={styles.gateControls}>
        <h3>Parent Approval Gate</h3>
        <label htmlFor="runtime-target">
          Runtime target: <strong>{runtimeTargetSec}s</strong>
        </label>
        <input
          id="runtime-target"
          type="range"
          min={45}
          max={180}
          step={5}
          value={runtimeTargetSec}
          onChange={(event) => setRuntimeTargetSec(Number(event.target.value))}
        />

        <label htmlFor="major-decisions">
          Major decisions: <strong>{majorDecisionCount}</strong>
        </label>
        <input
          id="major-decisions"
          type="range"
          min={0}
          max={6}
          step={1}
          value={majorDecisionCount}
          onChange={(event) => setMajorDecisionCount(Number(event.target.value))}
        />

        <label htmlFor="content-risk">
          Content risk signal: <strong>{contentRiskPct}%</strong>
        </label>
        <input
          id="content-risk"
          type="range"
          min={0}
          max={100}
          step={1}
          value={contentRiskPct}
          onChange={(event) => setContentRiskPct(Number(event.target.value))}
        />

        <p>
          Gate required:{' '}
          <strong>{gateEvaluation.required ? `yes (${gateEvaluation.reasons.join(', ')})` : 'no'}</strong>
        </p>
        <button type="button" disabled={!gateEvaluation.required} onClick={requestParentApproval}>
          Request Parent Approval
        </button>
        {approvalRequests.length > 0 ? (
          <ul className={styles.approvalList}>
            {approvalRequests.map((request) => (
              <li key={request.id}>
                {request.id}: {request.status} ({request.reason})
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className={styles.gateControls}>
        <h3>Release 2 Pilot Gate</h3>
        <p>
          Release 2 flag status: <strong>{release2Enabled ? 'enabled' : 'disabled'}</strong>
        </p>
        <button type="button" disabled={!release2Enabled || isSavingRelease2Preview} onClick={createRelease2PreviewSession}>
          {isSavingRelease2Preview ? 'Saving Release 2 Preview Session...' : 'Create Release 2 Preview Session'}
        </button>
        {release2PreviewSession ? (
          <ul className={styles.approvalList}>
            <li>Latest preview session: {release2PreviewSession.id}</li>
            <li>Created: {release2PreviewSession.createdAtIso}</li>
            <li>API persisted: {release2PersistedAt ? 'yes' : 'local only'}</li>
            <li>Parent linked: {release2ParentLinked ? 'yes' : 'no'}</li>
            <li>Persisted at: {release2PersistedAt ?? 'n/a'}</li>
            <li>Thumbnail label: {release2PreviewSession.thumbnailLabel}</li>
            <li>Audio prompt: {release2PreviewSession.shortAudioPrompt}</li>
            <li>Branch choices: {release2PreviewSession.branchChoices.map((choice) => choice.title).join(', ')}</li>
          </ul>
        ) : null}
      </section>

      <p className={styles.status} aria-live="polite">
        {statusMessage}
      </p>

      <section className={styles.summary}>
        <h3>Slice Summary</h3>
        <ul>
          <li>Age group: {explorerConfig.ageGroup}</li>
          <li>Input methods: {explorerConfig.inputMethods.join(', ')}</li>
          <li>Complexity level: {explorerConfig.complexityLevel}</li>
          <li>Runtime target: {runtimeTargetSec}s</li>
          <li>Major decisions: {majorDecisionCount}</li>
          <li>Content risk: {contentRiskPct}%</li>
          <li>Parent gate reasons: {gateEvaluation.reasons.join(', ') || 'none'}</li>
        </ul>
      </section>
    </section>
  );
}

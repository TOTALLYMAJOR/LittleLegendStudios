'use client';

import {
  buildExplorerPromptBundle,
  createExplorerPreviewSession,
  createExplorerStoryLane,
  createParentApprovalRequest,
  evaluateParentApprovalGate,
  reorderExplorerStoryChoices,
  resolveChildInterfaceConfig,
  type ExplorerPromptBundle,
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

interface ScenePuzzlePiece {
  title: string;
  subtitle: string;
  gradientStart: string;
  gradientEnd: string;
}

const scenePuzzlePiecesByChoiceId: Record<string, readonly ScenePuzzlePiece[]> = {
  'opening-scene': [
    { title: 'Launch Pad', subtitle: 'Countdown Spark', gradientStart: '#f5b04a', gradientEnd: '#2b4f87' },
    { title: 'Spark Sky', subtitle: 'Cloud Trail', gradientStart: '#79c4ff', gradientEnd: '#4b3f88' },
    { title: 'Hero Wave', subtitle: 'Crowd Cheer', gradientStart: '#ff907f', gradientEnd: '#5a3e80' }
  ],
  'helper-character': [
    { title: 'Guide Friend', subtitle: 'Meetup Moment', gradientStart: '#6ec1a9', gradientEnd: '#2f5d85' },
    { title: 'Signal Star', subtitle: 'Sky Clue', gradientStart: '#8fd7ff', gradientEnd: '#4361a8' },
    { title: 'Map Light', subtitle: 'Path Reveal', gradientStart: '#ffd57d', gradientEnd: '#4d5e92' }
  ],
  'twist-moment': [
    { title: 'Storm Cloud', subtitle: 'Fast Shift', gradientStart: '#8fa8db', gradientEnd: '#3f436f' },
    { title: 'Lost Key', subtitle: 'Puzzle Alert', gradientStart: '#f2a2a8', gradientEnd: '#563f79' },
    { title: 'Fast Choice', subtitle: 'Quick Plan', gradientStart: '#82d8c6', gradientEnd: '#305b8c' }
  ],
  'team-choice': [
    { title: 'Puzzle Door', subtitle: 'Group Move', gradientStart: '#9bc8ff', gradientEnd: '#3b4b9a' },
    { title: 'Team Stack', subtitle: 'Build Bridge', gradientStart: '#ffd27a', gradientEnd: '#4a5b93' },
    { title: 'Bridge Jump', subtitle: 'Safe Landing', gradientStart: '#ff9a9a', gradientEnd: '#654290' }
  ],
  'ending-beat': [
    { title: 'Confetti', subtitle: 'Finale Burst', gradientStart: '#ffd57e', gradientEnd: '#6d4fa0' },
    { title: 'Victory Hug', subtitle: 'Happy Close', gradientStart: '#8fdbd1', gradientEnd: '#356093' },
    { title: 'Final Frame', subtitle: 'Movie Wrap', gradientStart: '#9fc3ff', gradientEnd: '#4f4c95' }
  ]
};

function readDraggedChoiceId(event: DragEvent<HTMLElement>): string | null {
  const explicitValue = event.dataTransfer.getData(dragDataKey);
  if (explicitValue) {
    return explicitValue;
  }

  const fallbackValue = event.dataTransfer.getData('text/plain');
  return fallbackValue || null;
}

function escapeSvgText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function createScenePuzzleImageDataUri(piece: ScenePuzzlePiece, sceneIndex: number, pieceIndex: number): string {
  const sceneLabel = `Scene ${String(sceneIndex + 1)}`;
  const frameLabel = `Frame ${String(pieceIndex + 1)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 180">
<defs>
<linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
<stop offset="0%" stop-color="${piece.gradientStart}"/>
<stop offset="100%" stop-color="${piece.gradientEnd}"/>
</linearGradient>
</defs>
<rect width="280" height="180" rx="12" fill="url(#bg)"/>
<rect x="10" y="10" width="260" height="160" rx="9" fill="rgba(6,12,22,0.26)" stroke="rgba(255,255,255,0.38)"/>
<circle cx="228" cy="45" r="24" fill="rgba(255,255,255,0.2)"/>
<path d="M30 135 C85 92, 146 150, 234 102 L250 156 L30 156 Z" fill="rgba(16,24,35,0.45)"/>
<text x="22" y="34" fill="rgba(255,255,255,0.9)" font-size="16" font-family="Arial, sans-serif">${escapeSvgText(sceneLabel)}</text>
<text x="22" y="58" fill="rgba(255,255,255,0.9)" font-size="14" font-family="Arial, sans-serif">${escapeSvgText(frameLabel)}</text>
<text x="22" y="134" fill="rgba(255,255,255,0.96)" font-size="20" font-family="Arial, sans-serif">${escapeSvgText(piece.title)}</text>
<text x="22" y="156" fill="rgba(235,244,255,0.95)" font-size="13" font-family="Arial, sans-serif">${escapeSvgText(piece.subtitle)}</text>
</svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function resolveScenePuzzlePieces(choice: StoryChoiceCard): ScenePuzzlePiece[] {
  const pieces = scenePuzzlePiecesByChoiceId[choice.id];
  if (pieces && pieces.length > 0) {
    return [...pieces];
  }

  return [
    {
      title: choice.title,
      subtitle: 'Camera Move',
      gradientStart: '#9fc1ff',
      gradientEnd: '#4d4f8f'
    },
    {
      title: 'Action Beat',
      subtitle: 'Hero Motion',
      gradientStart: '#ffd488',
      gradientEnd: '#4f6397'
    },
    {
      title: 'Final Cut',
      subtitle: 'Story Wrap',
      gradientStart: '#8fdccc',
      gradientEnd: '#3d5d95'
    }
  ];
}

interface ChildDirectorExplorerBoardProps {
  release2Enabled?: boolean;
}

export function ChildDirectorExplorerBoard({ release2Enabled = false }: ChildDirectorExplorerBoardProps): JSX.Element {
  const explorerConfig = useMemo(() => resolveChildInterfaceConfig('explorer'), []);
  const [choices, setChoices] = useState<StoryChoiceCard[]>(() => createExplorerStoryLane().choices);
  const [draggingChoiceId, setDraggingChoiceId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('Drag scene frames to puzzle together your movie strip.');
  const [runtimeTargetSec, setRuntimeTargetSec] = useState(() => choices.length * 18);
  const [majorDecisionCount, setMajorDecisionCount] = useState(1);
  const [contentRiskPct, setContentRiskPct] = useState(20);
  const [approvalRequests, setApprovalRequests] = useState<ParentApprovalRequest[]>([]);
  const [release2PreviewSession, setRelease2PreviewSession] = useState<ExplorerPreviewSession | null>(null);
  const [release2PersistedAt, setRelease2PersistedAt] = useState<string | null>(null);
  const [release2ParentLinked, setRelease2ParentLinked] = useState(false);
  const [isSavingRelease2Preview, setIsSavingRelease2Preview] = useState(false);
  const [promptCopyMessage, setPromptCopyMessage] = useState('');

  const gateEvaluation = evaluateParentApprovalGate({
    complexityLevel: explorerConfig.complexityLevel,
    estimatedRuntimeSec: runtimeTargetSec,
    majorDecisionCount,
    contentRiskScore: contentRiskPct / 100
  });
  const adventureEnergy = Math.max(0, Math.min(100, Math.round(((runtimeTargetSec - 45) / (180 - 45)) * 100)));
  const safetyTone = contentRiskPct <= 30 ? 'gentle' : contentRiskPct <= 60 ? 'balanced' : 'high-alert';

  const release2PromptBundle = useMemo<ExplorerPromptBundle | null>(() => {
    if (!release2PreviewSession) {
      return null;
    }

    if (release2PreviewSession.promptBundle) {
      return release2PreviewSession.promptBundle;
    }

    return buildExplorerPromptBundle({
      runtimeTargetSec: release2PreviewSession.runtimeTargetSec,
      majorDecisionCount: release2PreviewSession.majorDecisionCount,
      contentRiskScore: release2PreviewSession.contentRiskScore,
      branchChoices: release2PreviewSession.branchChoices
    });
  }, [release2PreviewSession]);

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

    const sourceTitle = choices[sourceIndex]?.title ?? 'Scene';
    const nextChoices = reorderExplorerStoryChoices(choices, sourceIndex, boundedTargetIndex);
    setChoices(nextChoices);
    setStatusMessage(
      `Moved ${sourceTitle} from scene ${String(sourceIndex + 1)} to scene ${String(boundedTargetIndex + 1)}.`
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

  async function copyRelease2PromptBundle(): Promise<void> {
    if (!release2PromptBundle) {
      setPromptCopyMessage('Create a release-2 preview session first.');
      return;
    }

    if (!navigator?.clipboard?.writeText) {
      setPromptCopyMessage('Clipboard access is unavailable in this browser context.');
      return;
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(release2PromptBundle, null, 2));
      setPromptCopyMessage('Prompt bundle copied to clipboard.');
    } catch (error) {
      setPromptCopyMessage(`Copy failed: ${(error as Error).message}`);
    }
  }

  return (
    <section className={`card ${styles.explorerShell}`}>
      <header className={styles.kidHero}>
        <p className={styles.kidHeroEyebrow}>Explorer Playground</p>
        <h2>Puzzle a Movie Strip</h2>
        <p>
          Arrange multiple scene frames like puzzle images on a film strip, then save a release-2 preview. Arrow controls are included as a touch and keyboard fallback.
        </p>
        <div className={styles.heroBadges}>
          <span>Energy: {adventureEnergy}%</span>
          <span>Safety tone: {safetyTone}</span>
          <span>Scenes: {choices.length}</span>
        </div>
        <div className={styles.energyRail} aria-label="Adventure energy meter">
          <span style={{ width: `${String(adventureEnergy)}%` }} />
        </div>
      </header>

      <div className={styles.filmStrip} role="list" aria-label="Explorer movie strip scenes">
        {choices.map((choice, index) => {
          const isDragging = draggingChoiceId === choice.id;
          const scenePuzzlePieces = resolveScenePuzzlePieces(choice);
          const toneClass = styles[`scenePreviewTone${String((index % 4) + 1)}` as keyof typeof styles] ?? '';

          return (
            <article
              key={choice.id}
              role="listitem"
              className={`${styles.card} ${styles.sceneCard} ${isDragging ? styles.cardDragging : ''}`}
              draggable
              onDragStart={(event) => onDragStart(event, choice.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => onDropAtIndex(event, index)}
              onDragEnd={() => setDraggingChoiceId(null)}
            >
              <div className={`${styles.scenePreview} ${toneClass}`} aria-hidden="true">
                {scenePuzzlePieces.map((piece, pieceIndex) => (
                  <span key={`${choice.id}-piece-${String(pieceIndex + 1)}`} className={styles.scenePuzzlePiece}>
                    <img
                      className={styles.scenePuzzleImage}
                      src={createScenePuzzleImageDataUri(piece, index, pieceIndex)}
                      alt={`${piece.title} puzzle frame`}
                      loading="lazy"
                    />
                    <span className={styles.scenePuzzleLabel}>
                      {piece.title} - {piece.subtitle}
                    </span>
                  </span>
                ))}
              </div>
              <span className={styles.cardSticker}>Scene {String(index + 1)}</span>
              <div className={styles.cardMeta}>
                <span className={styles.cardIndex}>{String(index + 1).padStart(2, '0')}</span>
                <h3>{choice.title}</h3>
              </div>
              <p>{choice.detail}</p>
              <div className={styles.actions}>
                <button type="button" disabled={index === 0} onClick={() => moveChoiceByDelta(index, -1)}>
                  Move Scene Earlier
                </button>
                <button
                  type="button"
                  disabled={index === choices.length - 1}
                  onClick={() => moveChoiceByDelta(index, 1)}
                >
                  Move Scene Later
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <div className={styles.dropTail} onDragOver={(event) => event.preventDefault()} onDrop={onDropAtEnd}>
        Drop here to place this scene at the finale.
      </div>

      <section className={styles.gateControls}>
        <h3>Grown-up Checkpoint</h3>
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
        <h3>Release 2 Save + Prompt Kit</h3>
        <p>
          Release 2 flag status: <strong>{release2Enabled ? 'enabled' : 'disabled'}</strong>
        </p>
        <button type="button" disabled={!release2Enabled || isSavingRelease2Preview} onClick={createRelease2PreviewSession}>
          {isSavingRelease2Preview ? 'Saving Release 2 Preview Session...' : 'Create Release 2 Preview Session'}
        </button>
        <button type="button" disabled={!release2Enabled || !release2PromptBundle} onClick={() => void copyRelease2PromptBundle()}>
          Copy Prompt Bundle JSON
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
        {release2PromptBundle ? (
          <details className={styles.promptDetails}>
            <summary>Robust Prompt Bundle</summary>
            <pre className={styles.promptCode}>{JSON.stringify(release2PromptBundle, null, 2)}</pre>
          </details>
        ) : null}
        {promptCopyMessage ? <p className={styles.promptStatus}>{promptCopyMessage}</p> : null}
      </section>

      <p className={styles.statusBubble} aria-live="polite">
        {statusMessage}
      </p>

      <section className={styles.summary}>
        <h3>Slice Summary</h3>
        <ul>
          <li>Age group: {explorerConfig.ageGroup}</li>
          <li>Input methods: {explorerConfig.inputMethods.join(', ')}</li>
          <li>Complexity level: {explorerConfig.complexityLevel}</li>
          <li>Scene strip order: {choices.map((choice) => choice.title).join(' -> ')}</li>
          <li>Runtime target: {runtimeTargetSec}s</li>
          <li>Major decisions: {majorDecisionCount}</li>
          <li>Content risk: {contentRiskPct}%</li>
          <li>Parent gate reasons: {gateEvaluation.reasons.join(', ') || 'none'}</li>
        </ul>
      </section>
    </section>
  );
}

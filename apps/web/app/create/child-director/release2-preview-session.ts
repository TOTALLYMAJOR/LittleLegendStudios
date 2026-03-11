import type { ExplorerPreviewSession, ParentApprovalRequest } from '@little/shared/child-director';

const release2PreviewSessionStorageKey = 'little:child-director:release2-preview-session';
const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

export interface PersistedRelease2PreviewSession {
  id: string;
  sessionId: string;
  parentLinked: boolean;
  ageGroup: string;
  releaseTrack: string;
  preview: ExplorerPreviewSession;
  parentApprovalRequests: ParentApprovalRequest[];
  createdAt: string;
  updatedAt: string;
}

export function readRelease2PreviewSession(): ExplorerPreviewSession | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(release2PreviewSessionStorageKey);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as ExplorerPreviewSession;
  } catch {
    window.localStorage.removeItem(release2PreviewSessionStorageKey);
    return null;
  }
}

export function writeRelease2PreviewSession(session: ExplorerPreviewSession): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(release2PreviewSessionStorageKey, JSON.stringify(session));
}

export async function saveRelease2PreviewSessionToApi(args: {
  session: ExplorerPreviewSession;
  parentApprovalRequests: ParentApprovalRequest[];
}): Promise<PersistedRelease2PreviewSession> {
  const response = await fetch(`${apiBase}/child-director/preview-sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({
      sessionId: args.session.id,
      ageGroup: args.session.ageGroup,
      releaseTrack: args.session.releaseTrack,
      preview: args.session,
      parentApprovalRequests: args.parentApprovalRequests
    })
  });

  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, 'Failed to save release-2 preview session.'));
  }

  return parsePersistedRelease2PreviewSession(await response.json());
}

export async function readRelease2PreviewSessionFromApi(sessionId: string): Promise<PersistedRelease2PreviewSession | null> {
  const response = await fetch(`${apiBase}/child-director/preview-sessions/${encodeURIComponent(sessionId)}`, {
    method: 'GET',
    credentials: 'include'
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, 'Failed to load release-2 preview session.'));
  }

  return parsePersistedRelease2PreviewSession(await response.json());
}

async function readApiErrorMessage(response: Response, fallbackMessage: string): Promise<string> {
  try {
    const data = (await response.json()) as { message?: string };
    if (data?.message && data.message.trim().length > 0) {
      return data.message;
    }
  } catch {
    // no-op
  }

  return fallbackMessage;
}

function parsePersistedRelease2PreviewSession(value: unknown): PersistedRelease2PreviewSession {
  const payload = value as PersistedRelease2PreviewSession;
  return {
    ...payload,
    preview: payload.preview as ExplorerPreviewSession,
    parentApprovalRequests: (payload.parentApprovalRequests ?? []) as ParentApprovalRequest[]
  };
}

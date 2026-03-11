'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { resolveChildDirectorFlags } from '../lib/child-director-flags';
import { persistParentSessionToken, readParentSessionTokenFromBrowser } from '../lib/parent-session';
import { resolveThemePreviewClip } from '../lib/theme-preview-clips';

type Theme = {
  id: string;
  slug: string;
  name: string;
  description: string;
};

type GeneratedScript = {
  id: string;
  version: number;
  script_json: {
    title: string;
    narration: string[];
    shots: Array<{
      shotNumber: number;
      durationSec: number;
      action: string;
      dialogue: string;
    }>;
  };
  previewArtifact?: {
    kind: 'preview_video';
    s3Key: string;
    meta: {
      signedDownloadUrl?: string;
      [key: string]: unknown;
    };
  };
};

type PayResponse = {
  provider: 'stripe' | 'stripe_stub';
  checkoutUrl?: string;
  paymentIntentId?: string;
};

type UploadSignResponse = {
  uploadId: string;
  s3Key: string;
  signedUploadUrl: string;
  expiresInSec: number;
};

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';
const launchPriceLabel = '$39';
const allowedPhotoTypes = new Set(['image/jpeg', 'image/png']);
const allowedVoiceTypes = new Set(['audio/wav', 'audio/m4a', 'audio/x-m4a', 'audio/mp4']);
const themeCutFrameMs = 420;
const childDirectorFlags = resolveChildDirectorFlags();

type StepKey = 'identity' | 'order' | 'upload' | 'scriptPayment';
type StepState = 'locked' | 'active' | 'complete';
type UploadStatus = 'selected' | 'uploading' | 'uploaded' | 'failed';

interface MediaUploadItem {
  id: string;
  file: File;
  previewUrl?: string;
  status: UploadStatus;
  errorMessage: string | null;
}

interface ActionLoadingState {
  loadThemes: boolean;
  upsertUser: boolean;
  createOrder: boolean;
  signUploads: boolean;
  generateScript: boolean;
  approveScript: boolean;
  pay: boolean;
}

interface StepMessages {
  identity: string;
  order: string;
  upload: string;
  scriptPayment: string;
}

interface UploadProgressState {
  totalFiles: number;
  uploadedFiles: number;
  activeFileName: string | null;
  failedFileName: string | null;
}

interface UploadAttemptResult {
  uploaded: number;
  failed: number;
}

interface ThemeCutPreset {
  id: string;
  kicker: string;
  vibe: string;
  palette: [string, string, string];
  cuts: string[];
}

const themeCutPresetMap: Record<string, ThemeCutPreset> = {
  space: {
    id: 'space',
    kicker: 'Galactic Launch Cut',
    vibe: 'Fast cosmic rise and hero return',
    palette: ['rgba(111, 197, 255, 0.42)', 'rgba(128, 255, 233, 0.34)', 'rgba(255, 245, 210, 0.26)'],
    cuts: [
      'Ignition countdown over neon launch glass.',
      'Rocket corridor blur with starfield streaks.',
      'Nebula drift around the little hero.',
      'Comet arc slingshots past moonlight rings.',
      'Cabin close-up with triumph grin.',
      'Golden reentry over home skyline.',
      'Landing flare and cheering finale.'
    ]
  },
  fantasy: {
    id: 'fantasy',
    kicker: 'Enchanted Arc Cut',
    vibe: 'Storybook momentum with luminous reveal beats',
    palette: ['rgba(186, 155, 255, 0.42)', 'rgba(245, 211, 158, 0.32)', 'rgba(255, 248, 224, 0.24)'],
    cuts: [
      'Castle gate bloom through morning mist.',
      'Lantern path rush into moonlit woods.',
      'Spellburst ribbons sweep around the hero.',
      'Dragon-shadow flyover above the battlements.',
      'Crown room glow with glittering confetti.',
      'Royal balcony wave in golden light.',
      'Final storybook page snap shut.'
    ]
  },
  underwater: {
    id: 'underwater',
    kicker: 'Bioluminescent Cut',
    vibe: 'Pulsing reef color, drift, and magical payoff',
    palette: ['rgba(112, 228, 250, 0.42)', 'rgba(133, 158, 255, 0.34)', 'rgba(208, 255, 244, 0.24)'],
    cuts: [
      'Coral gate drop into sapphire haze.',
      'Jellylight flash across pearl columns.',
      'Hero glide through ribboning kelp.',
      'Whale-song pulse shakes glowing water.',
      'Mermaid court spin under crystal domes.',
      'Shell-throne reveal in turquoise bloom.',
      'Tide-surge celebration with sparkle wake.'
    ]
  },
  superhero: {
    id: 'superhero',
    kicker: 'Origin Burst Cut',
    vibe: 'Street-level impact and skyline acceleration',
    palette: ['rgba(255, 143, 124, 0.44)', 'rgba(255, 214, 123, 0.35)', 'rgba(255, 246, 223, 0.24)'],
    cuts: [
      'Signal flare ignites over storm clouds.',
      'Rooftop sprint with comic speed lines.',
      'Skyline dive between glass towers.',
      'Power-charge shockwave in city square.',
      'Cape snap and crowd cheer close-up.',
      'Aerial spin with sunset lens streak.',
      'Hero landing freeze-frame finale.'
    ]
  }
};

function sanitizeReturnTo(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return null;
  }

  return value;
}

function createIdempotencyKey(prefix: string): string {
  return `${prefix}:${Date.now()}:${crypto.randomUUID()}`;
}

function createLocalFileId(): string {
  return `local:${Date.now()}:${crypto.randomUUID()}`;
}

function photoFingerprint(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function revokePreviewUrl(previewUrl: string): void {
  URL.revokeObjectURL(previewUrl);
}

function resolveThemeCutPreset(themeSlug: string, themeName: string): ThemeCutPreset {
  const key = `${themeSlug} ${themeName}`.toLowerCase();

  if (key.includes('space')) {
    return themeCutPresetMap.space;
  }
  if (key.includes('fantasy') || key.includes('kingdom')) {
    return themeCutPresetMap.fantasy;
  }
  if (key.includes('underwater') || key.includes('ocean') || key.includes('sea')) {
    return themeCutPresetMap.underwater;
  }
  if (key.includes('superhero') || key.includes('hero')) {
    return themeCutPresetMap.superhero;
  }

  return {
    id: 'generic',
    kicker: 'Theme Momentum Cut',
    vibe: 'Fast cinematic snapshots of your selected world',
    palette: ['rgba(141, 200, 196, 0.36)', 'rgba(228, 180, 110, 0.3)', 'rgba(255, 248, 224, 0.22)'],
    cuts: [
      'Opening reveal with dramatic atmosphere.',
      'Hero movement beat through world landmarks.',
      'Camera whip into high-energy transition.',
      'Signature theme detail in close-up.',
      'Crescendo moment with color burst.',
      'Emotional reaction beat for the child hero.',
      'Triumphant final frame and resolve.'
    ]
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }

  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const parentAccessToken = typeof window === 'undefined' ? null : readParentSessionTokenFromBrowser();

  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(parentAccessToken ? { 'x-parent-access-token': parentAccessToken } : {}),
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

async function fileSha256(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function uploadFileToSignedUrl(args: {
  signedUploadUrl: string;
  contentType: string;
  file: File;
}): Promise<void> {
  const response = await fetch(args.signedUploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': args.contentType
    },
    body: args.file
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Signed upload failed (${response.status}).`);
  }
}

function CreateOrderPageContent(): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const latestPhotoUploadsRef = useRef<MediaUploadItem[]>([]);
  const themeCutVideoRef = useRef<HTMLVideoElement | null>(null);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [email, setEmail] = useState('');
  const [childName, setChildName] = useState('');
  const [themeSlug, setThemeSlug] = useState('');
  const [userId, setUserId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [paymentIdempotencyKey, setPaymentIdempotencyKey] = useState('');
  const [script, setScript] = useState<GeneratedScript | null>(null);
  const [isScriptApproved, setIsScriptApproved] = useState(false);
  const [paymentQueued, setPaymentQueued] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [photoUploads, setPhotoUploads] = useState<MediaUploadItem[]>([]);
  const [voiceUpload, setVoiceUpload] = useState<MediaUploadItem | null>(null);
  const [isPhotoDropActive, setIsPhotoDropActive] = useState(false);
  const [isVoiceDropActive, setIsVoiceDropActive] = useState(false);
  const [themeCutFrame, setThemeCutFrame] = useState(0);
  const [themePreviewUnavailable, setThemePreviewUnavailable] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [stepMessages, setStepMessages] = useState<StepMessages>({
    identity: 'Enter parent email to load or create account context.',
    order: 'Load themes, select one, confirm consent, and create an order.',
    upload: 'Select 5-15 photos and one voice sample.',
    scriptPayment: 'Generate, approve, then pay to queue rendering.'
  });
  const [actionLoading, setActionLoading] = useState<ActionLoadingState>({
    loadThemes: false,
    upsertUser: false,
    createOrder: false,
    signUploads: false,
    generateScript: false,
    approveScript: false,
    pay: false
  });
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState>({
    totalFiles: 0,
    uploadedFiles: 0,
    activeFileName: null,
    failedFileName: null
  });
  const returnTo = sanitizeReturnTo(searchParams.get('returnTo'));
  const recoveringOrderId = returnTo?.match(/^\/orders\/([^/?#]+)/)?.[1] ?? null;

  const selectedTheme = useMemo(
    () => themes.find((theme) => theme.slug === themeSlug) ?? null,
    [themes, themeSlug]
  );
  const activeThemeCut = useMemo(
    () => resolveThemeCutPreset(themeSlug, selectedTheme?.name ?? ''),
    [themeSlug, selectedTheme?.name]
  );
  const activeThemePreviewClip = useMemo(
    () => resolveThemePreviewClip(`${themeSlug} ${selectedTheme?.name ?? ''}`),
    [themeSlug, selectedTheme?.name]
  );
  const activeThemeCutLine = activeThemeCut.cuts[themeCutFrame] ?? activeThemeCut.cuts[0] ?? '';
  const themeCutStyle = {
    '--theme-cut-primary': activeThemeCut.palette[0],
    '--theme-cut-secondary': activeThemeCut.palette[1],
    '--theme-cut-tertiary': activeThemeCut.palette[2]
  } as CSSProperties;

  const photoCount = photoUploads.length;
  const photoBytes = useMemo(() => photoUploads.reduce((sum, item) => sum + item.file.size, 0), [photoUploads]);
  const uploadedPhotoCount = useMemo(
    () => photoUploads.filter((item) => item.status === 'uploaded').length,
    [photoUploads]
  );
  const failedPhotoCount = useMemo(
    () => photoUploads.filter((item) => item.status === 'failed').length,
    [photoUploads]
  );
  const uploadComplete = useMemo(() => {
    if (photoUploads.length < 5 || photoUploads.length > 15) {
      return false;
    }
    if (!voiceUpload) {
      return false;
    }
    if (voiceUpload.status !== 'uploaded') {
      return false;
    }
    return photoUploads.every((item) => item.status === 'uploaded');
  }, [photoUploads, voiceUpload]);

  const canCreateUser = useMemo(() => email.length > 3, [email]);
  const canCreateOrder = useMemo(
    () => userId.length > 0 && themeSlug.length > 0 && consentChecked,
    [themeSlug, userId, consentChecked]
  );
  const canGenerateScript = useMemo(
    () => Boolean(orderId.length > 0 && childName.length > 0 && uploadComplete),
    [orderId, childName, uploadComplete]
  );
  const canPay = useMemo(() => orderId.length > 0 && Boolean(script) && isScriptApproved, [isScriptApproved, orderId, script]);
  const isAnyActionLoading = useMemo(() => Object.values(actionLoading).some(Boolean), [actionLoading]);
  const uploadProgressPct = useMemo(() => {
    if (uploadProgress.totalFiles <= 0) {
      return 0;
    }
    return Math.round((uploadProgress.uploadedFiles / uploadProgress.totalFiles) * 100);
  }, [uploadProgress.totalFiles, uploadProgress.uploadedFiles]);

  const stepIndex = useMemo(() => {
    if (!userId) {
      return 1;
    }
    if (!orderId) {
      return 2;
    }
    if (!uploadComplete) {
      return 3;
    }
    return 4;
  }, [
    userId,
    orderId,
    uploadComplete
  ]);

  const stepStates: Record<StepKey, StepState> = useMemo(
    () => ({
      identity: userId ? 'complete' : stepIndex === 1 ? 'active' : 'locked',
      order: orderId ? 'complete' : stepIndex === 2 ? 'active' : 'locked',
      upload: uploadComplete ? 'complete' : stepIndex === 3 ? 'active' : 'locked',
      scriptPayment: paymentQueued ? 'complete' : stepIndex === 4 ? 'active' : 'locked'
    }),
    [
      userId,
      orderId,
      stepIndex,
      uploadComplete,
      paymentQueued
    ]
  );

  useEffect(() => {
    latestPhotoUploadsRef.current = photoUploads;
  }, [photoUploads]);

  useEffect(() => {
    return () => {
      for (const photo of latestPhotoUploadsRef.current) {
        if (photo.previewUrl) {
          revokePreviewUrl(photo.previewUrl);
        }
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = (): void => setPrefersReducedMotion(mediaQuery.matches);
    updatePreference();
    mediaQuery.addEventListener('change', updatePreference);
    return () => mediaQuery.removeEventListener('change', updatePreference);
  }, []);

  useEffect(() => {
    setThemeCutFrame(0);
  }, [activeThemeCut.id, themeSlug]);

  useEffect(() => {
    if (!themeSlug || prefersReducedMotion || activeThemeCut.cuts.length < 2) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setThemeCutFrame((current) => (current + 1) % activeThemeCut.cuts.length);
    }, themeCutFrameMs);

    return () => window.clearInterval(intervalId);
  }, [themeSlug, prefersReducedMotion, activeThemeCut.id, activeThemeCut.cuts.length]);

  useEffect(() => {
    if (!themeSlug) {
      return;
    }

    const video = themeCutVideoRef.current;
    if (!video) {
      return;
    }

    setThemePreviewUnavailable(false);
    video.load();

    const restartThemeCut = (): void => {
      video.currentTime = activeThemePreviewClip.startSec;
      video.playbackRate = 1.14;

      if (prefersReducedMotion) {
        video.pause();
        return;
      }

      void video.play().catch(() => {
        // Ignore autoplay rejection and rely on replay button user interaction.
      });
    };

    if (video.readyState >= 1) {
      restartThemeCut();
      return;
    }

    video.addEventListener('loadedmetadata', restartThemeCut, { once: true });
    return () => video.removeEventListener('loadedmetadata', restartThemeCut);
  }, [themeSlug, activeThemePreviewClip.src, activeThemePreviewClip.startSec, prefersReducedMotion]);

  function handleThemeCutVideoTimeUpdate(): void {
    const video = themeCutVideoRef.current;
    if (!video) {
      return;
    }

    const previewEndTime = activeThemePreviewClip.startSec + activeThemePreviewClip.durationSec;
    if (video.currentTime >= previewEndTime) {
      video.currentTime = activeThemePreviewClip.startSec;
      if (!prefersReducedMotion) {
        void video.play().catch(() => undefined);
      }
    }
  }

  function replayThemeCut(): void {
    setThemeCutFrame(0);

    const video = themeCutVideoRef.current;
    if (!video) {
      return;
    }

    video.currentTime = activeThemePreviewClip.startSec;
    void video.play().catch(() => undefined);
  }

  function setActionBusy(action: keyof ActionLoadingState, busy: boolean): void {
    setActionLoading((current) => ({
      ...current,
      [action]: busy
    }));
  }

  function setStepMessage(step: StepKey, message: string): void {
    setStepMessages((current) => ({
      ...current,
      [step]: message
    }));
  }

  function resetUploadProgress(): void {
    setUploadProgress({
      totalFiles: 0,
      uploadedFiles: 0,
      activeFileName: null,
      failedFileName: null
    });
  }

  function updatePhotoUploadState(args: {
    uploadId: string;
    status: UploadStatus;
    errorMessage?: string | null;
  }): void {
    setPhotoUploads((current) =>
      current.map((item) =>
        item.id === args.uploadId
          ? {
              ...item,
              status: args.status,
              errorMessage: args.errorMessage ?? null
            }
          : item
      )
    );
  }

  function updateVoiceUploadState(args: { status: UploadStatus; errorMessage?: string | null }): void {
    setVoiceUpload((current) =>
      current
        ? {
            ...current,
            status: args.status,
            errorMessage: args.errorMessage ?? null
          }
        : current
    );
  }

  function appendPhotoFiles(nextFiles: File[]): void {
    if (nextFiles.length === 0) {
      return;
    }

    resetUploadProgress();

    let nextCount = 0;
    let addedCount = 0;
    let duplicateCount = 0;
    let typeRejectedCount = 0;
    let overLimitCount = 0;

    setPhotoUploads((current) => {
      const next = [...current];
      const seen = new Set(next.map((item) => photoFingerprint(item.file)));
      for (const file of nextFiles) {
        if (!allowedPhotoTypes.has(file.type || '')) {
          typeRejectedCount += 1;
          continue;
        }

        if (next.length >= 15) {
          overLimitCount += 1;
          continue;
        }

        const fingerprint = photoFingerprint(file);
        if (seen.has(fingerprint)) {
          duplicateCount += 1;
          continue;
        }

        seen.add(fingerprint);
        addedCount += 1;
        next.push({
          id: createLocalFileId(),
          file,
          previewUrl: URL.createObjectURL(file),
          status: 'selected',
          errorMessage: null
        });
      }

      nextCount = next.length;
      return next;
    });

    const notes: string[] = [];
    if (addedCount > 0) {
      notes.push(`Added ${String(addedCount)} photo${addedCount === 1 ? '' : 's'}.`);
    }
    if (duplicateCount > 0) {
      notes.push(`Skipped ${String(duplicateCount)} duplicate${duplicateCount === 1 ? '' : 's'}.`);
    }
    if (typeRejectedCount > 0) {
      notes.push(`Skipped ${String(typeRejectedCount)} unsupported file${typeRejectedCount === 1 ? '' : 's'}.`);
    }
    if (overLimitCount > 0) {
      notes.push(`Skipped ${String(overLimitCount)} file${overLimitCount === 1 ? '' : 's'} above 15-photo limit.`);
    }

    if (nextCount === 0) {
      setStepMessage('upload', 'Select 5-15 JPG/PNG photos and one voice sample (WAV/M4A).');
      return;
    }

    const summary = `Selected ${String(nextCount)} photo${nextCount === 1 ? '' : 's'}.`;
    setStepMessage('upload', notes.length > 0 ? `${summary} ${notes.join(' ')}` : summary);
  }

  function setVoiceFile(nextVoiceFile: File | null): void {
    resetUploadProgress();

    if (!nextVoiceFile) {
      setVoiceUpload(null);
      setStepMessage('upload', 'Select one voice sample (WAV or M4A) to continue.');
      return;
    }

    if (nextVoiceFile.type && !allowedVoiceTypes.has(nextVoiceFile.type)) {
      setStepMessage('upload', `Unsupported voice format (${nextVoiceFile.type}). Use WAV or M4A.`);
      return;
    }

    setVoiceUpload({
      id: createLocalFileId(),
      file: nextVoiceFile,
      status: 'selected',
      errorMessage: null
    });
    setStepMessage('upload', `Voice sample selected: ${nextVoiceFile.name}.`);
  }

  function removePhotoFile(uploadId: string): void {
    resetUploadProgress();
    setPhotoUploads((current) => {
      const target = current.find((item) => item.id === uploadId);
      if (target?.previewUrl) {
        revokePreviewUrl(target.previewUrl);
      }

      return current.filter((item) => item.id !== uploadId);
    });
    setStepMessage('upload', 'Photo removed. Keep between 5 and 15 photos selected.');
  }

  function retryPhotoFile(uploadId: string): void {
    updatePhotoUploadState({
      uploadId,
      status: 'selected',
      errorMessage: null
    });
    setStepMessage('upload', 'Marked failed photo for retry.');
  }

  function removeVoiceFile(): void {
    resetUploadProgress();
    setVoiceUpload(null);
    setStepMessage('upload', 'Voice sample removed.');
  }

  function retryVoiceFile(): void {
    updateVoiceUploadState({
      status: 'selected',
      errorMessage: null
    });
    setStepMessage('upload', 'Marked voice sample for retry.');
  }

  function onPhotoDrop(files: File[]): void {
    appendPhotoFiles(files);
    setIsPhotoDropActive(false);
  }

  function onVoiceDrop(files: File[]): void {
    if (files.length === 0) {
      return;
    }

    if (files.length > 1) {
      setStepMessage('upload', 'Multiple voice files detected. Using the first one.');
    }
    setVoiceFile(files[0] ?? null);
    setIsVoiceDropActive(false);
  }

  async function loadThemes(): Promise<void> {
    setActionBusy('loadThemes', true);
    setStepMessage('order', 'Loading available themes...');
    try {
      const data = await apiFetch<Theme[]>('/themes');
      setThemes(data);
      if (!themeSlug && data[0]) {
        setThemeSlug(data[0].slug);
      }
      const message = `Loaded ${data.length} active theme${data.length === 1 ? '' : 's'}.`;
      setStepMessage('order', message);
      setStatusMessage(message);
    } catch (error) {
      const message = (error as Error).message;
      setStepMessage('order', message);
      setStatusMessage(message);
    } finally {
      setActionBusy('loadThemes', false);
    }
  }

  async function upsertUser(): Promise<void> {
    setActionBusy('upsertUser', true);
    setStepMessage('identity', 'Saving parent identity...');
    try {
      const user = await apiFetch<{ id: string; parentAccessToken: string }>('/users/upsert', {
        method: 'POST',
        body: JSON.stringify({ email })
      });

      setUserId(user.id);
      persistParentSessionToken(user.parentAccessToken);
      if (returnTo) {
        const message = `Parent session restored. Returning to ${recoveringOrderId ?? 'your order'}...`;
        setStepMessage('identity', message);
        setStatusMessage(message);
        router.push(returnTo as Route);
        return;
      }

      const message = `Parent identity ready.`;
      setStepMessage('identity', message);
      setStatusMessage(message);
    } catch (error) {
      const message = (error as Error).message;
      setStepMessage('identity', message);
      setStatusMessage(message);
    } finally {
      setActionBusy('upsertUser', false);
    }
  }

  async function createOrder(): Promise<void> {
    if (!consentChecked) {
      const message = 'Confirm parent consent before creating the order.';
      setStepMessage('order', message);
      setStatusMessage(message);
      return;
    }

    setActionBusy('createOrder', true);
    setStepMessage('order', 'Creating order and capturing consent...');
    try {
      const order = await apiFetch<{ id: string }>('/orders', {
        method: 'POST',
        body: JSON.stringify({
          userId,
          themeSlug,
          currency: 'usd'
        })
      });

      setOrderId(order.id);
      setPaymentIdempotencyKey(createIdempotencyKey(`pay:${order.id}`));
      setPaymentQueued(false);
      resetUploadProgress();
      setPhotoUploads((current) =>
        current.map((item) => ({
          ...item,
          status: 'selected',
          errorMessage: null
        }))
      );
      setVoiceUpload((current) =>
        current
          ? {
              ...current,
              status: 'selected',
              errorMessage: null
            }
          : current
      );

      await apiFetch(`/orders/${order.id}/consent`, {
        method: 'POST',
        body: JSON.stringify({
          userId,
          version: 'mvp-v1',
          userAgent: window.navigator.userAgent
        })
      });

      const message = `Order created and consent captured.`;
      setStepMessage('order', message);
      setStatusMessage(message);
      setScript(null);
      setIsScriptApproved(false);
      setConsentChecked(false);
    } catch (error) {
      const message = (error as Error).message;
      setStepMessage('order', message);
      setStatusMessage(message);
    } finally {
      setActionBusy('createOrder', false);
    }
  }

  async function signUploads(): Promise<void> {
    if (!orderId) return;

    setActionBusy('signUploads', true);
    try {
      const photoCount = photoUploads.length;
      if (photoCount < 5 || photoCount > 15) {
        throw new Error('Please select 5-15 photos before signing uploads.');
      }

      if (!voiceUpload) {
        throw new Error('Please select one voice sample (30-60 seconds) before signing uploads.');
      }

      for (const { file } of photoUploads) {
        if (!allowedPhotoTypes.has(file.type || '')) {
          throw new Error(`Unsupported photo format for ${file.name}. Use JPG or PNG.`);
        }
      }

      if (voiceUpload.file.type && !allowedVoiceTypes.has(voiceUpload.file.type)) {
        throw new Error(`Unsupported voice format (${voiceUpload.file.type}). Use WAV or M4A.`);
      }

      const pendingPhotos = photoUploads.filter((item) => item.status === 'selected' || item.status === 'failed');
      const pendingVoice = voiceUpload.status === 'selected' || voiceUpload.status === 'failed' ? voiceUpload : null;
      const totalFiles = photoUploads.length + 1;
      const alreadyUploadedCount =
        photoUploads.filter((item) => item.status === 'uploaded').length + (voiceUpload.status === 'uploaded' ? 1 : 0);
      const pendingCount = pendingPhotos.length + (pendingVoice ? 1 : 0);

      if (pendingCount === 0) {
        setStepMessage('upload', 'All selected files are already uploaded.');
        setStatusMessage('All selected files are already uploaded.');
        return;
      }

      setUploadProgress({
        totalFiles,
        uploadedFiles: alreadyUploadedCount,
        activeFileName: pendingPhotos[0]?.file.name ?? pendingVoice?.file.name ?? null,
        failedFileName: null
      });
      setStepMessage(
        'upload',
        `Uploading ${String(pendingCount)} pending file${pendingCount === 1 ? '' : 's'} (${String(totalFiles)} selected total)...`
      );

      const uploadResult: UploadAttemptResult = {
        uploaded: alreadyUploadedCount,
        failed: 0
      };

      for (const photoItem of pendingPhotos) {
        updatePhotoUploadState({
          uploadId: photoItem.id,
          status: 'uploading',
          errorMessage: null
        });

        const file = photoItem.file;
        setUploadProgress((current) => ({
          ...current,
          activeFileName: file.name
        }));

        try {
          const contentType = file.type || 'image/jpeg';
          const sha256 = await fileSha256(file);
          const signed = await apiFetch<UploadSignResponse>(`/orders/${orderId}/uploads/sign`, {
            method: 'POST',
            body: JSON.stringify({
              kind: 'photo',
              contentType,
              bytes: file.size,
              sha256
            })
          });

          await uploadFileToSignedUrl({
            signedUploadUrl: signed.signedUploadUrl,
            contentType,
            file
          });

          uploadResult.uploaded += 1;
          updatePhotoUploadState({
            uploadId: photoItem.id,
            status: 'uploaded',
            errorMessage: null
          });
          setUploadProgress((current) => ({
            ...current,
            uploadedFiles: uploadResult.uploaded
          }));
        } catch (error) {
          uploadResult.failed += 1;
          const message = (error as Error).message;
          updatePhotoUploadState({
            uploadId: photoItem.id,
            status: 'failed',
            errorMessage: message
          });
          setUploadProgress((current) => ({
            ...current,
            failedFileName: file.name
          }));
        }
      }

      if (pendingVoice) {
        updateVoiceUploadState({
          status: 'uploading',
          errorMessage: null
        });

        setUploadProgress((current) => ({
          ...current,
          activeFileName: pendingVoice.file.name
        }));

        try {
          const voiceContentType = pendingVoice.file.type || 'audio/wav';
          const voiceSha256 = await fileSha256(pendingVoice.file);
          const signedVoice = await apiFetch<UploadSignResponse>(`/orders/${orderId}/uploads/sign`, {
            method: 'POST',
            body: JSON.stringify({
              kind: 'voice',
              contentType: voiceContentType,
              bytes: pendingVoice.file.size,
              sha256: voiceSha256
            })
          });

          await uploadFileToSignedUrl({
            signedUploadUrl: signedVoice.signedUploadUrl,
            contentType: voiceContentType,
            file: pendingVoice.file
          });

          uploadResult.uploaded += 1;
          updateVoiceUploadState({
            status: 'uploaded',
            errorMessage: null
          });
          setUploadProgress((current) => ({
            ...current,
            uploadedFiles: uploadResult.uploaded
          }));
        } catch (error) {
          uploadResult.failed += 1;
          const message = (error as Error).message;
          updateVoiceUploadState({
            status: 'failed',
            errorMessage: message
          });
          setUploadProgress((current) => ({
            ...current,
            failedFileName: pendingVoice.file.name
          }));
        }
      }

      setUploadProgress((current) => ({
        ...current,
        activeFileName: null
      }));

      const message =
        uploadResult.failed > 0
          ? `Uploaded ${String(uploadResult.uploaded)} of ${String(totalFiles)} selected files. ${String(
              uploadResult.failed
            )} failed. Use Retry on failed items.`
          : `Uploaded ${String(uploadResult.uploaded)} file${uploadResult.uploaded === 1 ? '' : 's'} to signed asset URLs.`;
      setStepMessage('upload', message);
      setStatusMessage(message);
    } catch (error) {
      const message = (error as Error).message;
      setUploadProgress((current) => ({
        ...current,
        activeFileName: null,
        failedFileName: current.activeFileName
      }));
      setStepMessage('upload', message);
      setStatusMessage(message);
    } finally {
      setActionBusy('signUploads', false);
    }
  }

  async function generateAndPreviewScript(): Promise<void> {
    if (!orderId) return;

    setActionBusy('generateScript', true);
    setStepMessage('scriptPayment', 'Generating script and preview...');
    try {
      const generated = await apiFetch<GeneratedScript>(`/orders/${orderId}/script/generate`, {
        method: 'POST',
        body: JSON.stringify({
          childName,
          keywords: ['cinematic', 'keepsake']
        })
      });

      setScript(generated);
      setIsScriptApproved(false);
      const message = `Generated script v${generated.version}. Review and approve to continue.`;
      setStepMessage('scriptPayment', message);
      setStatusMessage(message);
    } catch (error) {
      const message = (error as Error).message;
      setStepMessage('scriptPayment', message);
      setStatusMessage(message);
    } finally {
      setActionBusy('generateScript', false);
    }
  }

  async function approveScript(): Promise<void> {
    if (!script || !orderId) return;

    setActionBusy('approveScript', true);
    setStepMessage('scriptPayment', `Approving script version ${script.version}...`);
    try {
      await apiFetch(`/orders/${orderId}/script/approve`, {
        method: 'POST',
        body: JSON.stringify({ version: script.version })
      });

      const message = `Approved script version ${script.version}. Proceed to payment.`;
      setStepMessage('scriptPayment', message);
      setStatusMessage(message);
      setIsScriptApproved(true);
    } catch (error) {
      const message = (error as Error).message;
      setStepMessage('scriptPayment', message);
      setStatusMessage(message);
    } finally {
      setActionBusy('approveScript', false);
    }
  }

  async function payAndRender(): Promise<void> {
    if (!orderId) return;

    setActionBusy('pay', true);
    setStepMessage('scriptPayment', `Starting payment for ${launchPriceLabel}...`);
    try {
      const idempotencyKey = paymentIdempotencyKey || createIdempotencyKey(`pay:${orderId}`);
      if (!paymentIdempotencyKey) {
        setPaymentIdempotencyKey(idempotencyKey);
      }

      const payResponse = await apiFetch<PayResponse>(`/orders/${orderId}/pay`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify({})
      });

      if (payResponse.provider === 'stripe' && payResponse.checkoutUrl) {
        setStepMessage('scriptPayment', 'Redirecting to secure checkout...');
        setStatusMessage('Redirecting to secure checkout...');
        window.location.href = payResponse.checkoutUrl;
        return;
      }

      setPaymentQueued(true);
      const message = 'Payment captured (stub). Async render started.';
      setStepMessage('scriptPayment', message);
      setStatusMessage(message);
    } catch (error) {
      const message = (error as Error).message;
      setStepMessage('scriptPayment', message);
      setStatusMessage(message);
    } finally {
      setActionBusy('pay', false);
    }
  }

  return (
    <main>
      <section className="card flow-stepper-card">
        <h1>Create Keepsake Order</h1>
        <p>
          Guided intake with clear progression: parent identity, theme + order setup, media upload, script approval, then{' '}
          {launchPriceLabel} checkout and async delivery.
        </p>
        {childDirectorFlags.childDirectorExperienceEnabled ? (
          <p>
            Explorer mode prototype is enabled.{' '}
            <Link href={'/create/child-director' as Route}>Open child story builder</Link>. Release 2 pilot controls are{' '}
            <strong>{childDirectorFlags.childDirectorRelease2Enabled ? 'on' : 'off'}</strong>.
          </p>
        ) : null}
        <ol className="flow-stepper" aria-label="Order intake progress">
          <li className={`flow-stepper-item is-${stepStates.identity}`}>
            <span className="flow-stepper-index">1</span>
            <span className="flow-stepper-label">Parent</span>
          </li>
          <li className={`flow-stepper-item is-${stepStates.order}`}>
            <span className="flow-stepper-index">2</span>
            <span className="flow-stepper-label">Order</span>
          </li>
          <li className={`flow-stepper-item is-${stepStates.upload}`}>
            <span className="flow-stepper-index">3</span>
            <span className="flow-stepper-label">Upload</span>
          </li>
          <li className={`flow-stepper-item is-${stepStates.scriptPayment}`}>
            <span className="flow-stepper-index">4</span>
            <span className="flow-stepper-label">Approve + Pay</span>
          </li>
        </ol>
      </section>

      {returnTo ? (
        <section className="card flow-recovery-card">
          <h2>Recover Parent Session</h2>
          <p>
            Your parent session is missing or expired. Re-enter the parent email for{' '}
            {recoveringOrderId ? <span className="mono">{recoveringOrderId}</span> : 'this order'} to restore access and return.
          </p>
          <p>
            If you reached this order from a gift email instead, reopen that gift redemption link to establish the correct session.
          </p>
          <p>
            Return target: <span className="mono">{returnTo}</span>
          </p>
        </section>
      ) : null}

      <section className="grid two">
        <article className={`card flow-step-card is-${stepStates.identity}`}>
          <header className="flow-step-header">
            <h2>1. Parent Identity</h2>
            <span className={`flow-step-chip is-${stepStates.identity}`}>
              {stepStates.identity === 'complete' ? 'Complete' : stepStates.identity === 'active' ? 'In Progress' : 'Locked'}
            </span>
          </header>
          <label htmlFor="email">Parent Email</label>
          <input
            id="email"
            type="email"
            placeholder="parent@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <button disabled={!canCreateUser || actionLoading.upsertUser || isAnyActionLoading} onClick={upsertUser}>
            {actionLoading.upsertUser ? 'Saving Parent Identity...' : returnTo ? 'Restore Parent Session' : 'Create/Load Parent'}
          </button>
          {userId ? <p className="mono">user_id: {userId}</p> : null}
          <p className="flow-step-status" aria-live="polite">
            {stepMessages.identity}
          </p>
        </article>

        <article className={`card flow-step-card is-${stepStates.order}`}>
          <header className="flow-step-header">
            <h2>2. Theme + Child</h2>
            <span className={`flow-step-chip is-${stepStates.order}`}>
              {stepStates.order === 'complete' ? 'Complete' : stepStates.order === 'active' ? 'In Progress' : 'Locked'}
            </span>
          </header>
          <button disabled={actionLoading.loadThemes || isAnyActionLoading} onClick={loadThemes}>
            {actionLoading.loadThemes ? 'Loading Themes...' : 'Load Themes'}
          </button>
          <label htmlFor="theme">Theme</label>
          <select id="theme" value={themeSlug} onChange={(event) => setThemeSlug(event.target.value)}>
            <option value="">Select theme</option>
            {themes.map((theme) => (
              <option key={theme.id} value={theme.slug}>
                {theme.name}
              </option>
            ))}
          </select>
          {themeSlug ? (
            <section className="theme-cut-preview" style={themeCutStyle} aria-live="polite">
              <div className="theme-cut-stage">
                <span className="theme-cut-kicker">{activeThemeCut.kicker}</span>
                <h3>{selectedTheme?.name ?? 'Selected Theme'}</h3>
                <div className="theme-cut-video-shell">
                  <video
                    ref={themeCutVideoRef}
                    key={`${activeThemeCut.id}-${activeThemePreviewClip.src}`}
                    className="theme-cut-video"
                    muted
                    playsInline
                    preload="metadata"
                    onTimeUpdate={handleThemeCutVideoTimeUpdate}
                    onError={() => setThemePreviewUnavailable(true)}
                  >
                    <source src={activeThemePreviewClip.src} type="video/mp4" />
                  </video>
                  <div className="theme-cut-video-vignette" aria-hidden="true" />
                  {themePreviewUnavailable ? (
                    <span className="theme-cut-video-fallback">Video preview unavailable right now.</span>
                  ) : null}
                </div>
                <p className="theme-cut-vibe">{activeThemeCut.vibe}</p>
                <div className="theme-cut-frame">
                  <span className="theme-cut-counter">
                    cut {String(themeCutFrame + 1).padStart(2, '0')} / {String(activeThemeCut.cuts.length).padStart(2, '0')}
                  </span>
                  <p key={`${activeThemeCut.id}-${themeCutFrame}`} className="theme-cut-line">
                    {activeThemeCutLine}
                  </p>
                </div>
                <div className="theme-cut-track" aria-hidden="true">
                  {activeThemeCut.cuts.map((cut, index) => (
                    <span
                      key={`${activeThemeCut.id}-${cut}`}
                      className={
                        index === themeCutFrame ? 'is-current' : index < themeCutFrame ? 'is-seen' : ''
                      }
                    />
                  ))}
                </div>
                <button
                  type="button"
                  className="theme-cut-replay"
                  onClick={replayThemeCut}
                  disabled={activeThemeCut.cuts.length < 2}
                >
                  Replay 3s Cut
                </button>
                {prefersReducedMotion ? (
                  <p className="theme-cut-motion-note">
                    Autoplay is off because reduced-motion is enabled. Use replay to preview the cut.
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}

          <label htmlFor="childName">Child Name</label>
          <input
            id="childName"
            placeholder="Avery"
            value={childName}
            onChange={(event) => setChildName(event.target.value)}
          />

          <label className="consent-checkbox">
            <input
              type="checkbox"
              checked={consentChecked}
              onChange={(event) => setConsentChecked(event.target.checked)}
            />
            <span>I confirm I am the parent or legal guardian and consent to processing this media for the keepsake order.</span>
          </label>

          <button disabled={!canCreateOrder || actionLoading.createOrder || isAnyActionLoading} onClick={createOrder}>
            {actionLoading.createOrder ? 'Creating Order...' : 'Create Order + Capture Consent'}
          </button>
          {orderId ? <p className="mono">order_id: {orderId}</p> : null}
          <p className="flow-step-status" aria-live="polite">
            {stepMessages.order}
          </p>
        </article>
      </section>

      <section className="grid two">
        <article className={`card flow-step-card is-${stepStates.upload}`}>
          <header className="flow-step-header">
            <h2>3. Upload Intake</h2>
            <span className={`flow-step-chip is-${stepStates.upload}`}>
              {stepStates.upload === 'complete' ? 'Complete' : stepStates.upload === 'active' ? 'In Progress' : 'Locked'}
            </span>
          </header>
          <p>Photos: 5-15 JPG/PNG. Voice: one 30-60 second WAV/M4A sample.</p>

          <label htmlFor="photos">Child Photos</label>
          <div
            className={`upload-dropzone ${isPhotoDropActive ? 'is-active' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsPhotoDropActive(true);
            }}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsPhotoDropActive(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setIsPhotoDropActive(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              onPhotoDrop(Array.from(event.dataTransfer.files ?? []));
            }}
          >
            <p>Drag and drop photo files here.</p>
            <p>or choose files with the picker below.</p>
          </div>
          <input
            id="photos"
            type="file"
            accept="image/png,image/jpeg"
            multiple
            onChange={(event) => {
              appendPhotoFiles(Array.from(event.target.files ?? []));
              event.currentTarget.value = '';
            }}
          />
          <div className="upload-summary">
            <p>
              Selected photos: <strong>{photoCount}</strong>
              {photoCount > 0 ? ` (${formatBytes(photoBytes)})` : ''}
            </p>
            {photoCount > 0 ? (
              <p>
                Uploaded: <strong>{uploadedPhotoCount}</strong> | Failed: <strong>{failedPhotoCount}</strong>
              </p>
            ) : null}
            {photoUploads.length > 0 ? (
              <ul className="upload-file-list">
                {photoUploads.map((item, index) => (
                  <li key={item.id} className={`upload-file-row is-${item.status}`}>
                    <div className="upload-file-copy">
                      <div className="upload-file-identity">
                        <img
                          className="upload-photo-thumb"
                          src={item.previewUrl}
                          alt={`Selected photo ${String(index + 1)}: ${item.file.name}`}
                        />
                        <span>{item.file.name}</span>
                      </div>
                      <span>{formatBytes(item.file.size)}</span>
                    </div>
                    <div className="upload-file-controls">
                      <span className={`upload-file-state is-${item.status}`}>{item.status}</span>
                      {item.status === 'failed' ? (
                        <button
                          type="button"
                          className="upload-inline-button"
                          disabled={actionLoading.signUploads}
                          onClick={() => retryPhotoFile(item.id)}
                        >
                          Retry
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="upload-inline-button"
                        disabled={actionLoading.signUploads || item.status === 'uploading'}
                        onClick={() => removePhotoFile(item.id)}
                      >
                        Remove
                      </button>
                    </div>
                    {item.errorMessage ? <p className="upload-file-error">{item.errorMessage}</p> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <label htmlFor="voice">Voice Sample</label>
          <div
            className={`upload-dropzone ${isVoiceDropActive ? 'is-active' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsVoiceDropActive(true);
            }}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsVoiceDropActive(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setIsVoiceDropActive(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              onVoiceDrop(Array.from(event.dataTransfer.files ?? []));
            }}
          >
            <p>Drag and drop one voice sample here.</p>
            <p>WAV or M4A, 30-60 seconds recommended.</p>
          </div>
          <input
            id="voice"
            type="file"
            accept="audio/wav,audio/m4a"
            onChange={(event) => {
              setVoiceFile(event.target.files?.[0] ?? null);
              event.currentTarget.value = '';
            }}
          />
          {voiceUpload ? (
            <div className="upload-voice-file">
              <p>
                Voice file: <strong>{voiceUpload.file.name}</strong> ({formatBytes(voiceUpload.file.size)})
              </p>
              <div className="upload-file-controls">
                <span className={`upload-file-state is-${voiceUpload.status}`}>{voiceUpload.status}</span>
                {voiceUpload.status === 'failed' ? (
                  <button
                    type="button"
                    className="upload-inline-button"
                    disabled={actionLoading.signUploads}
                    onClick={retryVoiceFile}
                  >
                    Retry
                  </button>
                ) : null}
                <button
                  type="button"
                  className="upload-inline-button"
                  disabled={actionLoading.signUploads || voiceUpload.status === 'uploading'}
                  onClick={removeVoiceFile}
                >
                  Remove
                </button>
              </div>
              {voiceUpload.errorMessage ? <p className="upload-file-error">{voiceUpload.errorMessage}</p> : null}
            </div>
          ) : null}

          <button disabled={!orderId || actionLoading.signUploads || isAnyActionLoading} onClick={signUploads}>
            {actionLoading.signUploads ? 'Uploading Files...' : 'Sign Upload Intents + Upload Files'}
          </button>
          {uploadProgress.totalFiles > 0 ? (
            <div className="upload-progress-block" aria-live="polite">
              <div className="upload-progress-meta">
                <span>
                  Uploaded {uploadProgress.uploadedFiles} / {uploadProgress.totalFiles}
                </span>
                <span>{uploadProgressPct}%</span>
              </div>
              <div className="upload-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadProgressPct}>
                <span style={{ width: `${uploadProgressPct}%` }} />
              </div>
              {uploadProgress.activeFileName ? <p>Now uploading: {uploadProgress.activeFileName}</p> : null}
              {uploadProgress.failedFileName ? <p>Upload failed on: {uploadProgress.failedFileName}</p> : null}
            </div>
          ) : null}
          <p className="flow-step-status" aria-live="polite">
            {stepMessages.upload}
          </p>
        </article>

        <article className={`card flow-step-card is-${stepStates.scriptPayment}`}>
          <header className="flow-step-header">
            <h2>4. Script, Approve, Pay</h2>
            <span className={`flow-step-chip is-${stepStates.scriptPayment}`}>
              {stepStates.scriptPayment === 'complete'
                ? 'Complete'
                : stepStates.scriptPayment === 'active'
                  ? 'In Progress'
                  : 'Locked'}
            </span>
          </header>
          <button disabled={!canGenerateScript || actionLoading.generateScript || isAnyActionLoading} onClick={generateAndPreviewScript}>
            {actionLoading.generateScript ? 'Generating Script...' : 'Generate / Regenerate Script'}
          </button>
          <button disabled={!script || actionLoading.approveScript || isAnyActionLoading} onClick={approveScript}>
            {actionLoading.approveScript ? 'Approving Script...' : 'Approve Script'}
          </button>
          <button disabled={!canPay || actionLoading.pay || isAnyActionLoading} onClick={payAndRender}>
            {actionLoading.pay ? `Processing ${launchPriceLabel} Payment...` : `Pay ${launchPriceLabel} + Start Render`}
          </button>
          {orderId ? <Link href={`/orders/${orderId}`}>Open live order status</Link> : null}
          <p className="flow-step-status" aria-live="polite">
            {stepMessages.scriptPayment}
          </p>
        </article>
      </section>

      {script ? (
        <section className="card flow-script-preview-card">
          <h3>{script.script_json.title}</h3>
          {script.previewArtifact?.meta?.signedDownloadUrl ? (
            <p>
              <a href={script.previewArtifact.meta.signedDownloadUrl} target="_blank" rel="noreferrer">
                Open Watermarked Preview (720p)
              </a>
            </p>
          ) : null}
          <p>Narration:</p>
          <ul>
            {script.script_json.narration.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p>Shot Plan:</p>
          <ul>
            {script.script_json.shots.map((shot) => (
              <li key={shot.shotNumber}>
                Shot {shot.shotNumber} ({shot.durationSec}s): {shot.action} / {shot.dialogue}
              </li>
            ))}
          </ul>
          <p className="mono">Script approved: {isScriptApproved ? 'yes' : 'no'}</p>
        </section>
      ) : null}

      <section className="card flow-status-card" aria-live="polite">
        <span className="status-chip">Status</span>
        <p>{statusMessage || 'No actions yet.'}</p>
      </section>
    </main>
  );
}

export default function CreateOrderPage(): JSX.Element {
  return (
    <Suspense
      fallback={
        <main>
          <section className="card">
            <h1>Create Keepsake Order</h1>
            <p>Loading order flow...</p>
          </section>
        </main>
      }
    >
      <CreateOrderPageContent />
    </Suspense>
  );
}

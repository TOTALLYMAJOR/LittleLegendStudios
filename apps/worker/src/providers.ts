import { createHash, randomUUID } from 'node:crypto';

import type { ScriptPayload } from '@little/shared';
import { z } from 'zod';

import { env } from './env.js';

export interface WorkerUpload {
  kind: 'photo' | 'voice';
  s3Key: string;
  contentType: string;
  bytes: number;
  sha256: string | null;
}

export interface CharacterProfile {
  characterId: string;
  faceEmbeddingRef: string;
  hair: string;
  eyes: string;
  ageEstimate: number;
  sourcePhotoCount: number;
  voiceCloneId: string;
  modelStyle: string;
}

export interface VoiceCloneResult {
  provider: string;
  voiceCloneId: string;
  voiceCloneArtifactKey: string;
  voiceCloneMeta: Record<string, unknown>;
}

export interface VoiceRenderResult {
  provider: string;
  narrationArtifactKey: string;
  narrationMeta: Record<string, unknown>;
  dialogueArtifactKey: string;
  dialogueMeta: Record<string, unknown>;
}

export interface CharacterPackResult {
  provider: string;
  characterProfile: CharacterProfile;
  refsArtifactKey: string;
  refsMeta: Record<string, unknown>;
}

export interface ShotRenderResult {
  provider: string;
  shotArtifactKey: string;
  shotMeta: Record<string, unknown>;
}

export interface FinalComposeResult {
  provider: string;
  finalVideoArtifactKey: string;
  finalVideoMeta: Record<string, unknown>;
  thumbnailArtifactKey: string;
  thumbnailMeta: Record<string, unknown>;
}

export interface ProviderTaskStatusResult {
  providerTaskId: string;
  provider: string;
  status: 'queued' | 'processing' | 'succeeded' | 'failed';
  artifactKey: string | null;
  output: Record<string, unknown>;
  errorText: string | null;
  lastPolledAt: string | null;
}

export interface VoiceProvider {
  createVoiceClone(args: {
    orderId: string;
    userId: string;
    voiceUpload: WorkerUpload | null;
  }): Promise<VoiceCloneResult>;
  renderVoiceTracks(args: {
    orderId: string;
    userId: string;
    voiceCloneId: string;
    scriptTitle: string;
    narrationLines: string[];
    dialogueLines: string[];
  }): Promise<VoiceRenderResult>;
}

export interface SceneProvider {
  createCharacterPack(args: {
    orderId: string;
    userId: string;
    photoUploads: WorkerUpload[];
    voiceCloneId: string;
  }): Promise<CharacterPackResult>;
  renderShot(args: {
    orderId: string;
    userId: string;
    shot: ScriptPayload['shots'][number];
    characterProfile: CharacterProfile;
  }): Promise<ShotRenderResult>;
  composeFinal(args: {
    orderId: string;
    userId: string;
    shotArtifactKeys: string[];
    totalDurationSec: number;
    characterProfile: CharacterProfile;
  }): Promise<FinalComposeResult>;
  getProviderTaskStatus(args: {
    providerTaskId: string;
  }): Promise<ProviderTaskStatusResult>;
}

export interface ProviderRegistry {
  voice: VoiceProvider;
  scene: SceneProvider;
}

function hashHex(seed: string, length = 10): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, length);
}

function pickDeterministic<T>(seed: string, options: T[]): T {
  const numeric = Number.parseInt(hashHex(seed, 8), 16);
  return options[numeric % options.length];
}

function deterministicCharacterProfile(args: {
  orderId: string;
  photoUploads: WorkerUpload[];
  voiceCloneId: string;
}): CharacterProfile {
  const sourceMaterial = args.photoUploads.map((upload) => upload.sha256 ?? upload.s3Key).join('|') || args.orderId;
  const characterSeed = `${args.orderId}:${sourceMaterial}`;

  return {
    characterId: `child_${hashHex(`${characterSeed}:id`, 10)}`,
    faceEmbeddingRef: `emb_${hashHex(`${characterSeed}:embedding`, 12)}`,
    hair: pickDeterministic(`${characterSeed}:hair`, ['brown', 'black', 'blonde', 'red', 'dark-brown']),
    eyes: pickDeterministic(`${characterSeed}:eyes`, ['hazel', 'brown', 'blue', 'green']),
    ageEstimate: 4 + (Number.parseInt(hashHex(`${characterSeed}:age`, 4), 16) % 8),
    sourcePhotoCount: args.photoUploads.length,
    voiceCloneId: args.voiceCloneId,
    modelStyle: 'house_style_v1'
  };
}

class StubVoiceProvider implements VoiceProvider {
  async createVoiceClone(args: {
    orderId: string;
    userId: string;
    voiceUpload: WorkerUpload | null;
  }): Promise<VoiceCloneResult> {
    const voiceCloneId = `voice_${hashHex(`${args.orderId}:${args.voiceUpload?.sha256 ?? args.voiceUpload?.s3Key ?? 'none'}`, 10)}`;
    const voiceCloneArtifactKey = `${args.userId}/${args.orderId}/voice/clone-${voiceCloneId}.json`;

    return {
      provider: 'stub_voice',
      voiceCloneId,
      voiceCloneArtifactKey,
      voiceCloneMeta: {
        voiceCloneId,
        sourceVoiceKey: args.voiceUpload?.s3Key ?? null,
        sourceContentType: args.voiceUpload?.contentType ?? null
      }
    };
  }

  async renderVoiceTracks(args: {
    orderId: string;
    userId: string;
    voiceCloneId: string;
    scriptTitle: string;
    narrationLines: string[];
    dialogueLines: string[];
  }): Promise<VoiceRenderResult> {
    const narrationArtifactKey = `${args.userId}/${args.orderId}/audio/narration-${hashHex(`${args.orderId}:narration`, 8)}.mp3`;
    const dialogueArtifactKey = `${args.userId}/${args.orderId}/audio/dialogue-${hashHex(`${args.orderId}:dialogue`, 8)}.mp3`;

    return {
      provider: 'stub_voice',
      narrationArtifactKey,
      narrationMeta: {
        scriptTitle: args.scriptTitle,
        narrationLines: args.narrationLines
      },
      dialogueArtifactKey,
      dialogueMeta: {
        dialogueLines: args.dialogueLines,
        voiceCloneId: args.voiceCloneId
      }
    };
  }
}

class StubSceneProvider implements SceneProvider {
  async createCharacterPack(args: {
    orderId: string;
    userId: string;
    photoUploads: WorkerUpload[];
    voiceCloneId: string;
  }): Promise<CharacterPackResult> {
    const characterProfile = deterministicCharacterProfile({
      orderId: args.orderId,
      photoUploads: args.photoUploads,
      voiceCloneId: args.voiceCloneId
    });
    const refsArtifactKey = `${args.userId}/${args.orderId}/character/refs-${characterProfile.characterId}.json`;

    return {
      provider: 'stub_scene',
      characterProfile,
      refsArtifactKey,
      refsMeta: {
        ...characterProfile,
        referenceFrames: ['neutral', 'happy', 'surprised', 'profile']
      }
    };
  }

  async renderShot(args: {
    orderId: string;
    userId: string;
    shot: ScriptPayload['shots'][number];
    characterProfile: CharacterProfile;
  }): Promise<ShotRenderResult> {
    const shotArtifactKey = `${args.userId}/${args.orderId}/shots/shot-${args.shot.shotNumber}-${randomUUID().slice(0, 8)}.mp4`;
    return {
      provider: 'stub_scene',
      shotArtifactKey,
      shotMeta: {
        shotNumber: args.shot.shotNumber,
        sceneId: args.shot.sceneId,
        shotType: args.shot.shotType,
        camera: args.shot.camera,
        lighting: args.shot.lighting,
        durationSec: args.shot.durationSec,
        characterId: args.characterProfile.characterId
      }
    };
  }

  async composeFinal(args: {
    orderId: string;
    userId: string;
    shotArtifactKeys: string[];
    totalDurationSec: number;
    characterProfile: CharacterProfile;
  }): Promise<FinalComposeResult> {
    const finalVideoArtifactKey = `${args.userId}/${args.orderId}/final/final-${randomUUID().slice(0, 8)}.mp4`;
    const thumbnailArtifactKey = `${args.userId}/${args.orderId}/thumb/thumb-${randomUUID().slice(0, 8)}.jpg`;

    return {
      provider: 'stub_scene',
      finalVideoArtifactKey,
      finalVideoMeta: {
        resolution: '1080p',
        durationSec: args.totalDurationSec,
        characterId: args.characterProfile.characterId,
        shotCount: args.shotArtifactKeys.length
      },
      thumbnailArtifactKey,
      thumbnailMeta: {
        generatedFrom: 'final_video'
      }
    };
  }

  async getProviderTaskStatus(args: {
    providerTaskId: string;
  }): Promise<ProviderTaskStatusResult> {
    return {
      providerTaskId: args.providerTaskId,
      provider: 'stub_scene',
      status: 'succeeded',
      artifactKey: null,
      output: {
        simulated: true
      },
      errorText: null,
      lastPolledAt: new Date().toISOString()
    };
  }
}

const voiceCloneResponseSchema = z.object({
  voiceCloneId: z.string().min(1),
  voiceCloneArtifactKey: z.string().min(1).optional(),
  voiceCloneMeta: z.record(z.unknown()).optional()
});

const voiceRenderResponseSchema = z.object({
  narrationArtifactKey: z.string().min(1),
  narrationMeta: z.record(z.unknown()).optional(),
  dialogueArtifactKey: z.string().min(1),
  dialogueMeta: z.record(z.unknown()).optional()
});

const characterPackResponseSchema = z.object({
  refsArtifactKey: z.string().min(1),
  refsMeta: z.record(z.unknown()).optional(),
  characterProfile: z.object({
    characterId: z.string().min(1),
    faceEmbeddingRef: z.string().min(1),
    hair: z.string().min(1),
    eyes: z.string().min(1),
    ageEstimate: z.number().int().nonnegative(),
    sourcePhotoCount: z.number().int().nonnegative(),
    voiceCloneId: z.string().min(1),
    modelStyle: z.string().min(1)
  })
});

const shotRenderResponseSchema = z.object({
  shotArtifactKey: z.string().min(1),
  shotMeta: z.record(z.unknown()).optional()
});

const finalComposeResponseSchema = z.object({
  finalVideoArtifactKey: z.string().min(1),
  finalVideoMeta: z.record(z.unknown()).optional(),
  thumbnailArtifactKey: z.string().min(1),
  thumbnailMeta: z.record(z.unknown()).optional()
});

const providerTaskStatusResponseSchema = z.object({
  providerTaskId: z.string().min(1),
  provider: z.string().min(1),
  status: z.enum(['queued', 'processing', 'succeeded', 'failed']),
  artifactKey: z.string().nullable().optional(),
  output: z.record(z.unknown()).optional(),
  errorText: z.string().nullable().optional(),
  lastPolledAt: z.string().nullable().optional()
});

class HttpVoiceProvider implements VoiceProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly authToken?: string
  ) {}

  private async post<T extends z.ZodTypeAny>(path: string, body: Record<string, unknown>, schema: T): Promise<z.infer<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${path}`);
      }
      const json = await response.json();
      return schema.parse(json);
    } finally {
      clearTimeout(timeout);
    }
  }

  async createVoiceClone(args: {
    orderId: string;
    userId: string;
    voiceUpload: WorkerUpload | null;
  }): Promise<VoiceCloneResult> {
    const response = await this.post(
      '/voice/clone',
      {
        orderId: args.orderId,
        userId: args.userId,
        voiceUpload: args.voiceUpload
      },
      voiceCloneResponseSchema
    );

    return {
      provider: 'http_voice',
      voiceCloneId: response.voiceCloneId,
      voiceCloneArtifactKey:
        response.voiceCloneArtifactKey ?? `${args.userId}/${args.orderId}/voice/clone-${response.voiceCloneId}.json`,
      voiceCloneMeta: response.voiceCloneMeta ?? { source: 'http_provider' }
    };
  }

  async renderVoiceTracks(args: {
    orderId: string;
    userId: string;
    voiceCloneId: string;
    scriptTitle: string;
    narrationLines: string[];
    dialogueLines: string[];
  }): Promise<VoiceRenderResult> {
    const response = await this.post(
      '/voice/render',
      {
        orderId: args.orderId,
        userId: args.userId,
        voiceCloneId: args.voiceCloneId,
        scriptTitle: args.scriptTitle,
        narrationLines: args.narrationLines,
        dialogueLines: args.dialogueLines
      },
      voiceRenderResponseSchema
    );

    return {
      provider: 'http_voice',
      narrationArtifactKey: response.narrationArtifactKey,
      narrationMeta: response.narrationMeta ?? {},
      dialogueArtifactKey: response.dialogueArtifactKey,
      dialogueMeta: response.dialogueMeta ?? {}
    };
  }
}

class HttpSceneProvider implements SceneProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly authToken?: string
  ) {}

  private async post<T extends z.ZodTypeAny>(path: string, body: Record<string, unknown>, schema: T): Promise<z.infer<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${path}`);
      }
      const json = await response.json();
      return schema.parse(json);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async get<T extends z.ZodTypeAny>(path: string, schema: T): Promise<z.infer<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {})
        },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${path}`);
      }
      const json = await response.json();
      return schema.parse(json);
    } finally {
      clearTimeout(timeout);
    }
  }

  async createCharacterPack(args: {
    orderId: string;
    userId: string;
    photoUploads: WorkerUpload[];
    voiceCloneId: string;
  }): Promise<CharacterPackResult> {
    const response = await this.post(
      '/scene/character-pack',
      {
        orderId: args.orderId,
        userId: args.userId,
        photoUploads: args.photoUploads,
        voiceCloneId: args.voiceCloneId
      },
      characterPackResponseSchema
    );

    return {
      provider: 'http_scene',
      characterProfile: response.characterProfile,
      refsArtifactKey: response.refsArtifactKey,
      refsMeta: response.refsMeta ?? {}
    };
  }

  async renderShot(args: {
    orderId: string;
    userId: string;
    shot: ScriptPayload['shots'][number];
    characterProfile: CharacterProfile;
  }): Promise<ShotRenderResult> {
    const response = await this.post(
      '/scene/render-shot',
      {
        orderId: args.orderId,
        userId: args.userId,
        shot: args.shot,
        characterProfile: args.characterProfile
      },
      shotRenderResponseSchema
    );

    return {
      provider: 'http_scene',
      shotArtifactKey: response.shotArtifactKey,
      shotMeta: response.shotMeta ?? {}
    };
  }

  async composeFinal(args: {
    orderId: string;
    userId: string;
    shotArtifactKeys: string[];
    totalDurationSec: number;
    characterProfile: CharacterProfile;
  }): Promise<FinalComposeResult> {
    const response = await this.post(
      '/scene/compose-final',
      {
        orderId: args.orderId,
        userId: args.userId,
        shotArtifactKeys: args.shotArtifactKeys,
        totalDurationSec: args.totalDurationSec,
        characterProfile: args.characterProfile
      },
      finalComposeResponseSchema
    );

    return {
      provider: 'http_scene',
      finalVideoArtifactKey: response.finalVideoArtifactKey,
      finalVideoMeta: response.finalVideoMeta ?? {},
      thumbnailArtifactKey: response.thumbnailArtifactKey,
      thumbnailMeta: response.thumbnailMeta ?? {}
    };
  }

  async getProviderTaskStatus(args: {
    providerTaskId: string;
  }): Promise<ProviderTaskStatusResult> {
    const response = await this.get(
      `/provider-tasks/${encodeURIComponent(args.providerTaskId)}`,
      providerTaskStatusResponseSchema
    );

    return {
      providerTaskId: response.providerTaskId,
      provider: response.provider,
      status: response.status,
      artifactKey: response.artifactKey ?? null,
      output: response.output ?? {},
      errorText: response.errorText ?? null,
      lastPolledAt: response.lastPolledAt ?? null
    };
  }
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function resolveVoiceProvider(): VoiceProvider {
  if (env.VOICE_PROVIDER_MODE === 'http' && env.VOICE_PROVIDER_BASE_URL) {
    return new HttpVoiceProvider(
      normalizeBaseUrl(env.VOICE_PROVIDER_BASE_URL),
      env.PROVIDER_HTTP_TIMEOUT_MS,
      env.PROVIDER_AUTH_TOKEN
    );
  }

  return new StubVoiceProvider();
}

function resolveSceneProvider(): SceneProvider {
  if (env.SCENE_PROVIDER_MODE === 'http' && env.SCENE_PROVIDER_BASE_URL) {
    return new HttpSceneProvider(
      normalizeBaseUrl(env.SCENE_PROVIDER_BASE_URL),
      env.PROVIDER_HTTP_TIMEOUT_MS,
      env.PROVIDER_AUTH_TOKEN
    );
  }

  return new StubSceneProvider();
}

export function buildProviderRegistry(): ProviderRegistry {
  return {
    voice: resolveVoiceProvider(),
    scene: resolveSceneProvider()
  };
}

import { createHash } from 'node:crypto';

import type { ScriptPayload, ThemeManifest } from '@little/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { query } from './db.js';
import { env } from './env.js';

interface ProviderOrderContextRow {
  order_id: string;
  user_id: string;
  theme_name: string;
  template_manifest_json: unknown;
}

interface ProviderOrderContext {
  orderId: string;
  userId: string;
  themeName: string;
  manifest: ThemeManifest;
}

const providerUploadSchema = z.object({
  kind: z.enum(['photo', 'voice']),
  s3Key: z.string().min(1),
  contentType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().nullable()
});

const characterProfileSchema = z.object({
  characterId: z.string().min(1),
  faceEmbeddingRef: z.string().min(1),
  hair: z.string().min(1),
  eyes: z.string().min(1),
  ageEstimate: z.number().int().nonnegative(),
  sourcePhotoCount: z.number().int().nonnegative(),
  voiceCloneId: z.string().min(1),
  modelStyle: z.string().min(1)
});

const shotLineSchema = z.object({
  shotNumber: z.number().int().positive(),
  durationSec: z.number().int().positive(),
  shotType: z.enum(['narration', 'dialogue']),
  sceneId: z.string().min(1),
  camera: z.string().min(1),
  lighting: z.string().min(1),
  environmentMotion: z.array(z.string()).default([]),
  soundDesignCues: z.array(z.string()).default([]),
  action: z.string(),
  dialogue: z.string(),
  narration: z.string()
});

const themeManifestSchema = z.object({
  heroShotTemplates: z.number().int().positive(),
  environmentCount: z.number().int().positive(),
  style: z.string().min(1),
  sceneArchitecture: z.string().min(1),
  durationMinSec: z.number().int().positive(),
  durationMaxSec: z.number().int().positive(),
  scenes: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        cameraPreset: z.string().min(1),
        lightingPreset: z.string().min(1),
        environmentMotionDefaults: z.array(z.string()).default([]),
        soundBed: z.string().min(1),
        anchors: z.object({
          child: z.object({
            x: z.number(),
            y: z.number(),
            scale: z.number().positive()
          })
        }),
        assets: z.object({
          bgLoop: z.string().min(1),
          particlesOverlay: z.string().min(1),
          lut: z.string().min(1)
        })
      })
    )
    .min(1)
});

const voiceCloneRequestSchema = z.object({
  orderId: z.string().uuid(),
  userId: z.string().uuid(),
  voiceUpload: providerUploadSchema.nullable()
});

const voiceRenderRequestSchema = z.object({
  orderId: z.string().uuid(),
  userId: z.string().uuid(),
  voiceCloneId: z.string().min(1),
  scriptTitle: z.string().min(1),
  narrationLines: z.array(z.string()),
  dialogueLines: z.array(z.string())
});

const characterPackRequestSchema = z.object({
  orderId: z.string().uuid(),
  userId: z.string().uuid(),
  photoUploads: z.array(providerUploadSchema),
  voiceCloneId: z.string().min(1)
});

const renderShotRequestSchema = z.object({
  orderId: z.string().uuid(),
  userId: z.string().uuid(),
  shot: shotLineSchema,
  characterProfile: characterProfileSchema
});

const composeFinalRequestSchema = z.object({
  orderId: z.string().uuid(),
  userId: z.string().uuid(),
  shotArtifactKeys: z.array(z.string().min(1)),
  totalDurationSec: z.number().int().positive(),
  characterProfile: characterProfileSchema
});

type ProviderUpload = z.infer<typeof providerUploadSchema>;

type CharacterProfile = z.infer<typeof characterProfileSchema>;

class ProviderRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

function hashHex(seed: string, length = 12): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, length);
}

function pickDeterministic<T>(seed: string, options: readonly T[]): T {
  const numeric = Number.parseInt(hashHex(seed, 8), 16);
  return options[numeric % options.length];
}

function parseAuthHeaderToken(value: string | string[] | undefined): string | null {
  if (!value || Array.isArray(value)) {
    return null;
  }

  const [scheme, token] = value.split(' ', 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }

  return token.trim();
}

function hasProviderAuth(request: FastifyRequest): boolean {
  if (!env.PROVIDER_AUTH_TOKEN) {
    return true;
  }

  const token = parseAuthHeaderToken(request.headers.authorization);
  return token === env.PROVIDER_AUTH_TOKEN;
}

function sendProviderError(reply: FastifyReply, request: FastifyRequest, error: unknown): FastifyReply {
  if (error instanceof z.ZodError) {
    return reply.status(400).send({
      message: 'Invalid provider request payload.',
      issues: error.issues
    });
  }

  if (error instanceof ProviderRequestError) {
    return reply.status(error.statusCode).send({ message: error.message });
  }

  request.log.error({ err: error }, 'Provider route failed');
  return reply.status(500).send({ message: 'Provider route failed.' });
}

function integrationModeAllowsExternal(): boolean {
  return env.PROVIDER_INTEGRATION_MODE !== 'stub';
}

function integrationModeIsStrict(): boolean {
  return env.PROVIDER_INTEGRATION_MODE === 'strict';
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function normalizePath(value: string): string {
  return value.startsWith('/') ? value : `/${value}`;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.PROVIDER_HTTP_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timed out after ${env.PROVIDER_HTTP_TIMEOUT_MS}ms: ${url}`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readBodyText(response: Response): Promise<string> {
  const text = await response.text();
  return text.trim().slice(0, 500);
}

function getByPath(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source;

  for (const segment of path) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function pickString(source: unknown, paths: ReadonlyArray<readonly string[]>): string | null {
  for (const path of paths) {
    const value = getByPath(source, path);
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

async function postJson(args: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}): Promise<unknown> {
  const response = await fetchWithTimeout(args.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...args.headers
    },
    body: JSON.stringify(args.body)
  });

  const rawText = await response.text();
  let parsed: unknown = null;
  if (rawText.trim().length > 0) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { rawText };
    }
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${args.url}: ${rawText.slice(0, 300)}`);
  }

  return parsed;
}

function buildAssetDownloadUrl(s3Key: string): string {
  const base = normalizeBaseUrl(env.PROVIDER_SOURCE_ASSET_BASE_URL ?? env.PUBLIC_ASSET_BASE_URL);
  return `${base}/download/${encodeURIComponent(s3Key)}?token=dev`;
}

async function fetchSourceAssetBytes(upload: ProviderUpload): Promise<{ contentType: string; bytes: ArrayBuffer; sourceUrl: string }> {
  const sourceUrl = buildAssetDownloadUrl(upload.s3Key);
  const headers: Record<string, string> = {};

  if (env.PROVIDER_SOURCE_ASSET_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${env.PROVIDER_SOURCE_ASSET_BEARER_TOKEN}`;
  }

  const response = await fetchWithTimeout(sourceUrl, {
    method: 'GET',
    headers
  });

  if (!response.ok) {
    const text = await readBodyText(response);
    throw new Error(`Failed to fetch source asset ${upload.s3Key}: HTTP ${response.status} ${text}`);
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw new Error(`Source asset ${upload.s3Key} is empty.`);
  }

  return {
    contentType: upload.contentType,
    bytes,
    sourceUrl
  };
}

async function createElevenLabsClone(args: {
  orderId: string;
  userId: string;
  voiceUpload: ProviderUpload;
}): Promise<{ voiceCloneId: string; sourceBytes: number; sourceUrl: string }> {
  if (!env.ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY is not configured.');
  }

  const source = await fetchSourceAssetBytes(args.voiceUpload);

  const form = new FormData();
  form.set('name', `lls-${args.orderId.slice(0, 8)}-voice`);
  form.set('description', `Little Legend order ${args.orderId}`);
  form.append(
    'files',
    new Blob([source.bytes], { type: source.contentType }),
    `voice-sample-${args.orderId.slice(0, 8)}.wav`
  );

  const endpoint = `${normalizeBaseUrl(env.ELEVENLABS_BASE_URL)}/v1/voices/add`;
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'xi-api-key': env.ELEVENLABS_API_KEY
    },
    body: form
  });

  const rawText = await response.text();
  let parsed: unknown = null;
  if (rawText.trim().length > 0) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { rawText };
    }
  }

  if (!response.ok) {
    throw new Error(`ElevenLabs voice clone failed: HTTP ${response.status} ${rawText.slice(0, 300)}`);
  }

  const voiceCloneId = pickString(parsed, [
    ['voice_id'],
    ['voiceId'],
    ['id'],
    ['data', 'voice_id'],
    ['data', 'voiceId']
  ]);

  if (!voiceCloneId) {
    throw new Error('ElevenLabs voice clone response did not include voice id.');
  }

  return {
    voiceCloneId,
    sourceBytes: source.bytes.byteLength,
    sourceUrl: source.sourceUrl
  };
}

async function renderElevenLabsTrack(args: { voiceId: string; text: string }): Promise<{ byteLength: number; requestId: string | null }> {
  if (!env.ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY is not configured.');
  }

  if (args.text.trim().length === 0) {
    return {
      byteLength: 0,
      requestId: null
    };
  }

  const endpoint = `${normalizeBaseUrl(env.ELEVENLABS_BASE_URL)}/v1/text-to-speech/${encodeURIComponent(args.voiceId)}`;

  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'xi-api-key': env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify({
      text: args.text,
      model_id: env.ELEVENLABS_MODEL_ID,
      output_format: env.ELEVENLABS_OUTPUT_FORMAT
    })
  });

  if (!response.ok) {
    const text = await readBodyText(response);
    throw new Error(`ElevenLabs TTS failed: HTTP ${response.status} ${text}`);
  }

  const audio = await response.arrayBuffer();
  return {
    byteLength: audio.byteLength,
    requestId: response.headers.get('request-id') ?? response.headers.get('x-request-id')
  };
}

async function queueHeyGenShot(args: {
  orderId: string;
  userId: string;
  themeName: string;
  shot: ScriptPayload['shots'][number];
  sceneName: string;
  characterProfile: CharacterProfile;
}): Promise<{ providerTaskId: string }> {
  if (!env.HEYGEN_API_KEY) {
    throw new Error('HEYGEN_API_KEY is not configured.');
  }

  const endpoint = `${normalizeBaseUrl(env.HEYGEN_BASE_URL)}${normalizePath(env.HEYGEN_VIDEO_GENERATE_PATH)}`;
  const prompt = [
    `${args.themeName} cinematic scene \"${args.sceneName}\"`,
    `${args.shot.camera} camera`,
    `${args.shot.lighting} lighting`,
    args.shot.shotType === 'dialogue' ? `child speaks: ${args.shot.dialogue}` : `narration beat: ${args.shot.narration}`,
    `character id ${args.characterProfile.characterId}`
  ].join('; ');

  const payload = await postJson({
    url: endpoint,
    headers: {
      'X-Api-Key': env.HEYGEN_API_KEY,
      Authorization: `Bearer ${env.HEYGEN_API_KEY}`
    },
    body: {
      prompt,
      metadata: {
        orderId: args.orderId,
        userId: args.userId,
        shotNumber: args.shot.shotNumber
      }
    }
  });

  const providerTaskId = pickString(payload, [
    ['data', 'video_id'],
    ['data', 'videoId'],
    ['video_id'],
    ['videoId'],
    ['data', 'id'],
    ['id']
  ]);

  if (!providerTaskId) {
    throw new Error('HeyGen response did not include a task/video id.');
  }

  return { providerTaskId };
}

async function queueShotstackRender(args: {
  orderId: string;
  themeName: string;
  totalDurationSec: number;
  shotCount: number;
  characterProfile: CharacterProfile;
}): Promise<{ providerTaskId: string }> {
  if (!env.SHOTSTACK_API_KEY) {
    throw new Error('SHOTSTACK_API_KEY is not configured.');
  }

  const endpoint = `${normalizeBaseUrl(env.SHOTSTACK_BASE_URL)}/edit/${env.SHOTSTACK_STAGE}/render`;

  const payload = await postJson({
    url: endpoint,
    headers: {
      'x-api-key': env.SHOTSTACK_API_KEY
    },
    body: {
      timeline: {
        tracks: [
          {
            clips: [
              {
                asset: {
                  type: 'title',
                  text: `${args.themeName}: ${args.characterProfile.characterId}`,
                  style: 'minimal'
                },
                start: 0,
                length: Math.max(4, Math.min(args.totalDurationSec, 20))
              }
            ]
          }
        ]
      },
      output: {
        format: 'mp4',
        resolution: args.totalDurationSec <= 35 ? 'hd' : 'sd'
      }
    }
  });

  const providerTaskId = pickString(payload, [
    ['response', 'id'],
    ['data', 'id'],
    ['id']
  ]);

  if (!providerTaskId) {
    throw new Error('Shotstack response did not include a render id.');
  }

  return { providerTaskId };
}

async function loadOrderContext(orderId: string, userId: string): Promise<ProviderOrderContext> {
  const rows = await query<ProviderOrderContextRow>(
    `
    SELECT
      o.id AS order_id,
      o.user_id,
      t.name AS theme_name,
      t.template_manifest_json
    FROM orders o
    JOIN themes t ON t.id = o.theme_id
    WHERE o.id = $1
    LIMIT 1
    `,
    [orderId]
  );

  const row = rows[0];
  if (!row) {
    throw new ProviderRequestError(404, 'Order not found.');
  }

  if (row.user_id !== userId) {
    throw new ProviderRequestError(403, 'Order/user mismatch.');
  }

  return {
    orderId: row.order_id,
    userId: row.user_id,
    themeName: row.theme_name,
    manifest: themeManifestSchema.parse(row.template_manifest_json) as ThemeManifest
  };
}

function buildCharacterProfile(args: {
  orderId: string;
  photoUploads: ProviderUpload[];
  voiceCloneId: string;
}) {
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

function buildShotKey(args: {
  orderId: string;
  userId: string;
  shot: ScriptPayload['shots'][number];
  characterId: string;
}) {
  const shotHash = hashHex(
    `${args.orderId}:${args.shot.shotNumber}:${args.shot.sceneId}:${args.characterId}:${args.shot.durationSec}`,
    8
  );
  return `${args.userId}/${args.orderId}/shots/shot-${args.shot.shotNumber}-${shotHash}.mp4`;
}

function buildFallbackVoiceClone(payload: z.infer<typeof voiceCloneRequestSchema>, reason: string) {
  const sourceSeed = payload.voiceUpload?.sha256 ?? payload.voiceUpload?.s3Key ?? payload.orderId;
  const voiceCloneId = `voice_${hashHex(`${payload.orderId}:${sourceSeed}`, 10)}`;
  const voiceCloneArtifactKey = `${payload.userId}/${payload.orderId}/voice/clone-${voiceCloneId}.json`;

  return {
    voiceCloneId,
    voiceCloneArtifactKey,
    voiceCloneMeta: {
      voiceCloneId,
      sourceVoiceKey: payload.voiceUpload?.s3Key ?? null,
      sourceContentType: payload.voiceUpload?.contentType ?? null,
      sourceDurationSec: payload.voiceUpload ? Math.max(30, Math.min(60, Math.round(payload.voiceUpload.bytes / 11000))) : null,
      providerModel: 'instant_voice_clone_v1_stub',
      fallbackReason: reason,
      integrationMode: env.PROVIDER_INTEGRATION_MODE
    }
  };
}

function buildFallbackVoiceRender(payload: z.infer<typeof voiceRenderRequestSchema>, reason: string) {
  const narrationChars = payload.narrationLines.join(' ').trim().length;
  const dialogueChars = payload.dialogueLines.join(' ').trim().length;
  const totalChars = narrationChars + dialogueChars;
  const estimatedDurationSec = Math.max(8, Math.round(totalChars / 12));

  const narrationArtifactKey = `${payload.userId}/${payload.orderId}/audio/narration-${hashHex(
    `${payload.orderId}:${payload.voiceCloneId}:narration:${payload.narrationLines.join('|')}`,
    8
  )}.mp3`;

  const dialogueArtifactKey = `${payload.userId}/${payload.orderId}/audio/dialogue-${hashHex(
    `${payload.orderId}:${payload.voiceCloneId}:dialogue:${payload.dialogueLines.join('|')}`,
    8
  )}.mp3`;

  return {
    narrationArtifactKey,
    narrationMeta: {
      scriptTitle: payload.scriptTitle,
      model: 'narration_tts_v1_stub',
      characterCount: narrationChars,
      estimatedDurationSec,
      fallbackReason: reason,
      integrationMode: env.PROVIDER_INTEGRATION_MODE
    },
    dialogueArtifactKey,
    dialogueMeta: {
      voiceCloneId: payload.voiceCloneId,
      model: 'dialogue_tts_v1_stub',
      characterCount: dialogueChars,
      estimatedDurationSec,
      fallbackReason: reason,
      integrationMode: env.PROVIDER_INTEGRATION_MODE
    }
  };
}

function buildFallbackShotRender(args: {
  payload: z.infer<typeof renderShotRequestSchema>;
  scene: ThemeManifest['scenes'][number];
  reason: string;
}) {
  const { payload, scene, reason } = args;
  const shotArtifactKey = buildShotKey({
    orderId: payload.orderId,
    userId: payload.userId,
    shot: payload.shot,
    characterId: payload.characterProfile.characterId
  });

  return {
    shotArtifactKey,
    shotMeta: {
      shotNumber: payload.shot.shotNumber,
      sceneId: scene.id,
      sceneName: scene.name,
      shotType: payload.shot.shotType,
      camera: payload.shot.camera || scene.cameraPreset,
      lighting: payload.shot.lighting || scene.lightingPreset,
      environmentMotion:
        payload.shot.environmentMotion.length > 0 ? payload.shot.environmentMotion : scene.environmentMotionDefaults,
      assets: scene.assets,
      anchors: scene.anchors,
      soundBed: scene.soundBed,
      renderModel: 'scene_parallax_compositor_v1_stub',
      characterId: payload.characterProfile.characterId,
      fallbackReason: reason,
      integrationMode: env.PROVIDER_INTEGRATION_MODE
    }
  };
}

function buildFallbackFinalCompose(args: {
  payload: z.infer<typeof composeFinalRequestSchema>;
  context: ProviderOrderContext;
  reason: string;
}) {
  const { payload, context, reason } = args;
  const resolution = payload.totalDurationSec <= 35 ? '1080p' : '720p';
  const finalHash = hashHex(
    `${payload.orderId}:${payload.characterProfile.characterId}:${payload.shotArtifactKeys.join('|')}:${payload.totalDurationSec}`,
    8
  );
  const finalVideoArtifactKey = `${payload.userId}/${payload.orderId}/final/final-${finalHash}.mp4`;
  const thumbnailArtifactKey = `${payload.userId}/${payload.orderId}/thumb/thumb-${finalHash}.jpg`;

  return {
    finalVideoArtifactKey,
    finalVideoMeta: {
      themeName: context.themeName,
      shotCount: payload.shotArtifactKeys.length,
      durationSec: payload.totalDurationSec,
      resolution,
      codecVideo: 'h264',
      codecAudio: 'aac',
      fallbackUsed: resolution === '720p',
      fallbackReason: reason,
      integrationMode: env.PROVIDER_INTEGRATION_MODE
    },
    thumbnailArtifactKey,
    thumbnailMeta: {
      generatedFrom: finalVideoArtifactKey,
      integrationMode: env.PROVIDER_INTEGRATION_MODE
    }
  };
}

export function registerProviderRoutes(app: FastifyInstance): void {
  app.post('/voice/clone', async (request, reply) => {
    if (!hasProviderAuth(request)) {
      return reply.status(401).send({ message: 'Unauthorized provider request.' });
    }

    try {
      const payload = voiceCloneRequestSchema.parse(request.body);
      await loadOrderContext(payload.orderId, payload.userId);

      if (!payload.voiceUpload) {
        throw new ProviderRequestError(400, 'Voice upload is required.');
      }

      const fallback = (reason: string) => buildFallbackVoiceClone(payload, reason);

      if (!integrationModeAllowsExternal()) {
        return reply.send(fallback('Provider integration mode is stub.'));
      }

      if (!env.ELEVENLABS_API_KEY) {
        if (integrationModeIsStrict()) {
          throw new ProviderRequestError(503, 'Strict provider mode enabled but ELEVENLABS_API_KEY is missing.');
        }
        return reply.send(fallback('ELEVENLABS_API_KEY is missing.'));
      }

      try {
        const clone = await createElevenLabsClone({
          orderId: payload.orderId,
          userId: payload.userId,
          voiceUpload: payload.voiceUpload
        });

        const voiceCloneArtifactKey = `${payload.userId}/${payload.orderId}/voice/clone-${clone.voiceCloneId}.json`;

        return reply.send({
          voiceCloneId: clone.voiceCloneId,
          voiceCloneArtifactKey,
          voiceCloneMeta: {
            voiceCloneId: clone.voiceCloneId,
            sourceVoiceKey: payload.voiceUpload.s3Key,
            sourceContentType: payload.voiceUpload.contentType,
            sourceAudioBytes: clone.sourceBytes,
            sourceDownloadUrl: clone.sourceUrl,
            providerModel: 'elevenlabs_voice_clone',
            integrationMode: env.PROVIDER_INTEGRATION_MODE
          }
        });
      } catch (error) {
        const message = (error as Error).message;
        if (integrationModeIsStrict()) {
          throw new ProviderRequestError(502, `ElevenLabs voice clone failed: ${message}`);
        }

        request.log.warn({ err: error, orderId: payload.orderId }, 'Falling back to stub voice clone');
        return reply.send(fallback(`ElevenLabs voice clone failed: ${message}`));
      }
    } catch (error) {
      return sendProviderError(reply, request, error);
    }
  });

  app.post('/voice/render', async (request, reply) => {
    if (!hasProviderAuth(request)) {
      return reply.status(401).send({ message: 'Unauthorized provider request.' });
    }

    try {
      const payload = voiceRenderRequestSchema.parse(request.body);
      await loadOrderContext(payload.orderId, payload.userId);

      const fallback = (reason: string) => buildFallbackVoiceRender(payload, reason);

      if (!integrationModeAllowsExternal()) {
        return reply.send(fallback('Provider integration mode is stub.'));
      }

      if (!env.ELEVENLABS_API_KEY) {
        if (integrationModeIsStrict()) {
          throw new ProviderRequestError(503, 'Strict provider mode enabled but ELEVENLABS_API_KEY is missing.');
        }
        return reply.send(fallback('ELEVENLABS_API_KEY is missing.'));
      }

      const effectiveVoiceId =
        payload.voiceCloneId.startsWith('voice_') && env.ELEVENLABS_FALLBACK_VOICE_ID
          ? env.ELEVENLABS_FALLBACK_VOICE_ID
          : payload.voiceCloneId;

      try {
        const narrationText = payload.narrationLines.join(' ').trim();
        const dialogueText = payload.dialogueLines.join(' ').trim();

        const narration = await renderElevenLabsTrack({
          voiceId: effectiveVoiceId,
          text: narrationText
        });

        const dialogue = await renderElevenLabsTrack({
          voiceId: effectiveVoiceId,
          text: dialogueText
        });

        const narrationArtifactKey = `${payload.userId}/${payload.orderId}/audio/narration-${hashHex(
          `${payload.orderId}:${effectiveVoiceId}:narration:${payload.narrationLines.join('|')}`,
          8
        )}.mp3`;

        const dialogueArtifactKey = `${payload.userId}/${payload.orderId}/audio/dialogue-${hashHex(
          `${payload.orderId}:${effectiveVoiceId}:dialogue:${payload.dialogueLines.join('|')}`,
          8
        )}.mp3`;

        return reply.send({
          narrationArtifactKey,
          narrationMeta: {
            scriptTitle: payload.scriptTitle,
            model: env.ELEVENLABS_MODEL_ID,
            outputFormat: env.ELEVENLABS_OUTPUT_FORMAT,
            voiceId: effectiveVoiceId,
            generatedAudioBytes: narration.byteLength,
            providerRequestId: narration.requestId,
            integrationMode: env.PROVIDER_INTEGRATION_MODE
          },
          dialogueArtifactKey,
          dialogueMeta: {
            voiceCloneId: payload.voiceCloneId,
            resolvedVoiceId: effectiveVoiceId,
            model: env.ELEVENLABS_MODEL_ID,
            outputFormat: env.ELEVENLABS_OUTPUT_FORMAT,
            generatedAudioBytes: dialogue.byteLength,
            providerRequestId: dialogue.requestId,
            integrationMode: env.PROVIDER_INTEGRATION_MODE
          }
        });
      } catch (error) {
        const message = (error as Error).message;
        if (integrationModeIsStrict()) {
          throw new ProviderRequestError(502, `ElevenLabs voice render failed: ${message}`);
        }

        request.log.warn({ err: error, orderId: payload.orderId }, 'Falling back to stub voice render');
        return reply.send(fallback(`ElevenLabs voice render failed: ${message}`));
      }
    } catch (error) {
      return sendProviderError(reply, request, error);
    }
  });

  app.post('/scene/character-pack', async (request, reply) => {
    if (!hasProviderAuth(request)) {
      return reply.status(401).send({ message: 'Unauthorized provider request.' });
    }

    try {
      const payload = characterPackRequestSchema.parse(request.body);
      const context = await loadOrderContext(payload.orderId, payload.userId);

      if (payload.photoUploads.length < 5 || payload.photoUploads.length > 15) {
        throw new ProviderRequestError(400, 'Character pack requires 5-15 photos.');
      }

      const characterProfile = buildCharacterProfile({
        orderId: payload.orderId,
        photoUploads: payload.photoUploads,
        voiceCloneId: payload.voiceCloneId
      });

      const refsArtifactKey = `${payload.userId}/${payload.orderId}/character/refs-${characterProfile.characterId}.json`;

      return reply.send({
        refsArtifactKey,
        refsMeta: {
          ...characterProfile,
          themeName: context.themeName,
          referenceFrames: ['neutral', 'happy', 'surprised', 'profile'],
          styleGuide: {
            palette: 'cinematic-soft',
            lineWeight: 'medium',
            shading: 'toon_cinematic'
          },
          integrationMode: env.PROVIDER_INTEGRATION_MODE
        },
        characterProfile
      });
    } catch (error) {
      return sendProviderError(reply, request, error);
    }
  });

  app.post('/scene/render-shot', async (request, reply) => {
    if (!hasProviderAuth(request)) {
      return reply.status(401).send({ message: 'Unauthorized provider request.' });
    }

    try {
      const payload = renderShotRequestSchema.parse(request.body);
      const context = await loadOrderContext(payload.orderId, payload.userId);
      const scene = context.manifest.scenes.find((entry) => entry.id === payload.shot.sceneId);

      if (!scene) {
        throw new ProviderRequestError(
          400,
          `Scene "${payload.shot.sceneId}" does not exist in the "${context.themeName}" theme pack.`
        );
      }

      const fallback = (reason: string) =>
        buildFallbackShotRender({
          payload,
          scene,
          reason
        });

      if (!integrationModeAllowsExternal()) {
        return reply.send(fallback('Provider integration mode is stub.'));
      }

      if (!env.HEYGEN_API_KEY) {
        if (integrationModeIsStrict()) {
          throw new ProviderRequestError(503, 'Strict provider mode enabled but HEYGEN_API_KEY is missing.');
        }
        return reply.send(fallback('HEYGEN_API_KEY is missing.'));
      }

      try {
        const shotQueue = await queueHeyGenShot({
          orderId: payload.orderId,
          userId: payload.userId,
          themeName: context.themeName,
          shot: payload.shot,
          sceneName: scene.name,
          characterProfile: payload.characterProfile
        });

        const shotArtifactKey = buildShotKey({
          orderId: payload.orderId,
          userId: payload.userId,
          shot: payload.shot,
          characterId: payload.characterProfile.characterId
        });

        return reply.send({
          shotArtifactKey,
          shotMeta: {
            shotNumber: payload.shot.shotNumber,
            sceneId: scene.id,
            sceneName: scene.name,
            shotType: payload.shot.shotType,
            camera: payload.shot.camera || scene.cameraPreset,
            lighting: payload.shot.lighting || scene.lightingPreset,
            environmentMotion:
              payload.shot.environmentMotion.length > 0 ? payload.shot.environmentMotion : scene.environmentMotionDefaults,
            assets: scene.assets,
            anchors: scene.anchors,
            soundBed: scene.soundBed,
            renderModel: 'heygen_video_agent',
            providerTaskId: shotQueue.providerTaskId,
            characterId: payload.characterProfile.characterId,
            integrationMode: env.PROVIDER_INTEGRATION_MODE
          }
        });
      } catch (error) {
        const message = (error as Error).message;
        if (integrationModeIsStrict()) {
          throw new ProviderRequestError(502, `HeyGen shot render failed: ${message}`);
        }

        request.log.warn({ err: error, orderId: payload.orderId }, 'Falling back to stub scene shot render');
        return reply.send(fallback(`HeyGen shot render failed: ${message}`));
      }
    } catch (error) {
      return sendProviderError(reply, request, error);
    }
  });

  app.post('/scene/compose-final', async (request, reply) => {
    if (!hasProviderAuth(request)) {
      return reply.status(401).send({ message: 'Unauthorized provider request.' });
    }

    try {
      const payload = composeFinalRequestSchema.parse(request.body);
      const context = await loadOrderContext(payload.orderId, payload.userId);

      if (payload.shotArtifactKeys.length === 0) {
        throw new ProviderRequestError(400, 'At least one shot artifact key is required.');
      }

      const fallback = (reason: string) =>
        buildFallbackFinalCompose({
          payload,
          context,
          reason
        });

      if (!integrationModeAllowsExternal()) {
        return reply.send(fallback('Provider integration mode is stub.'));
      }

      if (!env.SHOTSTACK_API_KEY) {
        if (integrationModeIsStrict()) {
          throw new ProviderRequestError(503, 'Strict provider mode enabled but SHOTSTACK_API_KEY is missing.');
        }

        return reply.send(fallback('SHOTSTACK_API_KEY is missing.'));
      }

      try {
        const compose = await queueShotstackRender({
          orderId: payload.orderId,
          themeName: context.themeName,
          totalDurationSec: payload.totalDurationSec,
          shotCount: payload.shotArtifactKeys.length,
          characterProfile: payload.characterProfile
        });

        const resolution = payload.totalDurationSec <= 35 ? '1080p' : '720p';
        const finalHash = hashHex(
          `${payload.orderId}:${payload.characterProfile.characterId}:${payload.shotArtifactKeys.join('|')}:${payload.totalDurationSec}`,
          8
        );
        const finalVideoArtifactKey = `${payload.userId}/${payload.orderId}/final/final-${finalHash}.mp4`;
        const thumbnailArtifactKey = `${payload.userId}/${payload.orderId}/thumb/thumb-${finalHash}.jpg`;

        return reply.send({
          finalVideoArtifactKey,
          finalVideoMeta: {
            themeName: context.themeName,
            shotCount: payload.shotArtifactKeys.length,
            durationSec: payload.totalDurationSec,
            resolution,
            codecVideo: 'h264',
            codecAudio: 'aac',
            fallbackUsed: resolution === '720p',
            renderModel: 'shotstack_composer',
            providerTaskId: compose.providerTaskId,
            integrationMode: env.PROVIDER_INTEGRATION_MODE
          },
          thumbnailArtifactKey,
          thumbnailMeta: {
            generatedFrom: finalVideoArtifactKey,
            providerTaskId: compose.providerTaskId,
            integrationMode: env.PROVIDER_INTEGRATION_MODE
          }
        });
      } catch (error) {
        const message = (error as Error).message;
        if (integrationModeIsStrict()) {
          throw new ProviderRequestError(502, `Shotstack compose failed: ${message}`);
        }

        request.log.warn({ err: error, orderId: payload.orderId }, 'Falling back to stub final compose');
        return reply.send(fallback(`Shotstack compose failed: ${message}`));
      }
    } catch (error) {
      return sendProviderError(reply, request, error);
    }
  });
}

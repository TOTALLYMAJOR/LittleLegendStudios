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
  photoUploads: Array<z.infer<typeof providerUploadSchema>>;
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

      const sourceSeed = payload.voiceUpload.sha256 ?? payload.voiceUpload.s3Key;
      const voiceCloneId = `voice_${hashHex(`${payload.orderId}:${sourceSeed}`, 10)}`;
      const voiceCloneArtifactKey = `${payload.userId}/${payload.orderId}/voice/clone-${voiceCloneId}.json`;

      return reply.send({
        voiceCloneId,
        voiceCloneArtifactKey,
        voiceCloneMeta: {
          voiceCloneId,
          sourceVoiceKey: payload.voiceUpload.s3Key,
          sourceContentType: payload.voiceUpload.contentType,
          sourceDurationSec: Math.max(30, Math.min(60, Math.round(payload.voiceUpload.bytes / 11000))),
          providerModel: 'instant_voice_clone_v1'
        }
      });
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

      return reply.send({
        narrationArtifactKey,
        narrationMeta: {
          scriptTitle: payload.scriptTitle,
          model: 'narration_tts_v1',
          characterCount: narrationChars,
          estimatedDurationSec
        },
        dialogueArtifactKey,
        dialogueMeta: {
          voiceCloneId: payload.voiceCloneId,
          model: 'dialogue_tts_v1',
          characterCount: dialogueChars,
          estimatedDurationSec
        }
      });
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
          }
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
          renderModel: 'scene_parallax_compositor_v1',
          characterId: payload.characterProfile.characterId
        }
      });
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
          fallbackUsed: resolution === '720p'
        },
        thumbnailArtifactKey,
        thumbnailMeta: {
          generatedFrom: finalVideoArtifactKey
        }
      });
    } catch (error) {
      return sendProviderError(reply, request, error);
    }
  });
}

import type { ScriptPayload, ThemeManifest } from '@little/shared';
import { z } from 'zod';

import { compileCinematicShotPlan } from './prompt-engine.js';

interface ScriptInput {
  childName: string;
  themeName: string;
  keywords?: string[];
  templateManifest: unknown;
}

const themeManifestSchema = z.object({
  heroShotTemplates: z.number().int().positive(),
  environmentCount: z.number().int().positive(),
  style: z.string().min(1),
  sceneArchitecture: z.string().min(1),
  durationMinSec: z.number().int().positive(),
  durationMaxSec: z.number().int().positive(),
  palette: z.array(z.string().min(1)).optional(),
  globalFx: z.array(z.string().min(1)).optional(),
  defaultShotCount: z.number().int().positive().optional(),
  targetAspectRatio: z.string().min(1).optional(),
  targetDurationSec: z.number().int().positive().optional(),
  shotTemplates: z
    .array(
      z.object({
        id: z.string().min(1),
        shotType: z.enum(['narration', 'dialogue']),
        label: z.string().min(1).optional(),
        targetDurationSec: z.number().int().positive(),
        durationRangeSec: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
        preferredSceneId: z.string().min(1).optional(),
        camera: z.string().min(1).optional(),
        lighting: z.string().min(1).optional(),
        characterPresence: z.enum(['offscreen', 'hero', 'supporting', 'cameo']).optional(),
        emotion: z.string().min(1).optional(),
        gesture: z.string().min(1).optional(),
        onScreenSpeaking: z.boolean().optional()
      })
    )
    .optional(),
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
          }),
          petOptional: z
            .object({
              x: z.number(),
              y: z.number(),
              scale: z.number().positive()
            })
            .optional(),
          familyOptional: z
            .object({
              x: z.number(),
              y: z.number(),
              scale: z.number().positive()
            })
            .optional()
        }),
        assets: z.object({
          bgLoop: z.string().min(1),
          particlesOverlay: z.string().min(1),
          lut: z.string().min(1),
          atmosphereOverlay: z.string().min(1).nullable().optional(),
          foregroundOverlay: z.string().min(1).nullable().optional(),
          depthMap: z.string().min(1).nullable().optional()
        }),
        palette: z.array(z.string().min(1)).optional(),
        globalFx: z.array(z.string().min(1)).optional(),
        audio: z
          .object({
            musicBed: z.string().min(1).nullable().optional(),
            sfx: z.array(z.string().min(1)).optional()
          })
          .optional(),
        cameraMove: z.string().min(1).optional(),
        parallaxStrength: z.number().nonnegative().optional(),
        grade: z
          .object({
            lut: z.string().min(1),
            intensity: z.number().nonnegative().optional()
          })
          .optional()
      })
    )
    .min(1)
});

export function generateScript({ childName, themeName, keywords, templateManifest }: ScriptInput): ScriptPayload {
  const manifest = themeManifestSchema.parse(templateManifest) as ThemeManifest;

  return compileCinematicShotPlan({
    childName,
    themeName,
    keywords,
    manifest
  });
}

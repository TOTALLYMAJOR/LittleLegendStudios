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

export function generateScript({ childName, themeName, keywords, templateManifest }: ScriptInput): ScriptPayload {
  const manifest = themeManifestSchema.parse(templateManifest) as ThemeManifest;

  return compileCinematicShotPlan({
    childName,
    themeName,
    keywords,
    manifest
  });
}

import type { ScriptPayload, ThemeManifest, ThemeScene } from '@little/shared';

interface CinematicPromptInput {
  childName: string;
  themeName: string;
  keywords?: string[];
  manifest: ThemeManifest;
}

const shotDurations = [7, 6, 9, 8] as const;
const shotTypes: Array<'narration' | 'dialogue'> = ['narration', 'dialogue', 'narration', 'dialogue'];
const cameraByShot = ['wide_establishing_pan', 'hero_low_angle_push', 'tracking_action_orbit', 'emotional_pullback'];
const lightingByShot = ['golden_hour_volumetric', 'hero_key_fill', 'cinematic_contrast', 'warm_emotional_glow'];

function pickScene(manifest: ThemeManifest, shotIndex: number): ThemeScene {
  if (manifest.scenes.length === 0) {
    throw new Error('Theme manifest must include at least one scene.');
  }

  return manifest.scenes[shotIndex % manifest.scenes.length];
}

function buildNarrationLines(childName: string, themeName: string, keywords: string[]): string[] {
  const keywordTail = keywords.length > 0 ? ` with ${keywords.slice(0, 2).join(' and ')}` : '';
  return [
    `I stepped into ${themeName}${keywordTail}, and everything around me felt bigger than life.`,
    `Each turn brought a new challenge, but I stayed brave and kept moving.`,
    `When the adventure ended, I came home smiling with a story I'll remember forever.`
  ];
}

export function compileCinematicShotPlan(input: CinematicPromptInput): ScriptPayload {
  const keywords = (input.keywords ?? []).map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0);
  const narrationLines = buildNarrationLines(input.childName, input.themeName, keywords);

  const shots = shotDurations.map((durationSec, index) => {
    const shotNumber = index + 1;
    const scene = pickScene(input.manifest, index);
    const shotType = shotTypes[index];
    const camera = scene.cameraPreset || cameraByShot[index];
    const lighting = scene.lightingPreset || lightingByShot[index];
    const environmentMotion = scene.environmentMotionDefaults.length
      ? scene.environmentMotionDefaults
      : ['volumetric fog', 'ambient particles'];

    const narration = shotType === 'narration' ? narrationLines[index === 2 ? 1 : 0] : '';
    const dialogue =
      shotType === 'dialogue'
        ? index === 1
          ? `I've got this. Let's go!`
          : `That was amazing. I can't wait for my next adventure!`
        : 'Narration only.';

    const action =
      shotType === 'narration'
        ? `Narrated cinematic beat in scene "${scene.name}" with ${camera} camera and ${lighting} lighting.`
        : `${input.childName} speaks on-screen in scene "${scene.name}" with ${camera} camera and ${lighting} lighting.`;

    const soundDesignCues =
      shotType === 'narration'
        ? ['ambient swell', 'whoosh transition']
        : ['dialogue focus', 'subtle riser'];

    return {
      shotNumber,
      durationSec,
      shotType,
      sceneId: scene.id,
      camera,
      lighting,
      environmentMotion,
      soundDesignCues,
      action,
      dialogue,
      narration
    };
  });

  return {
    title: `${input.childName}'s ${input.themeName} Adventure`,
    narration: narrationLines,
    totalDurationSec: shotDurations.reduce((sum, value) => sum + value, 0),
    shots
  };
}


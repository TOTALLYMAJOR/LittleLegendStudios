import type { ScriptPayload, ThemeManifest, ThemeScene, ThemeShotTemplate } from '@little/shared';

interface CinematicPromptInput {
  childName: string;
  themeName: string;
  keywords?: string[];
  manifest: ThemeManifest;
}

const defaultTemplateDurations = [7, 6, 9, 8] as const;
const defaultTemplateTypes: Array<'narration' | 'dialogue'> = ['narration', 'dialogue', 'narration', 'dialogue'];
const cameraByShot = ['wide_establishing_pan', 'hero_low_angle_push', 'tracking_action_orbit', 'emotional_pullback'];
const lightingByShot = ['golden_hour_volumetric', 'hero_key_fill', 'cinematic_contrast', 'warm_emotional_glow'];

function pickScene(manifest: ThemeManifest, shotIndex: number): ThemeScene {
  if (manifest.scenes.length === 0) {
    throw new Error('Theme manifest must include at least one scene.');
  }

  return manifest.scenes[shotIndex % manifest.scenes.length];
}

function fallbackShotTemplates(manifest: ThemeManifest): ThemeShotTemplate[] {
  const shotCount = manifest.defaultShotCount ?? manifest.heroShotTemplates ?? defaultTemplateDurations.length;

  return Array.from({ length: shotCount }, (_, index) => {
    const duration = defaultTemplateDurations[index] ?? (index % 2 === 0 ? 8 : 7);
    const shotType = defaultTemplateTypes[index] ?? (index % 2 === 0 ? 'narration' : 'dialogue');

    return {
      id: `shot_${index + 1}`,
      shotType,
      targetDurationSec: duration,
      label:
        shotType === 'dialogue'
          ? index === shotCount - 1
            ? 'Ending'
            : 'Hero Moment'
          : index === 0
            ? 'Intro'
            : index === shotCount - 2
              ? 'Climax'
              : 'Adventure',
      characterPresence: shotType === 'dialogue' ? 'hero' : 'offscreen',
      emotion: shotType === 'dialogue' ? (index === shotCount - 1 ? 'joyful' : 'confident') : index === 0 ? 'wonder' : 'relief',
      gesture: shotType === 'dialogue' ? (index === shotCount - 1 ? 'celebrate' : 'point_forward') : undefined,
      onScreenSpeaking: shotType === 'dialogue'
    };
  });
}

function clampDuration(value: number, range: [number, number] | undefined): number {
  if (!range) {
    return Math.max(1, value);
  }

  return Math.max(range[0], Math.min(range[1], value));
}

function distributeDurations(templates: ThemeShotTemplate[], targetTotalDurationSec: number): number[] {
  const baseDurations = templates.map((template) => clampDuration(template.targetDurationSec, template.durationRangeSec));
  const baseTotal = baseDurations.reduce((sum, duration) => sum + duration, 0);
  if (baseTotal === targetTotalDurationSec) {
    return baseDurations;
  }

  const scaledDurations = templates.map((template, index) => {
    const scaled = Math.round((baseDurations[index] / baseTotal) * targetTotalDurationSec);
    return clampDuration(scaled, template.durationRangeSec);
  });

  let currentTotal = scaledDurations.reduce((sum, duration) => sum + duration, 0);
  let cursor = 0;
  while (currentTotal !== targetTotalDurationSec && templates.length > 0 && cursor < templates.length * 20) {
    const index = cursor % templates.length;
    const template = templates[index];
    const [minDuration, maxDuration] = template.durationRangeSec ?? [1, Number.MAX_SAFE_INTEGER];

    if (currentTotal < targetTotalDurationSec && scaledDurations[index] < maxDuration) {
      scaledDurations[index] += 1;
      currentTotal += 1;
    } else if (currentTotal > targetTotalDurationSec && scaledDurations[index] > minDuration) {
      scaledDurations[index] -= 1;
      currentTotal -= 1;
    }

    cursor += 1;
  }

  return scaledDurations;
}

function resolveShotTemplates(manifest: ThemeManifest): ThemeShotTemplate[] {
  const templates = manifest.shotTemplates && manifest.shotTemplates.length > 0 ? manifest.shotTemplates : fallbackShotTemplates(manifest);
  return templates.map((template, index) => ({
    ...template,
    id: template.id || `shot_${index + 1}`,
    targetDurationSec: Math.max(1, template.targetDurationSec)
  }));
}

function resolveTargetDurationSec(manifest: ThemeManifest, templates: ThemeShotTemplate[]): number {
  if (manifest.targetDurationSec) {
    return manifest.targetDurationSec;
  }

  const templateTotal = templates.reduce((sum, template) => sum + template.targetDurationSec, 0);
  return Math.max(manifest.durationMinSec, Math.min(manifest.durationMaxSec, templateTotal));
}

function narrationLineForIndex(args: {
  narrationIndex: number;
  totalNarrationShots: number;
  childName: string;
  themeName: string;
  keywords: string[];
}): string {
  if (args.narrationIndex === 0) {
    const keywordTail = args.keywords.length > 0 ? ` with ${args.keywords.slice(0, 2).join(' and ')}` : '';
    return `I stepped into ${args.themeName}${keywordTail}, and everything around me felt bigger than life.`;
  }

  if (args.narrationIndex === args.totalNarrationShots - 1) {
    return `When the adventure ended, ${args.childName} came home smiling with a story worth telling again.`;
  }

  return `Each new turn brought another surprise, and ${args.childName} kept moving forward with courage.`;
}

function dialogueLineForIndex(dialogueIndex: number, totalDialogueShots: number): string {
  if (dialogueIndex === 0) {
    return `I've got this. Let's go!`;
  }

  if (dialogueIndex === totalDialogueShots - 1) {
    return `That was amazing. I can't wait for my next adventure!`;
  }

  return `We're getting closer. I know we can do this!`;
}

export function compileCinematicShotPlan(input: CinematicPromptInput): ScriptPayload {
  const keywords = (input.keywords ?? []).map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0);
  const templates = resolveShotTemplates(input.manifest);
  const targetDurationSec = resolveTargetDurationSec(input.manifest, templates);
  const shotDurations = distributeDurations(templates, targetDurationSec);
  const narrationTemplates = templates.filter((template) => template.shotType === 'narration');
  const dialogueTemplates = templates.filter((template) => template.shotType === 'dialogue');

  let narrationCursor = 0;
  let dialogueCursor = 0;

  const shots = templates.map((template, index) => {
    const durationSec = shotDurations[index];
    const shotNumber = index + 1;
    const scene = template.preferredSceneId
      ? input.manifest.scenes.find((entry) => entry.id === template.preferredSceneId) ?? pickScene(input.manifest, index)
      : pickScene(input.manifest, index);
    const shotType = template.shotType;
    const camera = template.camera || scene.cameraPreset || cameraByShot[index] || cameraByShot[cameraByShot.length - 1];
    const lighting = template.lighting || scene.lightingPreset || lightingByShot[index] || lightingByShot[lightingByShot.length - 1];
    const environmentMotion = scene.environmentMotionDefaults.length
      ? scene.environmentMotionDefaults
      : ['volumetric fog', 'ambient particles'];

    const narration =
      shotType === 'narration'
        ? narrationLineForIndex({
            narrationIndex: narrationCursor++,
            totalNarrationShots: narrationTemplates.length,
            childName: input.childName,
            themeName: input.themeName,
            keywords
          })
        : '';
    const dialogue = shotType === 'dialogue' ? dialogueLineForIndex(dialogueCursor++, dialogueTemplates.length) : 'Narration only.';

    const action =
      shotType === 'narration'
        ? `Narrated cinematic beat in scene "${scene.name}" with ${camera} camera and ${lighting} lighting.`
        : `${input.childName} speaks on-screen in scene "${scene.name}" with ${camera} camera and ${lighting} lighting.`;

    const soundDesignCues =
      shotType === 'narration'
        ? ['ambient swell', 'whoosh transition']
        : ['dialogue focus', 'subtle riser'];

    const characterDirection: ScriptPayload['shots'][number]['characterDirection'] =
      shotType === 'dialogue'
        ? {
            presence: template.characterPresence ?? 'hero',
            emotion: template.emotion ?? (dialogueCursor === 1 ? 'confident' : 'joyful'),
            gesture: template.gesture ?? (dialogueCursor === 1 ? 'point_forward' : 'celebrate')
          }
        : {
            presence: template.characterPresence ?? 'offscreen',
            emotion: template.emotion ?? (narrationCursor === 1 ? 'wonder' : 'relief')
          };

    return {
      shotNumber,
      durationSec,
      shotType,
      sceneId: scene.id,
      sceneName: scene.name,
      camera,
      lighting,
      environmentMotion,
      soundDesignCues,
      action,
      dialogue,
      narration,
      onScreenSpeaking: template.onScreenSpeaking ?? shotType === 'dialogue',
      speakingDurationSec: shotType === 'dialogue' ? durationSec : 0,
      characterDirection,
      overrides: {
        environmentMotion,
        sfx: soundDesignCues
      }
    };
  });

  const narrationLines = shots.filter((shot) => shot.shotType === 'narration').map((shot) => shot.narration).filter(Boolean);

  return {
    title: `${input.childName}'s ${input.themeName} Adventure`,
    narration: narrationLines,
    totalDurationSec: shots.reduce((sum, shot) => sum + shot.durationSec, 0),
    version: 'v1-scaffold',
    themeId: input.manifest.scenes[0]?.id?.split('_').slice(0, -1).join('_') || undefined,
    speakingBudgetSec: shots.reduce((sum, shot) => sum + (shot.speakingDurationSec ?? 0), 0),
    finalMix: {
      musicDucking: true,
      subtitleStyle: 'cinematic_minimal',
      deliverables: ['1080p_mp4', 'thumbnail_jpg']
    },
    shots
  };
}

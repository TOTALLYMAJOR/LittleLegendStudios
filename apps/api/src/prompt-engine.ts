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
const fallbackEnvironmentMotion = ['volumetric fog', 'ambient particles'] as const;

type BeatStage =
  | 'opening'
  | 'inciting'
  | 'discovery'
  | 'promise'
  | 'rising'
  | 'midpoint'
  | 'climax'
  | 'ending';

interface ThemeVoiceProfile {
  atmospheres: string[];
  movement: string[];
  challenges: string[];
  resolveImage: string;
  celebrationLine: string;
}

const defaultThemeVoice: ThemeVoiceProfile = {
  atmospheres: ['luminous skies', 'cinematic light', 'storybook depth'],
  movement: ['glided', 'surged', 'pressed forward'],
  challenges: ['a sudden obstacle', 'a daring turn', 'an impossible moment'],
  resolveImage: 'a warm horizon opening wide',
  celebrationLine: 'We did it together.'
};

const themeVoiceProfiles: Array<{ matcher: RegExp; profile: ThemeVoiceProfile }> = [
  {
    matcher: /space|galactic|cosmic/i,
    profile: {
      atmospheres: ['nebula glow', 'starlit launch towers', 'zero-gravity trails'],
      movement: ['orbited', 'launched', 'cut through the stars'],
      challenges: ['a meteor surge', 'a gravity twist', 'a turbulent star corridor'],
      resolveImage: 'a bright homeward sky above the launch bay',
      celebrationLine: 'Mission complete. Stars and smiles everywhere.'
    }
  },
  {
    matcher: /fantasy|kingdom|castle|enchant/i,
    profile: {
      atmospheres: ['moonlit courtyards', 'lantern-lit forests', 'spellbound halls'],
      movement: ['swept', 'stepped boldly', 'crossed the realm'],
      challenges: ['a shifting spell gate', 'a shadowed passage', 'a royal trial'],
      resolveImage: 'a golden hall filled with lantern light',
      celebrationLine: 'The kingdom is safe, and our story shines.'
    }
  },
  {
    matcher: /underwater|ocean|reef|sea/i,
    profile: {
      atmospheres: ['bioluminescent reefs', 'pearl-lit arches', 'shimmering tides'],
      movement: ['drifted', 'sliced through the current', 'rode the tide'],
      challenges: ['a rushing current wall', 'a deepwater turn', 'a hidden trench route'],
      resolveImage: 'sunbeams breaking across calm water',
      celebrationLine: 'The tide carried us home in triumph.'
    }
  },
  {
    matcher: /superhero|hero|city|comic/i,
    profile: {
      atmospheres: ['neon skylines', 'high-rise wind tunnels', 'comic-scale glow'],
      movement: ['vaulted', 'accelerated', 'charged ahead'],
      challenges: ['a skyline crisis', 'a high-speed detour', 'a citywide surge'],
      resolveImage: 'a victory skyline at golden dusk',
      celebrationLine: 'City saved. Cape high and heart full.'
    }
  },
  {
    matcher: /dinosaur|prehistoric|jungle/i,
    profile: {
      atmospheres: ['fern-canopy light', 'volcanic horizons', 'amber jungle mist'],
      movement: ['tracked', 'rushed', 'navigated the wild'],
      challenges: ['a thunderous ground shake', 'a narrow cliff pass', 'a roaring showdown'],
      resolveImage: 'a sunset ridge above the jungle',
      celebrationLine: 'Adventure complete, with dino-sized courage.'
    }
  }
];

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

function normalizeLabel(label: string | undefined, fallback: string): string {
  return (label ?? fallback).trim().toLowerCase();
}

function resolveThemeVoice(themeName: string): ThemeVoiceProfile {
  const matched = themeVoiceProfiles.find((entry) => entry.matcher.test(themeName));
  return matched?.profile ?? defaultThemeVoice;
}

function sanitizeKeywords(keywords: string[] | undefined): string[] {
  if (!keywords || keywords.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const keyword of keywords) {
    const normalized = keyword.trim().replaceAll(/\s+/g, ' ');
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized.slice(0, 32));
    if (result.length >= 3) {
      break;
    }
  }

  return result;
}

function joinWithConjunction(parts: string[]): string {
  if (parts.length === 0) {
    return '';
  }

  if (parts.length === 1) {
    return parts[0];
  }

  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1]}`;
  }

  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function pickForIndex(values: string[], index: number): string {
  return values[index % values.length] ?? values[values.length - 1] ?? '';
}

function inferBeatStage(args: {
  label?: string;
  id: string;
  shotType: 'narration' | 'dialogue';
  index: number;
  totalShots: number;
}): BeatStage {
  const label = normalizeLabel(args.label, args.id);
  if (label.includes('opening') || label.includes('overture') || label.includes('intro')) {
    return 'opening';
  }

  if (label.includes('call') || label.includes('inciting')) {
    return 'inciting';
  }

  if (label.includes('discovery')) {
    return 'discovery';
  }

  if (label.includes('promise')) {
    return 'promise';
  }

  if (label.includes('rising')) {
    return 'rising';
  }

  if (label.includes('midpoint') || label.includes('turn')) {
    return 'midpoint';
  }

  if (label.includes('climax')) {
    return 'climax';
  }

  if (label.includes('ending') || label.includes('storybook') || label.includes('finale') || label.includes('resolve')) {
    return 'ending';
  }

  if (args.index === 0) {
    return args.shotType === 'dialogue' ? 'inciting' : 'opening';
  }

  if (args.index === args.totalShots - 1) {
    return 'ending';
  }

  const progress = args.index / Math.max(1, args.totalShots - 1);
  if (progress < 0.2) {
    return args.shotType === 'dialogue' ? 'inciting' : 'discovery';
  }
  if (progress < 0.45) {
    return args.shotType === 'dialogue' ? 'promise' : 'rising';
  }
  if (progress < 0.75) {
    return 'midpoint';
  }
  return 'climax';
}

function keywordClause(keywords: string[]): string {
  if (keywords.length === 0) {
    return '';
  }

  return ` with touches of ${joinWithConjunction(keywords)}`;
}

function narrationLineForBeat(args: {
  beat: BeatStage;
  childName: string;
  themeName: string;
  keywords: string[];
  sceneName: string;
  shotIndex: number;
  themeVoice: ThemeVoiceProfile;
}): string {
  const atmosphere = pickForIndex(args.themeVoice.atmospheres, args.shotIndex);
  const movementVerb = pickForIndex(args.themeVoice.movement, args.shotIndex);
  const challenge = pickForIndex(args.themeVoice.challenges, args.shotIndex);
  const keywordFlavor = keywordClause(args.keywords);

  switch (args.beat) {
    case 'opening':
      return `${args.childName} entered ${args.themeName}${keywordFlavor}, where ${atmosphere} made the first moment feel cinematic and brave.`;
    case 'inciting':
      return `A clear invitation to move forward echoed through ${args.sceneName}, and ${args.childName} answered without hesitation.`;
    case 'discovery':
      return `Inside ${args.sceneName}, ${args.childName} found a new wonder as the world ${movementVerb} around them.`;
    case 'promise':
      return `${args.childName} made a quiet promise to keep going, even as the path through ${args.themeName} grew bigger and brighter.`;
    case 'rising':
      return `Momentum built with every step; ${args.childName} ${movementVerb} through ${challenge} and stayed focused on the goal.`;
    case 'midpoint':
      return `A sudden turn changed the stakes, and ${args.childName} reset with courage, timing, and heart.`;
    case 'climax':
      return `At the peak of the adventure, ${args.childName} faced ${challenge} and transformed pressure into a heroic breakthrough.`;
    case 'ending':
      return `With the journey complete, ${args.childName} looked out at ${args.themeVoice.resolveImage}, carrying home a story worth replaying.`;
    default:
      return `${args.childName} kept moving with courage as the adventure unfolded beat by beat.`;
  }
}

function dialogueLineForBeat(args: {
  beat: BeatStage;
  themeVoice: ThemeVoiceProfile;
}): string {
  switch (args.beat) {
    case 'opening':
    case 'inciting':
      return `I'm ready. Let's go make this legendary.`;
    case 'discovery':
      return `Did you see that? This world is incredible.`;
    case 'promise':
      return `I promise I'll stay brave and keep moving forward.`;
    case 'rising':
      return `Stay with me. We're getting stronger every step.`;
    case 'midpoint':
      return `That twist was huge, but I'm still in this.`;
    case 'climax':
      return `This is our moment. We finish strong together.`;
    case 'ending':
      return `${args.themeVoice.celebrationLine} I can't wait for the next adventure.`;
    default:
      return `We can do this. Keep going with me.`;
  }
}

function soundDesignForBeat(beat: BeatStage, shotType: 'narration' | 'dialogue'): string[] {
  if (shotType === 'dialogue') {
    switch (beat) {
      case 'inciting':
      case 'opening':
        return ['hero_sting', 'dialogue_focus'];
      case 'promise':
        return ['resolve_pulse', 'dialogue_focus'];
      case 'midpoint':
        return ['surprise_hit', 'dialogue_focus'];
      case 'climax':
        return ['victory_swell', 'dialogue_focus'];
      case 'ending':
        return ['warm_resolve', 'dialogue_focus'];
      default:
        return ['dialogue_focus', 'subtle_riser'];
    }
  }

  switch (beat) {
    case 'opening':
      return ['orchestral_swell', 'whoosh_transition'];
    case 'discovery':
      return ['ambient_swell', 'sparkle_rise'];
    case 'rising':
      return ['momentum_pulse', 'whoosh_transition'];
    case 'midpoint':
      return ['dramatic_riser', 'transition_whoosh'];
    case 'climax':
      return ['cinematic_boom', 'triumph_rise'];
    case 'ending':
      return ['soft_resolve', 'gentle_chime'];
    default:
      return ['ambient_swell', 'whoosh_transition'];
  }
}

function actionLineForBeat(args: {
  beat: BeatStage;
  shotType: 'narration' | 'dialogue';
  label?: string;
  sceneName: string;
  camera: string;
  lighting: string;
  environmentMotion: string[];
  childName: string;
  characterEmotion?: string;
  gesture?: string;
}): string {
  const beatLabel = normalizeLabel(args.label, args.beat).replaceAll('_', ' ');
  const motionText = args.environmentMotion.join(', ') || 'ambient particles';

  if (args.shotType === 'dialogue') {
    const gestureText = args.gesture ? ` with a ${args.gesture} gesture` : '';
    const emotionText = args.characterEmotion ? `, emotion ${args.characterEmotion}` : '';
    return `Studio direction: ${args.childName} performs the ${beatLabel} beat on-screen in "${args.sceneName}" using ${args.camera} framing and ${args.lighting} lighting; environment motion ${motionText}${emotionText}${gestureText}.`;
  }

  const emotionText = args.characterEmotion ? ` and emotional tone ${args.characterEmotion}` : '';
  return `Studio direction: narrated ${beatLabel} beat in "${args.sceneName}" with ${args.camera} framing, ${args.lighting} lighting, and environment motion ${motionText}${emotionText}.`;
}

function defaultEmotionForBeat(beat: BeatStage, shotType: 'narration' | 'dialogue'): string {
  if (shotType === 'dialogue') {
    switch (beat) {
      case 'inciting':
      case 'opening':
        return 'curious';
      case 'promise':
      case 'rising':
        return 'confident';
      case 'midpoint':
        return 'determined';
      case 'climax':
        return 'heroic';
      case 'ending':
        return 'joyful';
      default:
        return 'confident';
    }
  }

  switch (beat) {
    case 'opening':
    case 'discovery':
      return 'wonder';
    case 'rising':
    case 'midpoint':
      return 'focus';
    case 'climax':
      return 'triumph';
    case 'ending':
      return 'relief';
    default:
      return 'warmth';
  }
}

function defaultExpressionForBeat(beat: BeatStage, shotType: 'narration' | 'dialogue'): string {
  if (shotType === 'dialogue') {
    switch (beat) {
      case 'inciting':
      case 'opening':
        return 'bright-eyed';
      case 'promise':
      case 'rising':
        return 'focused smile';
      case 'midpoint':
        return 'alert resolve';
      case 'climax':
        return 'full intensity';
      case 'ending':
        return 'proud joy';
      default:
        return 'focused';
    }
  }

  switch (beat) {
    case 'opening':
    case 'discovery':
      return 'wonder-struck';
    case 'midpoint':
      return 'steady resolve';
    case 'climax':
      return 'exultant';
    case 'ending':
      return 'gentle relief';
    default:
      return 'cinematic calm';
  }
}

function defaultGestureForBeat(beat: BeatStage): string {
  switch (beat) {
    case 'inciting':
      return 'look_up';
    case 'promise':
      return 'hand_to_heart';
    case 'midpoint':
      return 'reach_out';
    case 'climax':
      return 'point_forward';
    case 'ending':
      return 'celebrate';
    default:
      return 'open_arm';
  }
}

export function compileCinematicShotPlan(input: CinematicPromptInput): ScriptPayload {
  const keywords = sanitizeKeywords(input.keywords);
  const templates = resolveShotTemplates(input.manifest);
  const targetDurationSec = resolveTargetDurationSec(input.manifest, templates);
  const shotDurations = distributeDurations(templates, targetDurationSec);
  const themeVoice = resolveThemeVoice(input.themeName);

  const shots = templates.map((template, index) => {
    const durationSec = shotDurations[index];
    const shotNumber = index + 1;
    const scene = template.preferredSceneId
      ? input.manifest.scenes.find((entry) => entry.id === template.preferredSceneId) ?? pickScene(input.manifest, index)
      : pickScene(input.manifest, index);
    const shotType = template.shotType;
    const camera = template.camera || scene.cameraPreset || cameraByShot[index] || cameraByShot[cameraByShot.length - 1];
    const lighting = template.lighting || scene.lightingPreset || lightingByShot[index] || lightingByShot[lightingByShot.length - 1];
    const environmentMotion = scene.environmentMotionDefaults.length ? scene.environmentMotionDefaults : [...fallbackEnvironmentMotion];
    const beat = inferBeatStage({
      label: template.label,
      id: template.id,
      shotType,
      index,
      totalShots: templates.length
    });

    const narration =
      shotType === 'narration'
        ? narrationLineForBeat({
            beat,
            childName: input.childName,
            themeName: input.themeName,
            keywords,
            sceneName: scene.name,
            shotIndex: index,
            themeVoice
          })
        : '';
    const dialogue =
      shotType === 'dialogue'
        ? dialogueLineForBeat({ beat, themeVoice })
        : 'Narration only.';
    const emotion = template.emotion ?? defaultEmotionForBeat(beat, shotType);
    const gesture = template.gesture ?? (shotType === 'dialogue' ? defaultGestureForBeat(beat) : undefined);
    const expression = defaultExpressionForBeat(beat, shotType);
    const action = actionLineForBeat({
      beat,
      shotType,
      label: template.label,
      sceneName: scene.name,
      camera,
      lighting,
      environmentMotion,
      childName: input.childName,
      characterEmotion: emotion,
      gesture
    });
    const soundDesignCues = soundDesignForBeat(beat, shotType);

    const characterDirection: ScriptPayload['shots'][number]['characterDirection'] =
      shotType === 'dialogue'
        ? {
            presence: template.characterPresence ?? 'hero',
            emotion,
            expression,
            gesture
          }
        : {
            presence: template.characterPresence ?? 'offscreen',
            emotion,
            expression
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
    version: 'v3-studio-grade',
    themeId: input.manifest.scenes[0]?.id?.split('_').slice(0, -1).join('_') || undefined,
    speakingBudgetSec: shots.reduce((sum, shot) => sum + (shot.speakingDurationSec ?? 0), 0),
    finalMix: {
      musicDucking: true,
      subtitleStyle: 'luminous_story',
      deliverables: ['1080p_mp4', 'thumbnail_jpg']
    },
    shots
  };
}

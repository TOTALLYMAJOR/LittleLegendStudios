import { writeAssetBytes } from './asset-store.js';
import { query } from './db.js';

interface SeedTheme {
  slug: string;
  name: string;
  description: string;
  sceneNames: string[];
  manifest: {
    heroShotTemplates: number;
    environmentCount: number;
    style: string;
    sceneArchitecture: string;
    durationMinSec: number;
    durationMaxSec: number;
    palette?: string[];
    globalFx?: string[];
    defaultShotCount?: number;
    targetAspectRatio?: string;
    targetDurationSec?: number;
    shotTemplates?: Record<string, unknown>[];
    scenes: Record<string, unknown>[];
  };
}

interface PremiumShotTemplateBlueprint {
  id: string;
  shotType: 'narration' | 'dialogue';
  label: string;
  targetDurationSec: number;
  durationRangeSec: [number, number];
  sceneIndex: number;
  camera?: string;
  lighting?: string;
  characterPresence: 'offscreen' | 'hero';
  emotion?: string;
  gesture?: string;
  onScreenSpeaking?: boolean;
}

function sceneSlug(name: string): string {
  return name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_').replaceAll(/^_|_$/g, '');
}

function buildStubMp3Bytes(label: string): Buffer {
  return Buffer.from(`ID3LittleLegend:${label}`, 'utf8');
}

function assetDirectory(assetKey: string): string {
  const separatorIndex = assetKey.lastIndexOf('/');
  return separatorIndex >= 0 ? assetKey.slice(0, separatorIndex) : '';
}

function resolveSceneAudioAssetKey(scene: Record<string, unknown>, fileName: string): string | null {
  const assets = scene.assets;
  if (!assets || typeof assets !== 'object') {
    return null;
  }

  const bgLoop = (assets as Record<string, unknown>).bgLoop;
  if (typeof bgLoop !== 'string' || !bgLoop.trim()) {
    return null;
  }

  const baseDir = assetDirectory(bgLoop);
  if (!baseDir) {
    return null;
  }

  return `${baseDir}/${fileName}`;
}

async function materializeThemeAudioAssets(scenes: Record<string, unknown>[]): Promise<void> {
  const writes = new Map<string, Buffer>();

  for (const scene of scenes) {
    const sceneId = typeof scene.id === 'string' ? scene.id : 'scene';
    const soundBed = typeof scene.soundBed === 'string' ? scene.soundBed.trim() : '';
    if (soundBed) {
      const assetKey = resolveSceneAudioAssetKey(scene, soundBed);
      if (assetKey && !writes.has(assetKey)) {
        writes.set(assetKey, buildStubMp3Bytes(JSON.stringify({ kind: 'soundBed', sceneId, assetKey })));
      }
    }

    const audio = scene.audio;
    if (!audio || typeof audio !== 'object') {
      continue;
    }

    const audioRecord = audio as Record<string, unknown>;
    const musicBed = typeof audioRecord.musicBed === 'string' ? audioRecord.musicBed.trim() : '';
    if (musicBed) {
      const assetKey = resolveSceneAudioAssetKey(scene, musicBed);
      if (assetKey && !writes.has(assetKey)) {
        writes.set(assetKey, buildStubMp3Bytes(JSON.stringify({ kind: 'musicBed', sceneId, assetKey })));
      }
    }

    const sfx = Array.isArray(audioRecord.sfx) ? (audioRecord.sfx as unknown[]) : [];
    for (const sfxEntry of sfx) {
      if (typeof sfxEntry !== 'string' || !sfxEntry.trim()) {
        continue;
      }

      const assetKey = resolveSceneAudioAssetKey(scene, `${sfxEntry.trim()}.mp3`);
      if (assetKey && !writes.has(assetKey)) {
        writes.set(assetKey, buildStubMp3Bytes(JSON.stringify({ kind: 'sfx', sceneId, assetKey, cue: sfxEntry.trim() })));
      }
    }
  }

  await Promise.all(Array.from(writes.entries()).map(([assetKey, bytes]) => writeAssetBytes(assetKey, bytes)));
}

function buildSceneManifest(themeSlug: string, sceneNames: string[]): Record<string, unknown>[] {
  return sceneNames.map((sceneName, index) => {
    const id = `${themeSlug}_${sceneSlug(sceneName)}`;

    return {
      id,
      name: sceneName,
      cameraPreset: index === 0 ? 'wide_establishing_pan' : index % 2 === 0 ? 'tracking_push_in' : 'hero_low_angle',
      lightingPreset: index % 3 === 0 ? 'golden_hour_volumetric' : index % 3 === 1 ? 'cinematic_soft_fill' : 'contrast_rim',
      environmentMotionDefaults: [
        index % 2 === 0 ? 'ambient particles' : 'drifting mist',
        index % 3 === 0 ? 'slow cloud parallax' : 'subtle light flicker'
      ],
      soundBed: `${id}_ambience.mp3`,
      anchors: {
        child: {
          x: 0.5,
          y: 0.72,
          scale: 1
        }
      },
      assets: {
        bgLoop: `themes/${themeSlug}/${id}/bg_loop.mp4`,
        particlesOverlay: `themes/${themeSlug}/${id}/particles.mp4`,
        lut: `themes/${themeSlug}/${id}/lut.cube`,
        atmosphereOverlay: `themes/${themeSlug}/${id}/atmosphere.mp4`,
        foregroundOverlay: `themes/${themeSlug}/${id}/foreground.mp4`
      },
      palette: ['story_gold', 'midnight_blue', 'glow_cyan'],
      globalFx: ['ambient_particles', 'soft_bloom'],
      audio: {
        musicBed: `${id}_music.mp3`,
        sfx: ['whoosh_transition', 'ambient_wind']
      },
      cameraMove: index % 2 === 0 ? 'slow_push_in' : 'hero_pan',
      parallaxStrength: index === 0 ? 0.65 : 0.8,
      grade: {
        lut: `themes/${themeSlug}/${id}/lut.cube`,
        intensity: 0.85
      }
    };
  });
}

function buildPremiumShotTemplates(themeSlug: string, sceneNames: string[]): Record<string, unknown>[] {
  const blueprints: PremiumShotTemplateBlueprint[] = [
    {
      id: 'opening_overture',
      shotType: 'narration',
      label: 'Opening Overture',
      targetDurationSec: 8,
      durationRangeSec: [7, 10],
      sceneIndex: 0,
      camera: 'wide_establishing_pan',
      lighting: 'golden_hour_volumetric',
      characterPresence: 'offscreen',
      emotion: 'wonder'
    },
    {
      id: 'call_to_action',
      shotType: 'dialogue',
      label: 'Call To Action',
      targetDurationSec: 7,
      durationRangeSec: [6, 9],
      sceneIndex: 1,
      camera: 'hero_low_angle',
      lighting: 'cinematic_soft_fill',
      characterPresence: 'hero',
      emotion: 'curious',
      gesture: 'look_up',
      onScreenSpeaking: true
    },
    {
      id: 'first_discovery',
      shotType: 'narration',
      label: 'First Discovery',
      targetDurationSec: 9,
      durationRangeSec: [8, 11],
      sceneIndex: 2,
      camera: 'tracking_push_in',
      lighting: 'contrast_rim',
      characterPresence: 'offscreen',
      emotion: 'delight'
    },
    {
      id: 'hero_promise',
      shotType: 'dialogue',
      label: 'Hero Promise',
      targetDurationSec: 8,
      durationRangeSec: [7, 10],
      sceneIndex: 3,
      camera: 'hero_low_angle_push',
      lighting: 'hero_key_fill',
      characterPresence: 'hero',
      emotion: 'confident',
      gesture: 'point_forward',
      onScreenSpeaking: true
    },
    {
      id: 'rising_adventure',
      shotType: 'narration',
      label: 'Rising Adventure',
      targetDurationSec: 10,
      durationRangeSec: [8, 12],
      sceneIndex: 5,
      camera: 'tracking_action_orbit',
      lighting: 'cinematic_contrast',
      characterPresence: 'offscreen',
      emotion: 'courage'
    },
    {
      id: 'midpoint_turn',
      shotType: 'dialogue',
      label: 'Midpoint Turn',
      targetDurationSec: 8,
      durationRangeSec: [7, 10],
      sceneIndex: 6,
      camera: 'medium_tracking_closeup',
      lighting: 'contrast_rim',
      characterPresence: 'hero',
      emotion: 'surprised',
      gesture: 'reach_out',
      onScreenSpeaking: true
    },
    {
      id: 'grand_climax',
      shotType: 'narration',
      label: 'Grand Climax',
      targetDurationSec: 12,
      durationRangeSec: [10, 14],
      sceneIndex: 8,
      camera: 'spiral_orbit_reveal',
      lighting: 'warm_emotional_glow',
      characterPresence: 'offscreen',
      emotion: 'triumph'
    },
    {
      id: 'storybook_ending',
      shotType: 'dialogue',
      label: 'Storybook Ending',
      targetDurationSec: 10,
      durationRangeSec: [8, 12],
      sceneIndex: 9,
      camera: 'emotional_pullback',
      lighting: 'warm_emotional_glow',
      characterPresence: 'hero',
      emotion: 'joyful',
      gesture: 'celebrate',
      onScreenSpeaking: true
    }
  ];

  return blueprints.map((blueprint) => ({
    id: blueprint.id,
    shotType: blueprint.shotType,
    label: blueprint.label,
    targetDurationSec: blueprint.targetDurationSec,
    durationRangeSec: blueprint.durationRangeSec,
    preferredSceneId: `${themeSlug}_${sceneSlug(sceneNames[blueprint.sceneIndex] ?? sceneNames[0] ?? 'scene')}`,
    ...(blueprint.camera ? { camera: blueprint.camera } : {}),
    ...(blueprint.lighting ? { lighting: blueprint.lighting } : {}),
    characterPresence: blueprint.characterPresence,
    ...(blueprint.emotion ? { emotion: blueprint.emotion } : {}),
    ...(blueprint.gesture ? { gesture: blueprint.gesture } : {}),
    ...(blueprint.onScreenSpeaking !== undefined ? { onScreenSpeaking: blueprint.onScreenSpeaking } : {})
  }));
}

const defaultThemes = [
  {
    slug: 'space-adventure',
    name: 'Space Adventure',
    description: 'Alien planets, nebula skies, and cinematic rocket launch pads.',
    sceneNames: [
      'Alien Planet Intro',
      'Rocket Launchpad',
      'Nebula Ridge',
      'Asteroid Drift',
      'Starlight Canyon',
      'Orbital Bridge',
      'Crystal Moonbase',
      'Comet Trail Run',
      'Zero G Dome',
      'Homeward Sky'
    ],
    manifest: {
      heroShotTemplates: 8,
      environmentCount: 10,
      style: 'cinematic-stylized',
      sceneArchitecture: '2.5d-parallax',
      durationMinSec: 64,
      durationMaxSec: 84,
      palette: ['nebula_purple', 'crystal_blue', 'sun_gold'],
      globalFx: ['dust_particles', 'soft_bloom'],
      defaultShotCount: 8,
      targetAspectRatio: '16:9',
      targetDurationSec: 72,
      shotTemplates: buildPremiumShotTemplates('space-adventure', [
        'Alien Planet Intro',
        'Rocket Launchpad',
        'Nebula Ridge',
        'Asteroid Drift',
        'Starlight Canyon',
        'Orbital Bridge',
        'Crystal Moonbase',
        'Comet Trail Run',
        'Zero G Dome',
        'Homeward Sky'
      ]),
      scenes: []
    }
  },
  {
    slug: 'dinosaur-explorer',
    name: 'Dinosaur Explorer',
    description: 'Prehistoric jungles, volcano horizons, and roaming dinosaurs.',
    sceneNames: [
      'Jungle Gate',
      'Fern Valley',
      'Volcano Rim',
      'River Crossing',
      'Amber Cave',
      'Dino Footpath',
      'Rainforest Canopy',
      'Lava Glow Plains',
      'Stone Arch Pass',
      'Sunset Roar Ridge'
    ],
    manifest: {
      heroShotTemplates: 8,
      environmentCount: 10,
      style: 'cinematic-stylized',
      sceneArchitecture: '2.5d-parallax',
      durationMinSec: 64,
      durationMaxSec: 84,
      palette: ['jungle_green', 'amber_sunlight', 'volcanic_orange'],
      globalFx: ['drifting_mist', 'pollen_particles'],
      defaultShotCount: 8,
      targetAspectRatio: '16:9',
      targetDurationSec: 72,
      shotTemplates: buildPremiumShotTemplates('dinosaur-explorer', [
        'Jungle Gate',
        'Fern Valley',
        'Volcano Rim',
        'River Crossing',
        'Amber Cave',
        'Dino Footpath',
        'Rainforest Canopy',
        'Lava Glow Plains',
        'Stone Arch Pass',
        'Sunset Roar Ridge'
      ]),
      scenes: []
    }
  },
  {
    slug: 'superhero-city',
    name: 'Superhero City',
    description: 'Comic-inspired metropolis action with skyline flyovers.',
    sceneNames: [
      'City Skyline Dawn',
      'Rooftop Sprint',
      'Neon Avenue',
      'Skybridge Leap',
      'Power Core Plaza',
      'Subway Wind Tunnel',
      'Hero Tower',
      'Downtown Rescue',
      'Rainlit Crosswalk',
      'Victory Overlook'
    ],
    manifest: {
      heroShotTemplates: 8,
      environmentCount: 10,
      style: 'cinematic-stylized',
      sceneArchitecture: '2.5d-parallax',
      durationMinSec: 64,
      durationMaxSec: 84,
      palette: ['hero_red', 'electric_blue', 'chrome_silver'],
      globalFx: ['energy_trails', 'light_flares'],
      defaultShotCount: 8,
      targetAspectRatio: '16:9',
      targetDurationSec: 72,
      shotTemplates: buildPremiumShotTemplates('superhero-city', [
        'City Skyline Dawn',
        'Rooftop Sprint',
        'Neon Avenue',
        'Skybridge Leap',
        'Power Core Plaza',
        'Subway Wind Tunnel',
        'Hero Tower',
        'Downtown Rescue',
        'Rainlit Crosswalk',
        'Victory Overlook'
      ]),
      scenes: []
    }
  },
  {
    slug: 'underwater-kingdom',
    name: 'Underwater Kingdom',
    description: 'Coral cities, glowing sea life, and sunken ruins.',
    sceneNames: [
      'Coral Gate',
      'Lantern Reef',
      'Sunken Archway',
      'Pearl Garden',
      'Whale Song Trench',
      'Kelp Cathedral',
      'Crystal Tide Hall',
      'Current Tunnel',
      'Sea Crown Court',
      'Surface Light Return'
    ],
    manifest: {
      heroShotTemplates: 8,
      environmentCount: 10,
      style: 'cinematic-stylized',
      sceneArchitecture: '2.5d-parallax',
      durationMinSec: 64,
      durationMaxSec: 84,
      palette: ['aqua_blue', 'coral_pink', 'gold_rays'],
      globalFx: ['bubbles', 'caustic_light'],
      defaultShotCount: 8,
      targetAspectRatio: '16:9',
      targetDurationSec: 72,
      shotTemplates: buildPremiumShotTemplates('underwater-kingdom', [
        'Coral Gate',
        'Lantern Reef',
        'Sunken Archway',
        'Pearl Garden',
        'Whale Song Trench',
        'Kelp Cathedral',
        'Crystal Tide Hall',
        'Current Tunnel',
        'Sea Crown Court',
        'Surface Light Return'
      ]),
      scenes: []
    }
  },
  {
    slug: 'fantasy-kingdom',
    name: 'Fantasy Kingdom',
    description: 'Cinematic castles, enchanted forests, and magical creatures.',
    sceneNames: [
      'Castle Courtyard',
      'Enchanted Grove',
      'Crystal Bridge',
      'Dragon Watch Hill',
      'Moonlit Keep',
      'Rune Library',
      'Whispering Woods',
      'Starfall Meadow',
      'Royal Great Hall',
      'Lantern Road Home'
    ],
    manifest: {
      heroShotTemplates: 8,
      environmentCount: 10,
      style: 'cinematic-stylized',
      sceneArchitecture: '2.5d-parallax',
      durationMinSec: 64,
      durationMaxSec: 84,
      palette: ['emerald_green', 'warm_gold', 'lavender_sky'],
      globalFx: ['fireflies', 'volumetric_haze'],
      defaultShotCount: 8,
      targetAspectRatio: '16:9',
      targetDurationSec: 72,
      shotTemplates: buildPremiumShotTemplates('fantasy-kingdom', [
        'Castle Courtyard',
        'Enchanted Grove',
        'Crystal Bridge',
        'Dragon Watch Hill',
        'Moonlit Keep',
        'Rune Library',
        'Whispering Woods',
        'Starfall Meadow',
        'Royal Great Hall',
        'Lantern Road Home'
      ]),
      scenes: []
    }
  }
] satisfies SeedTheme[];

export async function seedThemes(): Promise<void> {
  const activeSlugs = defaultThemes.map((theme) => theme.slug);
  await query('UPDATE themes SET is_active = false WHERE NOT (slug = ANY($1::text[]))', [activeSlugs]);

  for (const theme of defaultThemes) {
    const scenes = buildSceneManifest(theme.slug, theme.sceneNames);
    await materializeThemeAudioAssets(scenes);

    await query(
      `
      INSERT INTO themes (
        slug,
        name,
        description,
        duration_min_sec,
        duration_max_sec,
        template_manifest_json,
        is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, true)
      ON CONFLICT (slug)
      DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        duration_min_sec = EXCLUDED.duration_min_sec,
        duration_max_sec = EXCLUDED.duration_max_sec,
        template_manifest_json = EXCLUDED.template_manifest_json,
        is_active = true
      `,
      [
        theme.slug,
        theme.name,
        theme.description,
        theme.manifest.durationMinSec,
        theme.manifest.durationMaxSec,
        JSON.stringify({
          ...theme.manifest,
          scenes
        })
      ]
    );
  }
}

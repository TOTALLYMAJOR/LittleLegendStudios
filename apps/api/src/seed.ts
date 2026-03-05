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
    scenes: Record<string, unknown>[];
  };
}

function sceneSlug(name: string): string {
  return name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_').replaceAll(/^_|_$/g, '');
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
        lut: `themes/${themeSlug}/${id}/lut.cube`
      }
    };
  });
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
      heroShotTemplates: 4,
      environmentCount: 10,
      style: 'cinematic-stylized',
      sceneArchitecture: '2.5d-parallax',
      durationMinSec: 20,
      durationMaxSec: 40,
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
      heroShotTemplates: 4,
      environmentCount: 10,
      style: 'cinematic-stylized',
      sceneArchitecture: '2.5d-parallax',
      durationMinSec: 20,
      durationMaxSec: 40,
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
      heroShotTemplates: 4,
      environmentCount: 10,
      style: 'cinematic-stylized',
      sceneArchitecture: '2.5d-parallax',
      durationMinSec: 20,
      durationMaxSec: 40,
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
      heroShotTemplates: 4,
      environmentCount: 10,
      style: 'cinematic-stylized',
      sceneArchitecture: '2.5d-parallax',
      durationMinSec: 20,
      durationMaxSec: 40,
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
      heroShotTemplates: 4,
      environmentCount: 10,
      style: 'cinematic-stylized',
      sceneArchitecture: '2.5d-parallax',
      durationMinSec: 20,
      durationMaxSec: 40,
      scenes: []
    }
  }
] satisfies SeedTheme[];

export async function seedThemes(): Promise<void> {
  const activeSlugs = defaultThemes.map((theme) => theme.slug);
  await query('UPDATE themes SET is_active = false WHERE NOT (slug = ANY($1::text[]))', [activeSlugs]);

  for (const theme of defaultThemes) {
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
        20,
        40,
        JSON.stringify({
          ...theme.manifest,
          scenes: buildSceneManifest(theme.slug, theme.sceneNames)
        })
      ]
    );
  }
}

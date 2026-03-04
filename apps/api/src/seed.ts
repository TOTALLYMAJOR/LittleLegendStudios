import { query } from './db.js';

const defaultThemes = [
  {
    slug: 'sky-pirates',
    name: 'Sky Pirates',
    description: 'A high-flying airship quest through golden clouds.',
    manifest: {
      shots: 3,
      palette: 'sunset-brass',
      durationMinSec: 20,
      durationMaxSec: 40
    }
  },
  {
    slug: 'moon-forest',
    name: 'Moon Forest',
    description: 'A glowing forest at night with magical creatures.',
    manifest: {
      shots: 3,
      palette: 'teal-silver',
      durationMinSec: 20,
      durationMaxSec: 40
    }
  },
  {
    slug: 'starlight-racers',
    name: 'Starlight Racers',
    description: 'A neon race through cosmic city bridges.',
    manifest: {
      shots: 3,
      palette: 'neon-blue',
      durationMinSec: 20,
      durationMaxSec: 40
    }
  },
  {
    slug: 'castle-of-winds',
    name: 'Castle of Winds',
    description: 'A cinematic royal quest in floating castles.',
    manifest: {
      shots: 3,
      palette: 'ivory-cyan',
      durationMinSec: 20,
      durationMaxSec: 40
    }
  },
  {
    slug: 'ocean-lanterns',
    name: 'Ocean Lanterns',
    description: 'A deep-sea journey with luminous sea lanterns.',
    manifest: {
      shots: 3,
      palette: 'aqua-gold',
      durationMinSec: 20,
      durationMaxSec: 40
    }
  }
];

export async function seedThemes(): Promise<void> {
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
        JSON.stringify(theme.manifest)
      ]
    );
  }
}

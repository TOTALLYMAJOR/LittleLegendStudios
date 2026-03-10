export interface ThemePreviewClip {
  src: string;
  startSec: number;
  durationSec: number;
}

export const THEME_PREVIEW_DURATION_SEC = 3;

const themePreviewClipList: Array<{
  matchers: string[];
  clip: ThemePreviewClip;
}> = [
  {
    matchers: ['space adventure', 'space'],
    clip: {
      src: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
      startSec: 0.2,
      durationSec: THEME_PREVIEW_DURATION_SEC
    }
  },
  {
    matchers: ['fantasy kingdom', 'fantasy'],
    clip: {
      src: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
      startSec: 0.4,
      durationSec: THEME_PREVIEW_DURATION_SEC
    }
  },
  {
    matchers: ['underwater kingdom', 'underwater', 'ocean', 'sea'],
    clip: {
      src: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4',
      startSec: 0.15,
      durationSec: THEME_PREVIEW_DURATION_SEC
    }
  },
  {
    matchers: ['superhero city', 'superhero', 'hero'],
    clip: {
      src: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
      startSec: 0.45,
      durationSec: THEME_PREVIEW_DURATION_SEC
    }
  }
];

const fallbackThemePreviewClip: ThemePreviewClip = {
  src: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
  startSec: 0.2,
  durationSec: THEME_PREVIEW_DURATION_SEC
};

export function resolveThemePreviewClip(themeNameOrSlug: string): ThemePreviewClip {
  const normalized = themeNameOrSlug.trim().toLowerCase();
  if (!normalized) {
    return fallbackThemePreviewClip;
  }

  const matched = themePreviewClipList.find((entry) => entry.matchers.some((matcher) => normalized.includes(matcher)));
  return matched?.clip ?? fallbackThemePreviewClip;
}

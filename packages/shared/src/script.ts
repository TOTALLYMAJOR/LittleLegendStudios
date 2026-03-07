import type { ThemeSceneAnchorMap, ThemeSceneAssets, ThemeSceneAudioBed, ThemeSceneGrade } from './theme.js';

export interface CharacterDirection {
  presence: 'offscreen' | 'hero' | 'supporting' | 'cameo';
  emotion?: string;
  expression?: string;
  gesture?: string;
}

export interface ShotCompanion {
  type: 'pet' | 'family';
  companionId: string;
  presence: 'cameo' | 'supporting' | 'hero';
}

export interface ShotOverrides {
  sfx?: string[];
  environmentMotion?: string[];
}

export interface ShotLine {
  shotNumber: number;
  durationSec: number;
  shotType: 'narration' | 'dialogue';
  sceneId: string;
  sceneName?: string;
  camera: string;
  lighting: string;
  environmentMotion: string[];
  soundDesignCues: string[];
  action: string;
  dialogue: string;
  narration: string;
  onScreenSpeaking?: boolean;
  speakingDurationSec?: number;
  characterDirection?: CharacterDirection;
  companions?: ShotCompanion[];
  overrides?: ShotOverrides;
}

export interface SceneRenderSpec {
  shotNumber: number;
  sceneId: string;
  sceneName: string;
  sceneArchitecture: string;
  camera: string;
  lighting: string;
  environmentMotion: string[];
  soundBed: string;
  assets: ThemeSceneAssets;
  anchors: ThemeSceneAnchorMap;
  palette: string[];
  globalFx: string[];
  audio: ThemeSceneAudioBed;
  cameraMove?: string;
  parallaxStrength?: number;
  grade: ThemeSceneGrade;
  modelProfile: {
    avatarModel: string;
    compositorModel: string;
  };
}

export interface FinalMixPlan {
  musicDucking?: boolean;
  subtitleStyle?: string;
  deliverables?: string[];
}

export interface ScriptPayload {
  title: string;
  narration: string[];
  totalDurationSec: number;
  version?: string;
  themeId?: string;
  speakingBudgetSec?: number;
  finalMix?: FinalMixPlan;
  shots: ShotLine[];
}

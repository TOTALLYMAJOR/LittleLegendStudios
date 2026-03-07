export interface ThemeAnchorTarget {
  x: number;
  y: number;
  scale: number;
}

export interface ThemeSceneAnchorMap {
  child: ThemeAnchorTarget;
  petOptional?: ThemeAnchorTarget;
  familyOptional?: ThemeAnchorTarget;
}

export interface ThemeSceneAssets {
  bgLoop: string;
  particlesOverlay: string;
  lut: string;
  atmosphereOverlay?: string | null;
  foregroundOverlay?: string | null;
  depthMap?: string | null;
}

export interface ThemeSceneAudioBed {
  musicBed?: string | null;
  sfx?: string[];
}

export interface ThemeSceneGrade {
  lut: string;
  intensity?: number;
}

export interface ThemeShotTemplate {
  id: string;
  shotType: 'narration' | 'dialogue';
  label?: string;
  targetDurationSec: number;
  durationRangeSec?: [number, number];
  preferredSceneId?: string;
  camera?: string;
  lighting?: string;
  characterPresence?: 'offscreen' | 'hero' | 'supporting' | 'cameo';
  emotion?: string;
  gesture?: string;
  onScreenSpeaking?: boolean;
}

export interface ThemeScene {
  id: string;
  name: string;
  cameraPreset: string;
  lightingPreset: string;
  environmentMotionDefaults: string[];
  soundBed: string;
  anchors: ThemeSceneAnchorMap;
  assets: ThemeSceneAssets;
  palette?: string[];
  globalFx?: string[];
  audio?: ThemeSceneAudioBed;
  cameraMove?: string;
  parallaxStrength?: number;
  grade?: ThemeSceneGrade;
}

export interface ThemeManifest {
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
  shotTemplates?: ThemeShotTemplate[];
  scenes: ThemeScene[];
}

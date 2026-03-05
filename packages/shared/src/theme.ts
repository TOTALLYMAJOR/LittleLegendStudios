export interface ThemeSceneAnchor {
  child: {
    x: number;
    y: number;
    scale: number;
  };
}

export interface ThemeScene {
  id: string;
  name: string;
  cameraPreset: string;
  lightingPreset: string;
  environmentMotionDefaults: string[];
  soundBed: string;
  anchors: ThemeSceneAnchor;
  assets: {
    bgLoop: string;
    particlesOverlay: string;
    lut: string;
  };
}

export interface ThemeManifest {
  heroShotTemplates: number;
  environmentCount: number;
  style: string;
  sceneArchitecture: string;
  durationMinSec: number;
  durationMaxSec: number;
  scenes: ThemeScene[];
}


export interface ShotLine {
  shotNumber: number;
  durationSec: number;
  shotType: 'narration' | 'dialogue';
  sceneId: string;
  camera: string;
  lighting: string;
  environmentMotion: string[];
  soundDesignCues: string[];
  action: string;
  dialogue: string;
  narration: string;
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
  assets: {
    bgLoop: string;
    particlesOverlay: string;
    lut: string;
  };
  anchors: {
    child: {
      x: number;
      y: number;
      scale: number;
    };
  };
  modelProfile: {
    avatarModel: string;
    compositorModel: string;
  };
}

export interface ScriptPayload {
  title: string;
  narration: string[];
  totalDurationSec: number;
  shots: ShotLine[];
}

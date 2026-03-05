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

export interface ScriptPayload {
  title: string;
  narration: string[];
  totalDurationSec: number;
  shots: ShotLine[];
}

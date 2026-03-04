export interface ShotLine {
  shotNumber: number;
  durationSec: number;
  action: string;
  dialogue: string;
}

export interface ScriptPayload {
  title: string;
  narration: string[];
  shots: ShotLine[];
}

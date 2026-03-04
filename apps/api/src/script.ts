import type { ScriptPayload } from '@little/shared';

interface ScriptInput {
  childName: string;
  themeName: string;
}

export function generateScript({ childName, themeName }: ScriptInput): ScriptPayload {
  return {
    title: `${childName}'s ${themeName} Adventure`,
    narration: [
      `${childName} steps into the ${themeName} world with courage and wonder.`,
      `Every glowing path reveals a new challenge and a little laugh.`,
      `${childName} returns home proud, with a story to tell forever.`
    ],
    shots: [
      {
        shotNumber: 1,
        durationSec: 10,
        action: `Cinematic reveal of ${childName} entering the world`,
        dialogue: `Wow... this place is amazing!`
      },
      {
        shotNumber: 2,
        durationSec: 12,
        action: `${childName} faces a playful obstacle with confidence`,
        dialogue: `I can do this. Let's go!`
      },
      {
        shotNumber: 3,
        durationSec: 10,
        action: `${childName} celebrates and waves as camera pulls back`,
        dialogue: `Best adventure ever!`
      }
    ]
  };
}

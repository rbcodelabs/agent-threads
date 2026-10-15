/**
 * Narration cues: an action can carry `cue: "some phrase"` and the recorder
 * fires it when the voice reaches that phrase, using the character timings
 * ElevenLabs returns alongside the audio.
 */
export interface Alignment {
  characters: string[];
  startsSec: number[];
  endsSec: number[];
}

/** Milliseconds into the narration audio at which `phrase` starts being spoken. */
export function cueTimeMs(alignment: Alignment, phrase: string): number {
  const text = alignment.characters.join("").toLowerCase();
  const index = text.indexOf(phrase.toLowerCase());
  if (index < 0) throw new Error(`cue "${phrase}" not found in the narration`);
  return Math.round(alignment.startsSec[index] * 1000);
}

/** Collapse an ElevenLabs `alignment` payload to the fields the recorder needs. */
export function parseAlignment(raw: unknown): Alignment {
  const a = raw as { characters?: string[]; character_start_times_seconds?: number[]; character_end_times_seconds?: number[] } | null;
  if (!a?.characters || !a.character_start_times_seconds || !a.character_end_times_seconds) {
    throw new Error("ElevenLabs response had no character alignment");
  }
  return { characters: a.characters, startsSec: a.character_start_times_seconds, endsSec: a.character_end_times_seconds };
}

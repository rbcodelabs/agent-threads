/**
 * Narration audio cache. The key covers everything that changes the audio, so
 * editing one line of narration regenerates only that line, and switching the
 * voice or model regenerates everything.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";

export interface VoiceSettings {
  modelId: string;
  stability: number;
  similarityBoost: number;
  style: number;
}

export interface SpeechRequest {
  text: string;
  voiceId: string;
  settings: VoiceSettings;
}

/** Whitespace-only edits must not invalidate a cached take. */
export function normalizeNarration(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function cacheKey(request: SpeechRequest): string {
  // Explicit field order: JSON.stringify of a spread object would depend on caller key order.
  const canonical = JSON.stringify([
    1,
    normalizeNarration(request.text),
    request.voiceId,
    request.settings.modelId,
    request.settings.stability,
    request.settings.similarityBoost,
    request.settings.style,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function cachePath(cacheDir: string, key: string): string {
  return path.join(cacheDir, `${key}.mp3`);
}

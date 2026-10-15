/**
 * Narration step: one ElevenLabs text-to-speech call per scene, cached by a
 * hash of text + voice + model settings so edits only regenerate changed lines.
 *
 *   node demo/engine/voiceover.mts [--dry-run] [--force]
 *
 * The API key is read from ELEVENLABS_API_KEY and is never printed or written.
 */
import * as fs from "node:fs";
import { cacheKey, cachePath, normalizeNarration, type VoiceSettings } from "./lib/cache.mts";
import { parseAlignment, type Alignment } from "./lib/cues.mts";
import { cacheDir, outDir, configPath, voiceoverManifestPath } from "./lib/paths.mts";
import { runFfmpeg } from "./lib/ffmpeg.mts";
import { loadScript } from "./lib/script.mts";
import { estimateNarrationMs } from "./lib/timing.mts";

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const API = "https://api.elevenlabs.io/v1";

async function synthesize(text: string, voiceId: string, settings: VoiceSettings, apiKey: string): Promise<{ audio: Buffer; alignment: Alignment }> {
  // with-timestamps returns the audio as base64 plus per-character timings, which the recorder uses to cue actions.
  const url = `${API}/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: settings.modelId,
      voice_settings: { stability: settings.stability, similarity_boost: settings.similarityBoost, style: settings.style },
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`ElevenLabs returned ${response.status} ${response.statusText}: ${detail}`);
  }
  const body = (await response.json()) as { audio_base64: string; alignment: unknown };
  return { audio: Buffer.from(body.audio_base64, "base64"), alignment: parseAlignment(body.alignment) };
}

/**
 * provider "none": a silent track timed like speech (150 words a minute), with character
 * timings spread evenly across it. Cues still work, so a silent demo (captions added later,
 * or music over the top) paces exactly like a narrated one.
 */
async function silentTrack(text: string, file: string): Promise<{ audio: Buffer; alignment: Alignment }> {
  const ms = estimateNarrationMs(text);
  await runFfmpeg(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", (ms / 1000).toFixed(3), "-c:a", "libmp3lame", file], "silent track");
  const characters = Array.from(text);
  const per = ms / 1000 / Math.max(1, characters.length);
  return {
    audio: fs.readFileSync(file),
    alignment: { characters, startsSec: characters.map((_, i) => i * per), endsSec: characters.map((_, i) => (i + 1) * per) },
  };
}

async function main(): Promise<void> {
  const script = loadScript(configPath);
  const silent = (script.voice.provider ?? "elevenlabs") === "none";
  const voiceId = silent ? "silent" : (process.env.ELEVENLABS_VOICE_ID ?? "");
  const apiKey = process.env.ELEVENLABS_API_KEY ?? "";
  if (!voiceId) throw new Error("ELEVENLABS_VOICE_ID is not set. Run `node demo/engine/voices.mts` to list voices, then export the id you want.");
  if (!apiKey && !silent && !DRY_RUN) throw new Error("ELEVENLABS_API_KEY is not set.");

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const settings: VoiceSettings = {
    modelId: script.voice.modelId ?? "silent",
    stability: script.voice.stability ?? 0,
    similarityBoost: script.voice.similarityBoost ?? 0,
    style: script.voice.style ?? 0,
  };
  const manifest: { voiceId: string; settings: VoiceSettings; scenes: { id: string; key: string; file: string; alignFile: string }[] } = { voiceId, settings, scenes: [] };

  let generated = 0;
  let reused = 0;
  for (const scene of script.scenes) {
    const key = cacheKey({ text: scene.narration, voiceId, settings });
    const file = cachePath(cacheDir, key);
    const alignFile = file.replace(/\.mp3$/, ".align.json");
    const cached = fs.existsSync(file) && fs.statSync(file).size > 0 && fs.existsSync(alignFile);
    manifest.scenes.push({ id: scene.id, key, file, alignFile });
    if (cached && !FORCE) {
      reused++;
      console.log(`  cached     ${scene.id.padEnd(16)} ${key}`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  would call ${scene.id.padEnd(16)} ${key}`);
      continue;
    }
    const { audio, alignment } = silent
      ? await silentTrack(normalizeNarration(scene.narration), file)
      : await synthesize(normalizeNarration(scene.narration), voiceId, settings, apiKey);
    fs.writeFileSync(file, audio);
    fs.writeFileSync(alignFile, JSON.stringify(alignment));
    generated++;
    console.log(`  generated  ${scene.id.padEnd(16)} ${key} (${(audio.length / 1024).toFixed(0)} KiB)`);
  }

  if (DRY_RUN) {
    console.log("dry run: no API calls made, manifest not written");
    return;
  }
  fs.writeFileSync(voiceoverManifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`voiceover: ${generated} generated, ${reused} reused -> ${voiceoverManifestPath}`);
}

main().catch((err) => {
  console.error(`voiceover failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

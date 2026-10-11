/**
 * Sync report: for every cued action, prints when it should land in the finished video
 * and writes a filmstrip of frames around that moment, so you can confirm the on-screen
 * event happens when the narration says its phrase. Review the strips (a person or an
 * agent that can read images); the compose table alone only proves total lengths match.
 *
 *   node demo/engine/sync-report.mts
 *
 * Output: demo/out/sync/<scene>-<n>.png. Each strip has 6 frames at -0.6, -0.3, 0, +0.3,
 * +0.6 and +0.9 seconds around the cue. The event should be visible by the third frame
 * and absent from the first. Tolerance for a convincing demo is about 0.3 s.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { cachePath } from "./lib/cache.mts";
import { cueTimeMs, type Alignment } from "./lib/cues.mts";
import { runFfmpeg, mediaDurationMs } from "./lib/ffmpeg.mts";
import { cacheDir, finalVideoPathFor, configPath, outDir, timelinePath, voiceoverManifestPath } from "./lib/paths.mts";
import { loadScript } from "./lib/script.mts";
import { buildOutputTimeline, formatClock } from "./lib/timing.mts";

async function main(): Promise<void> {
  const script = loadScript(configPath);
  const video = finalVideoPathFor(script.title);
  for (const file of [video, timelinePath, voiceoverManifestPath]) {
    if (!fs.existsSync(file)) throw new Error(`missing ${file}. Run the record and compose steps first.`);
  }
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as { scenes: { id: string; startMs: number; endMs: number }[] };
  const manifest = JSON.parse(fs.readFileSync(voiceoverManifestPath, "utf8")) as { scenes: { id: string; key: string }[] };

  const rows = buildOutputTimeline(
    script.scenes.map((scene) => {
      const recorded = timeline.scenes.find((s) => s.id === scene.id)!;
      const key = manifest.scenes.find((s) => s.id === scene.id)!.key;
      return { id: scene.id, actionMs: recorded.endMs - recorded.startMs, narrationMs: mediaDurationMs(cachePath(cacheDir, key)) };
    }),
    script.timing,
  );

  const syncDir = path.join(outDir, "sync");
  fs.rmSync(syncDir, { recursive: true, force: true });
  fs.mkdirSync(syncDir, { recursive: true });
  const offsets = [-0.6, -0.3, 0, 0.3, 0.6, 0.9];
  let n = 0;
  for (const scene of script.scenes) {
    const row = rows.find((r) => r.id === scene.id)!;
    const key = manifest.scenes.find((s) => s.id === scene.id)!.key;
    const alignment = JSON.parse(fs.readFileSync(cachePath(cacheDir, key).replace(/\.mp3$/, ".align.json"), "utf8")) as Alignment;
    for (const action of scene.actions) {
      if (!action.cue) continue;
      const atSec = (row.startMs + script.timing.leadMs + cueTimeMs(alignment, action.cue)) / 1000;
      const label = `${scene.id}-${++n}`;
      console.log(`${formatClock(atSec * 1000).padStart(5)} (${atSec.toFixed(1)}s)  ${scene.id.padEnd(16)} ${action.type.padEnd(8)} on "${action.cue}"  -> ${path.join("out", "sync", `${label}.png`)}`);
      const inputs = offsets.flatMap((o) => ["-ss", String(Math.max(0, atSec + o).toFixed(3)), "-i", video]);
      const filter = offsets.map((_, i) => `[${i}:v]scale=480:-1[f${i}]`).join(";") + `;${offsets.map((_, i) => `[f${i}]`).join("")}xstack=inputs=${offsets.length}:layout=0_0|w0_0|0_h0|w0_h0|0_h0+h0|w0_h0+h0[out]`;
      await runFfmpeg([...inputs, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", path.join(syncDir, `${label}.png`)], `sync strip ${label}`);
    }
  }
  console.log(`\n${n} cue strips in ${syncDir}. Frames are at ${offsets.join(", ")} s around each cue.`);
}

main().catch((err) => {
  console.error(`sync-report failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

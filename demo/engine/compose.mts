/**
 * Compose step: desktop backdrop + rounded/shadowed window recording +
 * narration, retimed so each scene's action length matches its narration.
 *
 *   node demo/engine/compose.mts [--dry-run]
 *
 * --dry-run prints the output timeline from the recorded (or estimated) action
 * lengths and the narration lengths, without running the composite.
 */
import * as fs from "node:fs";
import { cacheKey, cachePath, type VoiceSettings } from "./lib/cache.mts";
import { composeVideo, type ComposeScene } from "./lib/compose-core.mts";
import { mediaDurationMs } from "./lib/ffmpeg.mts";
import { buildDir, cacheDir, finalVideoPathFor, recordingPath, configPath, timelinePath, voiceoverManifestPath } from "./lib/paths.mts";
import { loadScript } from "./lib/script.mts";
import { buildOutputTimeline, estimateNarrationMs, estimateSceneActionMs, formatClock, sceneBudgetMs } from "./lib/timing.mts";

const DRY_RUN = process.argv.includes("--dry-run");

interface RecordedTimeline {
  scenes: { id: string; startMs: number; endMs: number }[];
}
interface VoiceManifest {
  voiceId: string;
  settings: VoiceSettings;
  scenes: { id: string; key: string; file: string }[];
}

function printTimeline(rows: ReturnType<typeof buildOutputTimeline>, label: string): void {
  console.log(`${label}\n`);
  console.log(`${"scene".padEnd(16)} ${"start".padStart(6)} ${"length".padStart(7)} ${"actions".padStart(8)} ${"voice".padStart(7)} ${"speed".padStart(6)} ${"hold".padStart(7)}`);
  for (const row of rows) {
    const { plan } = row;
    console.log(
      `${row.id.padEnd(16)} ${formatClock(row.startMs).padStart(6)} ${(plan.totalMs / 1000).toFixed(1).padStart(6)}s ${(plan.actionMs / 1000).toFixed(1).padStart(7)}s ` +
        `${(plan.narrationMs / 1000).toFixed(1).padStart(6)}s ${plan.videoSpeed.toFixed(2).padStart(6)} ${(plan.videoHoldMs / 1000).toFixed(1).padStart(6)}s`,
    );
  }
  console.log(`\ntotal ${formatClock(rows.at(-1)?.endMs ?? 0)}`);
}

async function main(): Promise<void> {
  const script = loadScript(configPath);

  if (DRY_RUN) {
    const rows = buildOutputTimeline(
      script.scenes.map((scene) => {
        const narrationMs = estimateNarrationMs(scene.narration);
        // Recording stretches pauses to fill the narration, so a scene never runs shorter than its budget.
        return { id: scene.id, actionMs: Math.max(estimateSceneActionMs(scene), sceneBudgetMs(narrationMs, script.timing)), narrationMs };
      }),
      script.timing,
    );
    printTimeline(rows, "compose dry run (estimated action and narration lengths)");
    return;
  }

  for (const file of [recordingPath, timelinePath, voiceoverManifestPath]) {
    if (!fs.existsSync(file)) throw new Error(`missing ${file}. Run \`node demo/engine/run.mts record\` and \`node demo/engine/run.mts voiceover\` first.`);
  }
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8")) as RecordedTimeline;
  const manifest = JSON.parse(fs.readFileSync(voiceoverManifestPath, "utf8")) as VoiceManifest;

  const scenes: ComposeScene[] = script.scenes.map((scene) => {
    const recorded = timeline.scenes.find((s) => s.id === scene.id);
    const voice = manifest.scenes.find((s) => s.id === scene.id);
    if (!recorded) throw new Error(`scene "${scene.id}" is not in the recording. Re-run \`node demo/engine/run.mts record\`.`);
    if (!voice) throw new Error(`scene "${scene.id}" has no voiceover. Re-run \`node demo/engine/run.mts voiceover\`.`);
    // Narration edited since the audio was made? The key would no longer match.
    const expected = cacheKey({ text: scene.narration, voiceId: manifest.voiceId, settings: manifest.settings });
    const audioFile = cachePath(cacheDir, voice.key); // resolve locally: the manifest may have been written on another machine
    if (expected !== voice.key || !fs.existsSync(audioFile)) {
      throw new Error(`voiceover for "${scene.id}" is stale. Re-run \`node demo/engine/run.mts voiceover\`.`);
    }
    return { id: scene.id, startMs: recorded.startMs, endMs: recorded.endMs, audioPath: audioFile, audioMs: mediaDurationMs(audioFile) };
  });

  const finalVideoPath = finalVideoPathFor(script.title);
  const result = await composeVideo({ script, scenes, recordingPath, buildDir, outPath: finalVideoPath });
  printTimeline(
    buildOutputTimeline(
      scenes.map((s) => ({ id: s.id, actionMs: s.endMs - s.startMs, narrationMs: s.audioMs })),
      script.timing,
    ),
    "composed",
  );
  console.log(`\nwrote ${finalVideoPath} (${formatClock(result.totalMs)})`);
}

main().catch((err) => {
  console.error(`compose failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

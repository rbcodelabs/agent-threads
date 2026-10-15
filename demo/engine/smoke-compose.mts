/**
 * Compose smoke test: runs the real composite on a synthetic test-pattern clip
 * and sine-tone "narration", so the ffmpeg graph can be checked without
 * Electron, Xvfb or an ElevenLabs key.
 *
 *   node demo/engine/smoke-compose.mts [outfile]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { composeVideo, type ComposeScene } from "./lib/compose-core.mts";
import { runFfmpeg } from "./lib/ffmpeg.mts";
import { configPath } from "./lib/paths.mts";
import { loadScript } from "./lib/script.mts";

async function main(): Promise<void> {
  const script = loadScript(configPath);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "demo-smoke-"));
  const outPath = process.argv[2] ?? path.join(os.tmpdir(), "demo-smoke.mp4");
  try {
    const { width, height, fps } = script.capture;
    // Three short scenes exercising each retime branch: pad audio, slow down, slow down + hold.
    const spec = [
      { id: "audio-longer-video", actionMs: 5000, audioHz: 440, audioMs: 3000 },
      { id: "slow-down", actionMs: 3000, audioHz: 550, audioMs: 3200 },
      { id: "slow-and-hold", actionMs: 2000, audioHz: 660, audioMs: 5000 },
    ];
    const totalMs = spec.reduce((sum, s) => sum + s.actionMs, 0);
    const recording = path.join(work, "recording.mp4");
    await runFfmpeg(
      ["-f", "lavfi", "-i", `testsrc2=s=${width}x${height}:r=${fps}:d=${totalMs / 1000}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", recording],
      "synthetic recording",
    );

    let cursor = 0;
    const scenes: ComposeScene[] = [];
    for (const s of spec) {
      const audioPath = path.join(work, `${s.id}.mp3`);
      await runFfmpeg(["-f", "lavfi", "-i", `sine=frequency=${s.audioHz}:duration=${s.audioMs / 1000}`, "-ac", "1", "-c:a", "libmp3lame", audioPath], `tone ${s.id}`);
      scenes.push({ id: s.id, startMs: cursor, endMs: cursor + s.actionMs, audioPath, audioMs: s.audioMs });
      cursor += s.actionMs;
    }

    const result = await composeVideo({ script, scenes, recordingPath: recording, buildDir: path.join(work, "build"), outPath });
    for (const [i, plan] of result.plans.entries()) {
      console.log(`${scenes[i].id.padEnd(20)} total ${(plan.totalMs / 1000).toFixed(2)}s speed ${plan.videoSpeed.toFixed(2)} hold ${(plan.videoHoldMs / 1000).toFixed(2)}s`);
    }
    console.log(`smoke output: ${outPath} (${(result.totalMs / 1000).toFixed(1)}s expected)`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

/**
 * Builds and runs the final ffmpeg composite: per-scene retime/pad of the
 * window recording, rounded corners onto the desktop backdrop, narration mix.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { buildAssets } from "./assets.mts";
import { runFfmpeg } from "./ffmpeg.mts";
import { computeLayout } from "./layout.mts";
import type { DemoScript } from "./script.mts";
import { planScene, type ScenePlan } from "./timing.mts";

export interface ComposeScene {
  id: string;
  /** Span of this scene inside the raw recording. */
  startMs: number;
  endMs: number;
  audioPath: string;
  audioMs: number;
}

const sec = (ms: number) => (ms / 1000).toFixed(3);

export interface ComposeArgsInput {
  script: DemoScript;
  scenes: ComposeScene[];
  recordingPath: string;
  backdropPath: string;
  maskPath: string;
  outPath: string;
}

export function buildComposeArgs(input: ComposeArgsInput): { args: string[]; plans: ScenePlan[]; totalMs: number } {
  const { script, scenes, recordingPath, backdropPath, maskPath, outPath } = input;
  const layout = computeLayout(script);
  const fps = script.output.fps;
  const plans = scenes.map((scene) => planScene(scene.endMs - scene.startMs, scene.audioMs, script.timing));
  const totalMs = plans.reduce((sum, plan) => sum + plan.totalMs, 0);

  const args = [
    "-loop", "1", "-framerate", String(fps), "-i", backdropPath,
    "-loop", "1", "-framerate", String(fps), "-i", maskPath,
    "-i", recordingPath,
  ];
  scenes.forEach((scene) => args.push("-i", scene.audioPath));

  const filters: string[] = [];
  scenes.forEach((scene, i) => {
    const plan = plans[i];
    const hold = plan.videoHoldMs > 0 ? `,tpad=stop_mode=clone:stop_duration=${sec(plan.videoHoldMs)}` : "";
    filters.push(
      `[2:v]trim=start=${sec(scene.startMs)}:end=${sec(scene.endMs)},setpts=(PTS-STARTPTS)/${plan.videoSpeed.toFixed(5)}${hold},` +
        `fps=${fps},trim=duration=${sec(plan.totalMs)},scale=${layout.windowW}:${layout.windowH}:flags=lanczos,setsar=1[v${i}]`,
    );
    filters.push(
      `[${3 + i}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${plan.audioDelayMs}:all=1,apad=whole_dur=${sec(plan.totalMs)}[a${i}]`,
    );
  });
  const videoLabels = scenes.map((_, i) => `[v${i}]`).join("");
  const audioLabels = scenes.map((_, i) => `[a${i}]`).join("");
  const fadeOutStart = Math.max(0, totalMs / 1000 - 0.8).toFixed(3);
  filters.push(
    `${videoLabels}concat=n=${scenes.length}:v=1:a=0[win]`,
    `[win][1:v]alphamerge[rounded]`,
    `[0:v][rounded]overlay=${layout.windowX}:${layout.windowY}:format=auto,fade=t=in:st=0:d=0.6,fade=t=out:st=${fadeOutStart}:d=0.8,format=yuv420p[vout]`,
    `${audioLabels}concat=n=${scenes.length}:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,afade=t=in:st=0:d=0.3,afade=t=out:st=${fadeOutStart}:d=0.8[aout]`,
  );

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-t", sec(totalMs),
    "-r", String(fps),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    outPath,
  );
  return { args, plans, totalMs };
}

export async function composeVideo(input: {
  script: DemoScript;
  scenes: ComposeScene[];
  recordingPath: string;
  buildDir: string;
  outPath: string;
}): Promise<{ plans: ScenePlan[]; totalMs: number }> {
  const assets = await buildAssets(input.script, input.buildDir);
  fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
  const { args, plans, totalMs } = buildComposeArgs({
    script: input.script,
    scenes: input.scenes,
    recordingPath: input.recordingPath,
    backdropPath: assets.backdrop,
    maskPath: assets.mask,
    outPath: input.outPath,
  });
  await runFfmpeg(args, "compose");
  return { plans, totalMs };
}

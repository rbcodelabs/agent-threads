import { spawn, spawnSync } from "node:child_process";

/** FFMPEG_PATH lets a machine without a system ffmpeg point at a static build. */
export function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

export interface RunResult {
  code: number;
  stderr: string;
}

export function runFfmpeg(args: string[], label: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => reject(new Error(`${label}: cannot run ${ffmpegBin()} (${err.message}). Install ffmpeg or set FFMPEG_PATH.`)));
    child.on("close", (code) => {
      if (code === 0) resolve({ code: 0, stderr });
      else reject(new Error(`${label}: ffmpeg exited ${code}\n${stderr.trim()}`));
    });
  });
}

/** Decode to the null muxer and read the final timestamp. Slower than a header read but exact for VBR mp3. */
export function mediaDurationMs(file: string): number {
  const result = spawnSync(ffmpegBin(), ["-hide_banner", "-nostats", "-i", file, "-f", "null", "-"], { encoding: "utf8" });
  if (result.error) throw new Error(`cannot run ${ffmpegBin()}: ${result.error.message}`);
  const times = [...result.stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const last = times.at(-1);
  if (!last) throw new Error(`could not read duration of ${file}:\n${result.stderr.slice(-400)}`);
  return Math.round((Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])) * 1000);
}

export function ffmpegCapabilities(): { ok: boolean; filters: string; devices: string; encoders: string } {
  const run = (args: string[]) => spawnSync(ffmpegBin(), ["-hide_banner", ...args], { encoding: "utf8" });
  const filters = run(["-filters"]);
  if (filters.error || filters.status !== 0) return { ok: false, filters: "", devices: "", encoders: "" };
  return { ok: true, filters: filters.stdout, devices: run(["-devices"]).stdout, encoders: run(["-encoders"]).stdout };
}

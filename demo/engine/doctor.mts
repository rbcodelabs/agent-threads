/**
 * Preflight: checks everything the pipeline needs before you spend a take on it.
 *
 *   node demo/engine/doctor.mts [--online]
 *
 * --online also verifies the ElevenLabs key and the chosen voice with one
 * read-only API call. The key itself is never printed.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { findFont } from "./lib/assets.mts";
import { ffmpegBin, ffmpegCapabilities } from "./lib/ffmpeg.mts";
import { projectRoot, configPath } from "./lib/paths.mts";
import { validateScript, type DemoScript } from "./lib/script.mts";

interface Check {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string, required = true): void => {
  checks.push({ name, ok, required, detail });
};

function checkScript(): DemoScript | null {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const errors = validateScript(raw);
    add(path.basename(configPath), errors.length === 0, errors.length ? errors.join("; ") : "valid");
    return errors.length === 0 ? (raw as DemoScript) : null;
  } catch (err) {
    add(path.basename(configPath), false, err instanceof Error ? err.message : String(err));
    return null;
  }
}

function checkFfmpeg(): void {
  const caps = ffmpegCapabilities();
  if (!caps.ok) {
    add("ffmpeg", false, `cannot run "${ffmpegBin()}". apt-get install ffmpeg, or set FFMPEG_PATH`);
    return;
  }
  add("ffmpeg", true, ffmpegBin());
  add("ffmpeg x11grab", /x11grab/.test(caps.devices) || process.platform !== "linux", "needed on the recording machine (Linux) to capture the Xvfb display", process.platform === "linux");
  add("ffmpeg libx264", /libx264/.test(caps.encoders), "needed for the final mp4");
  add("ffmpeg filters", ["geq", "alphamerge", "tpad", "loudnorm"].every((f) => new RegExp(`\\b${f}\\b`).test(caps.filters)), "geq, alphamerge, tpad, loudnorm");
}

function checkRuntime(script: DemoScript | null): void {
  const rec = script?.environment?.record;
  const remote = rec?.runner === "ssh";
  if (remote) {
    const ok = spawnSync("ssh", ["-o", "ConnectTimeout=5", "-o", "BatchMode=yes", rec!.host!, "true"], { stdio: "ignore" }).status === 0;
    add(`ssh ${rec!.host}`, ok, "environment.record.host must be reachable without a password prompt (unlock your SSH agent)");
  } else {
    const xvfb = spawnSync("Xvfb", ["-help"], { stdio: "ignore" });
    add("Xvfb", process.platform === "linux" && (!xvfb.error || !!process.env.DEMO_DISPLAY), "recording runs on Linux: apt-get install xvfb, or set environment.record.runner to ssh");
  }
  if (script?.target.type === "electron" && !remote) {
    add("Electron binary", fs.existsSync(path.join(projectRoot, "node_modules", "electron", "dist")), "node_modules/electron/dist (run `npm install`)");
  }
  if (script?.target.fixture) {
    add("target.fixture", fs.existsSync(path.resolve(projectRoot, script.target.fixture.source)), script.target.fixture.source);
  }
  if (script?.look.appIcon) add("look.appIcon", fs.existsSync(path.resolve(projectRoot, script.look.appIcon)), script.look.appIcon);
  add("menu bar font", findFont("regular") !== null || process.platform === "darwin", "set DEMO_FONT to a .ttf if missing", false);
}

async function checkElevenLabs(online: boolean): Promise<void> {
  const key = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID;
  add("ELEVENLABS_API_KEY", !!key, key ? "set" : "export it to generate narration");
  add("ELEVENLABS_VOICE_ID", !!voice, voice ? "set" : "run `node demo/engine/voices.mts`, then export the id you want");
  if (!online || !key) return;
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
    if (!response.ok) return add("ElevenLabs API", false, `HTTP ${response.status}`);
    const { voices } = (await response.json()) as { voices: { voice_id: string }[] };
    add("ElevenLabs API", true, `${voices.length} voices visible`);
    if (voice) add("voice id exists", voices.some((v) => v.voice_id === voice), "ELEVENLABS_VOICE_ID is in your account");
  } catch (err) {
    add("ElevenLabs API", false, err instanceof Error ? err.message : String(err));
  }
}

async function main(): Promise<void> {
  const script = checkScript();
  checkFfmpeg();
  checkRuntime(script);
  if ((script?.voice.provider ?? "elevenlabs") === "elevenlabs") await checkElevenLabs(process.argv.includes("--online"));
  for (const check of checks) {
    const mark = check.ok ? "ok  " : check.required ? "FAIL" : "warn";
    console.log(`${mark}  ${check.name.padEnd(24)} ${check.detail}`);
  }
  const failed = checks.filter((c) => !c.ok && c.required);
  console.log(failed.length ? `\n${failed.length} required check(s) failed` : "\nall required checks passed");
  process.exit(failed.length ? 1 : 0);
}

void main();

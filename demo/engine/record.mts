/**
 * Drive the real app (target in demo.config.json) through the scenes and record its window.
 *
 *   node demo/engine/record.mts            perform the scenes, write demo/out/raw/{recording.mp4,timeline.json}
 *   node demo/engine/record.mts --dry-run  validate the config and print the estimated timeline
 *   node demo/engine/record.mts --keep     keep the throwaway fixture and user-data dirs for debugging
 *
 * Linux only: the app runs VISIBLY on a private Xvfb display sized to the capture,
 * so ffmpeg's x11grab sees exactly the window and nothing else. Xvfb has no
 * pointer, so lib/overlay.mts draws one in the page. Each take uses a throwaway
 * user-data dir and a fresh copy of the fixture, removed on exit.
 *
 * Set DEMO_DISPLAY=:N to use an X display you already run instead of spawning Xvfb.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Page } from "@playwright/test";
import { easeInOut, typingDelays } from "./lib/humanize.mts";
import { cueTimeMs, type Alignment } from "./lib/cues.mts";
import { ffmpegBin, mediaDurationMs } from "./lib/ffmpeg.mts";
import { ensureOverlay, showKey } from "./lib/overlay.mts";
import { cachePath } from "./lib/cache.mts";
import { cacheDir, outDir, rawDir, recordingPath, projectRoot, configPath, timelinePath, voiceoverManifestPath } from "./lib/paths.mts";
import { launchTarget, prepareFixtures, type LaunchedTarget } from "./lib/target.mts";
import { loadScript, type Action, type DemoScript } from "./lib/script.mts";
import {
  buildOutputTimeline,
  CLICK_SETTLE_MS,
  DEFAULT_TYPE_DELAY_MS,
  estimateNarrationMs,
  estimateSceneActionMs,
  formatClock,
  MOVE_MS,
  PRESS_SETTLE_MS,
  sceneBudgetMs,
  stretchedPauseMs,
} from "./lib/timing.mts";

const DRY_RUN = process.argv.includes("--dry-run");
const KEEP = process.argv.includes("--keep");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class Performer {
  private x: number;
  private y: number;
  private typed = 0;
  private readonly page: Page;

  constructor(page: Page, script: DemoScript) {
    this.page = page;
    this.x = Math.round(script.capture.width * 0.55);
    this.y = Math.round(script.capture.height * 0.75);
  }

  async start(): Promise<void> {
    await ensureOverlay(this.page);
    await this.page.mouse.move(this.x, this.y);
  }

  async perform(action: Action): Promise<void> {
    await ensureOverlay(this.page);
    switch (action.type) {
      case "pause":
        await sleep(action.ms);
        return;
      case "waitFor":
        await this.locate(action.selector, action.timeoutMs ?? 15_000, action.optional);
        return;
      case "hover": {
        const target = await this.locate(action.selector, action.timeoutMs ?? 15_000, action.optional);
        if (target) await this.moveTo(target.x, target.y);
        return;
      }
      case "click": {
        const target = await this.locate(action.selector, action.timeoutMs ?? 15_000, action.optional);
        if (!target) return;
        await this.moveTo(target.x, target.y);
        await this.page.mouse.down();
        await sleep(70);
        await this.page.mouse.up();
        await sleep(CLICK_SETTLE_MS);
        return;
      }
      case "type": {
        const delays = typingDelays(action.text, action.delayMs ?? DEFAULT_TYPE_DELAY_MS, 1000 + this.typed++);
        const chars = Array.from(action.text);
        for (let i = 0; i < chars.length; i++) {
          if (chars[i] === "\n") await this.page.keyboard.press("Enter");
          else await this.page.keyboard.type(chars[i]);
          await sleep(delays[i]);
        }
        return;
      }
      case "press":
        if (action.label) {
          await showKey(this.page, action.label);
          await sleep(180);
        }
        await this.page.keyboard.press(action.key);
        await sleep(PRESS_SETTLE_MS);
        return;
    }
  }

  /** Visible centre of the first match, or null when an optional element never shows up. */
  private async locate(selector: string, timeoutMs: number, optional = false): Promise<{ x: number; y: number } | null> {
    const locator = this.page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout: timeoutMs });
      await locator.scrollIntoViewIfNeeded({ timeout: 2000 });
      const box = await locator.boundingBox();
      if (!box) throw new Error(`no bounding box for ${selector}`);
      // Aim a little left of centre on wide rows so the pointer lands on the label, not empty space.
      const x = box.x + Math.min(box.width / 2, 90);
      return { x: Math.round(x), y: Math.round(box.y + box.height / 2) };
    } catch (err) {
      if (optional) {
        console.warn(`  skipped optional step, "${selector}" not found`);
        return null;
      }
      throw err;
    }
  }

  /** Time-based eased move along a gentle arc, so duration does not depend on machine speed. */
  private async moveTo(x: number, y: number): Promise<void> {
    const fromX = this.x;
    const fromY = this.y;
    const distance = Math.hypot(x - fromX, y - fromY);
    const bend = Math.min(40, distance * 0.08);
    const startedAt = Date.now();
    for (;;) {
      const t = Math.min(1, (Date.now() - startedAt) / MOVE_MS);
      const e = easeInOut(t);
      const arc = Math.sin(Math.PI * e) * bend;
      await this.page.mouse.move(fromX + (x - fromX) * e, fromY + (y - fromY) * e - arc);
      if (t >= 1) break;
      await sleep(8);
    }
    this.x = x;
    this.y = y;
  }
}

/** Real narration lengths from the voiceover step when available, word-count estimates otherwise. */
function narrationLengths(script: DemoScript): Map<string, number> {
  const lengths = new Map<string, number>();
  let manifest: { scenes: { id: string; key: string }[] } | null = null;
  try {
    manifest = JSON.parse(fs.readFileSync(voiceoverManifestPath, "utf8"));
  } catch {
    console.warn("no voiceover manifest yet, pacing scenes from estimated narration length (run `node demo/engine/run.mts voiceover` first for exact timing)");
  }
  for (const scene of script.scenes) {
    // Resolve by key: the manifest may have been written on another machine, where absolute paths differ.
    const key = manifest?.scenes.find((s) => s.id === scene.id)?.key;
    const file = key ? cachePath(cacheDir, key) : undefined;
    if (!file || !fs.existsSync(file)) {
      if (manifest) throw new Error(`no narration audio for scene "${scene.id}" in demo/cache. Run \`node demo/engine/run.mts voiceover\`.`);
      lengths.set(scene.id, estimateNarrationMs(scene.narration));
    } else lengths.set(scene.id, mediaDurationMs(file));
  }
  return lengths;
}

function loadAlignments(script: DemoScript): Map<string, Alignment> {
  const out = new Map<string, Alignment>();
  let manifest: { scenes: { id: string; key: string }[] } | null = null;
  try {
    manifest = JSON.parse(fs.readFileSync(voiceoverManifestPath, "utf8"));
  } catch {
    // handled below: a scene with cues and no alignment is an error
  }
  for (const scene of script.scenes) {
    const key = manifest?.scenes.find((s) => s.id === scene.id)?.key;
    const file = key ? cachePath(cacheDir, key).replace(/\.mp3$/, ".align.json") : undefined;
    if (file && fs.existsSync(file)) out.set(scene.id, JSON.parse(fs.readFileSync(file, "utf8")) as Alignment);
    else if (scene.actions.some((a) => a.cue)) throw new Error(`scene "${scene.id}" has cues but no narration timings. Run \`node demo/engine/run.mts voiceover\` first.`);
  }
  return out;
}

/** How long before its cue an action must begin so that its visible effect lands on the cue. */
function leadInMs(action: Action): number {
  if (action.type === "click" || action.type === "hover") return MOVE_MS;
  if (action.type === "press" && action.label) return 180;
  return 0;
}

function printEstimate(script: DemoScript): void {
  const rows = buildOutputTimeline(
    script.scenes.map((scene) => {
      const narrationMs = estimateNarrationMs(scene.narration);
      // Recording stretches pauses to fill the narration, so a scene never runs shorter than its budget.
      return { id: scene.id, actionMs: Math.max(estimateSceneActionMs(scene), sceneBudgetMs(narrationMs, script.timing)), narrationMs };
    }),
    script.timing,
  );
  console.log(`${script.title}: ${script.scenes.length} scenes\n`);
  for (const [i, scene] of script.scenes.entries()) {
    const row = rows[i];
    console.log(
      `${String(i + 1).padStart(2)}. ${scene.id.padEnd(16)} ${formatClock(row.startMs).padStart(5)}  actions ${scene.actions.length} (~${(row.plan.actionMs / 1000).toFixed(1)}s)  narration ~${(row.plan.narrationMs / 1000).toFixed(1)}s -> ${(row.plan.totalMs / 1000).toFixed(1)}s`,
    );
  }
  console.log(`\nestimated output length ${formatClock(rows.at(-1)?.endMs ?? 0)}`);
}

function findFreeDisplay(): number {
  for (let n = 90; n < 200; n++) {
    if (!fs.existsSync(`/tmp/.X11-unix/X${n}`) && !fs.existsSync(`/tmp/.X${n}-lock`)) return n;
  }
  throw new Error("no free X display number between :90 and :199");
}

/**
 * Show a full-window magenta frame for a moment and return the wall-clock time
 * it first painted. The recorded video's own clock lags the wall clock by an
 * unknown amount (x11grab startup), so compose-time sync is calibrated against
 * where this marker shows up in the finished recording.
 */
async function flashMarker(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const el = document.createElement("div");
        el.style.cssText = "position:fixed;inset:0;background:#ff00ff;z-index:2147483647;";
        document.body.appendChild(el);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            resolve(performance.timeOrigin + performance.now());
            setTimeout(() => el.remove(), 450);
          }),
        );
      }),
  );
}

/** Seconds into the recording at which the magenta marker first appears. */
function findMarkerSec(file: string): number {
  const result = spawnSync(
    ffmpegBin(),
    ["-hide_banner", "-loglevel", "error", "-t", "8", "-i", file, "-vf", "signalstats,metadata=print:file=-", "-an", "-f", "null", "-"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  let time = 0;
  for (const line of result.stdout.split("\n")) {
    const t = /pts_time:([0-9.]+)/.exec(line);
    if (t) time = Number(t[1]);
    const v = /lavfi\.signalstats\.VAVG=([0-9.]+)/.exec(line);
    if (v && Number(v[1]) > 190) return time;
  }
  throw new Error("could not find the calibration marker in the recording");
}

async function startXvfb(width: number, height: number): Promise<{ display: string; stop: () => void }> {
  const existing = process.env.DEMO_DISPLAY;
  if (existing) return { display: existing, stop: () => {} };
  if (spawnSync("Xvfb", ["-help"], { stdio: "ignore" }).error) {
    throw new Error("Xvfb is not installed. On Debian/Ubuntu: apt-get install xvfb. Or set DEMO_DISPLAY to an existing X display.");
  }
  const n = findFreeDisplay();
  const child = spawn("Xvfb", [`:${n}`, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp"], { stdio: "ignore" });
  for (let i = 0; i < 50 && !fs.existsSync(`/tmp/.X11-unix/X${n}`); i++) await sleep(100);
  if (!fs.existsSync(`/tmp/.X11-unix/X${n}`)) {
    child.kill();
    throw new Error(`Xvfb did not come up on :${n}`);
  }
  return { display: `:${n}`, stop: () => child.kill("SIGTERM") };
}

interface Capture {
  /** Wall-clock time (ms epoch) that corresponds to 0:00 in the recording. */
  startedAt: number;
  stop: () => Promise<void>;
}

/** Start x11grab and resolve once frames are flowing, calibrating recording time against the wall clock. */
function startCapture(display: string, script: DemoScript, outFile: string): Promise<Capture> {
  const { width, height, fps } = script.capture;
  const child: ChildProcess = spawn(
    ffmpegBin(),
    [
      "-hide_banner", "-loglevel", "error", "-nostats", "-y",
      "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(fps), "-video_size", `${width}x${height}`, "-i", `${display}.0+0,0`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p",
      "-progress", "pipe:1",
      outFile,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin!.write("q");
    });

  return new Promise((resolve, reject) => {
    let buffer = "";
    let resolved = false;
    child.on("error", (err) => reject(new Error(`cannot run ${ffmpegBin()}: ${err.message}. Install ffmpeg or set FFMPEG_PATH.`)));
    child.on("close", (code) => {
      if (!resolved) reject(new Error(`ffmpeg x11grab exited ${code} before capturing:\n${stderr.trim()}`));
    });
    child.stdout!.on("data", (chunk) => {
      if (resolved) return;
      buffer += chunk;
      // Progress blocks repeat; judge the latest one (the first often reports frame=0).
      const frame = [...buffer.matchAll(/frame=(\d+)/g)].at(-1) ?? null;
      const outTimeUs = [...buffer.matchAll(/out_time_us=(-?\d+)/g)].at(-1) ?? null;
      if (frame && Number(frame[1]) > 0 && outTimeUs) {
        resolved = true;
        // out_time is how far into the recording this progress block was written.
        resolve({ startedAt: Date.now() - Number(outTimeUs[1]) / 1000, stop });
      }
    });
  });
}

async function record(script: DemoScript): Promise<void> {
  fs.mkdirSync(rawDir, { recursive: true });
  const { width, height } = script.capture;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-ud-"));
  const fixtureDir = script.target.fixture ? fs.mkdtempSync(path.join(os.tmpdir(), "demo-fixture-")) : "";
  const ctxBase = { width, height, projectRoot, userDataDir, fixtureDir };
  prepareFixtures(script.target, { ...ctxBase, display: "" });

  let xvfb: { display: string; stop: () => void } | null = null;
  let launched: LaunchedTarget | null = null;
  let capture: Capture | null = null;
  let page: Page | null = null;
  const cleanup = async () => {
    await capture?.stop().catch(() => {});
    capture = null;
    await launched?.close().catch(() => {});
    launched = null;
    xvfb?.stop();
    xvfb = null;
    if (!KEEP) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  };
  const onSignal = () => void cleanup().finally(() => process.exit(130));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    xvfb = await startXvfb(width, height);
    launched = await launchTarget(script.target, { ...ctxBase, display: xvfb.display });
    page = launched.page;
    await sleep(1500);

    const performer = new Performer(page, script);
    await performer.start();
    capture = await startCapture(xvfb.display, script, recordingPath);
    const startedAtEstimate = capture.startedAt;
    await sleep(300);
    const markerWallMs = await flashMarker(page);
    await sleep(1100);

    const narrationMs = narrationLengths(script);
    const alignments = loadAlignments(script);
    const wallScenes: { id: string; startWall: number; endWall: number }[] = [];
    for (const [i, scene] of script.scenes.entries()) {
      console.log(`scene ${i + 1}/${script.scenes.length}: ${scene.id}`);
      const startMs = Date.now() - capture.startedAt;
      const budgetMs = sceneBudgetMs(narrationMs.get(scene.id) ?? 0, script.timing);
      const alignment = alignments.get(scene.id);
      const elapsed = () => Date.now() - capture!.startedAt - startMs;
      // When to begin each cued action, relative to scene start. The narration audio is delayed by leadMs in compose.
      const targetOf = (action: Action): number | null =>
        action.cue && alignment ? Math.max(0, script.timing.leadMs + cueTimeMs(alignment, action.cue) - leadInMs(action)) : null;
      const hasCues = scene.actions.some((a) => a.cue);
      for (const [j, action] of scene.actions.entries()) {
        if (hasCues) {
          const target = targetOf(action);
          if (target !== null) {
            const wait = target - elapsed();
            if (wait > 0) await sleep(wait);
            else if (wait < -400) console.warn(`  late by ${-wait}ms: "${action.cue}" (${scene.id})`);
          }
        }
        if (action.type === "pause") {
          if (hasCues) {
            // Never let a pause push the next cued action past its cue.
            const next = scene.actions.slice(j + 1).map(targetOf).find((t): t is number => t !== null);
            const room = next === undefined ? action.ms : Math.min(action.ms, next - elapsed());
            if (room > 0) await sleep(room);
          } else {
            const remainingBudget = budgetMs - elapsed();
            await performer.perform({ type: "pause", ms: stretchedPauseMs(remainingBudget, scene.actions.slice(j)) });
          }
        } else {
          await performer.perform(action);
        }
      }
      // Hold the finished state until the narration has had time to complete.
      if (hasCues && elapsed() < budgetMs) await sleep(budgetMs - elapsed());
      wallScenes.push({ id: scene.id, startWall: capture.startedAt + startMs, endWall: Date.now() });
    }
    await sleep(1200);
    await capture.stop();
    capture = null;

    // Convert wall-clock scene spans to recording time using the marker, not x11grab's startup estimate.
    const trueStartWall = markerWallMs - findMarkerSec(recordingPath) * 1000;
    console.log(`capture clock calibration: x11grab estimate was ${Math.round(startedAtEstimate - trueStartWall)}ms later than the marker says`);
    const scenes = wallScenes.map((s) => ({ id: s.id, startMs: Math.round(s.startWall - trueStartWall), endMs: Math.round(s.endWall - trueStartWall) }));
    fs.writeFileSync(timelinePath, JSON.stringify({ capture: script.capture, scenes }, null, 2) + "\n");
    console.log(`recorded ${recordingPath}\nwrote ${timelinePath}`);
  } catch (err) {
    await page?.screenshot({ path: path.join(rawDir, "failure.png") }).catch(() => {});
    throw err;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await cleanup();
  }
}

async function main(): Promise<void> {
  const script = loadScript(configPath);
  if (DRY_RUN) {
    printEstimate(script);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  await record(script);
}

main().catch((err) => {
  console.error(`record failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

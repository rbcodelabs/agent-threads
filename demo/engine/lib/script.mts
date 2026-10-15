/**
 * Types and validation for demo/script.json, the single source of truth for
 * the demo video: narration text and the on-screen actions for each scene.
 */
import * as fs from "node:fs";

export type Action = (
  | { type: "pause"; ms: number }
  | { type: "click"; selector: string; optional?: boolean; timeoutMs?: number }
  | { type: "hover"; selector: string; optional?: boolean; timeoutMs?: number }
  | { type: "type"; text: string; delayMs?: number }
  | { type: "press"; key: string; label?: string }
  | { type: "waitFor"; selector: string; optional?: boolean; timeoutMs?: number }
) & {
  /** Fire this action when the narration reaches this phrase (case-insensitive). */
  cue?: string;
};

export interface Scene {
  id: string;
  narration: string;
  actions: Action[];
}

/** What the recorder drives. A desktop (Electron) app or a web app, both through Playwright. */
export interface TargetConfig {
  type: "electron" | "web";
  /** electron: folder (relative to the project root) holding the app's package.json / main entry. Default ".". */
  app?: string;
  /** electron: extra command-line arguments. Strings may use {{fixture}} and {{userData}}. */
  args?: string[];
  /** Extra environment variables for the app. Strings may use {{fixture}} and {{userData}}. */
  env?: Record<string, string>;
  /** web: page to open. {{fixture}} is not available; use a startCommand to serve one. */
  url?: string;
  /** web: command (run from the project root) that serves the app; the recorder stops it afterwards. */
  startCommand?: string;
  /** CSS selector that means "the app is ready". The recorder waits for it before recording. */
  readySelector: string;
  readyTimeoutMs?: number;
  /** A folder of sample data copied to a throwaway location for every take, so each take starts clean. */
  fixture?: { source: string; exclude?: string[] };
  /** Files written into the throwaway user-data dir before launch. Values may use {{fixture}}. */
  userDataFiles?: Record<string, unknown>;
}

/** Where the heavy steps run. Omitted means: record and compose on this machine. */
export interface EnvironmentConfig {
  record?: {
    runner: "local" | "ssh";
    /** ssh: host alias from ~/.ssh/config. */
    host?: string;
    /** ssh: scratch folder on the remote host. Removed after the run unless --keep-remote. */
    remoteDir?: string;
    /** ssh: shell snippet run before every remote command (for example, select the Node version). */
    shellInit?: string;
    /** ssh: commands run in the remote project copy before recording (install, build). */
    setup?: string[];
    /** ssh: paths excluded from the sync (always excludes node_modules, .git, and the demo's out/). */
    syncExclude?: string[];
  };
}

export interface DemoScript {
  title: string;
  target: TargetConfig;
  environment?: EnvironmentConfig;
  capture: { width: number; height: number; fps: number };
  output: { width: number; height: number; fps: number };
  look: {
    /** "macos" (default): wallpaper, menu bar, dock. "plain": wallpaper and window only. */
    style?: "macos" | "plain";
    /** Dock apps by name, from the built-in list. Default: all of them. */
    dockApps?: string[];
    /** Path (relative to the project root) of your app's icon for the dock. Omit for a neutral tile. */
    appIcon?: string;
    windowWidth: number;
    cornerRadius: number;
    dock: boolean;
    menuBar: { appName: string; items: string[]; clock: string };
  };
  voice: { provider?: "elevenlabs" | "none"; modelId: string; stability: number; similarityBoost: number; style: number };
  timing: { leadMs: number; tailMs: number; maxSlowdown: number };
  scenes: Scene[];
}

const SELECTOR_ACTIONS = new Set(["click", "hover", "waitFor"]);
const ACTION_TYPES = new Set(["pause", "click", "hover", "type", "press", "waitFor"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function positive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function validateTarget(target: unknown): string[] {
  if (!isObject(target)) return ["target: required object"];
  const errors: string[] = [];
  if (target.type !== "electron" && target.type !== "web") errors.push('target.type: "electron" or "web"');
  if (typeof target.readySelector !== "string" || !target.readySelector) errors.push("target.readySelector: required CSS selector");
  if (target.type === "web" && typeof target.url !== "string") errors.push("target.url: required for a web target");
  if (target.fixture !== undefined && (!isObject(target.fixture) || typeof target.fixture.source !== "string")) errors.push("target.fixture.source: required string");
  return errors;
}

function validateEnvironment(env: unknown): string[] {
  if (env === undefined) return [];
  if (!isObject(env)) return ["environment: must be an object"];
  const record = env.record;
  if (record === undefined) return [];
  if (!isObject(record)) return ["environment.record: must be an object"];
  const errors: string[] = [];
  if (record.runner !== "local" && record.runner !== "ssh") errors.push('environment.record.runner: "local" or "ssh"');
  if (record.runner === "ssh") {
    if (typeof record.host !== "string" || !record.host) errors.push("environment.record.host: ssh host alias required");
    if (typeof record.remoteDir !== "string" || !record.remoteDir) errors.push("environment.record.remoteDir: scratch folder required");
  }
  return errors;
}

/** Collects every problem rather than stopping at the first, so one edit-validate loop fixes them all. */
export function validateScript(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(raw)) return ["script must be a JSON object"];

  if (typeof raw.title !== "string" || !raw.title) errors.push("title: required string");
  for (const key of ["capture", "output"] as const) {
    const block = raw[key];
    if (!isObject(block) || !positive(block.width) || !positive(block.height) || !positive(block.fps)) {
      errors.push(`${key}: needs positive width, height, fps`);
    }
  }
  const look = raw.look;
  if (!isObject(look) || !positive(look.windowWidth) || typeof look.dock !== "boolean" || !isObject(look.menuBar)) {
    errors.push("look: needs windowWidth, dock (boolean), menuBar");
  } else if (!positive(look.cornerRadius)) {
    errors.push("look.cornerRadius: positive number");
  }
  const voice = raw.voice;
  const provider = isObject(voice) ? (voice.provider ?? "elevenlabs") : "elevenlabs";
  if (provider !== "elevenlabs" && provider !== "none") errors.push('voice.provider: "elevenlabs" or "none"');
  else if (provider === "elevenlabs" && (!isObject(voice) || typeof voice.modelId !== "string")) errors.push("voice.modelId: required string for the elevenlabs provider");
  errors.push(...validateTarget(raw.target), ...validateEnvironment(raw.environment));
  if (isObject(look) && look.style !== undefined && look.style !== "macos" && look.style !== "plain") errors.push('look.style: "macos" or "plain"');
  const timing = raw.timing;
  const nonNegative = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!isObject(timing) || !nonNegative(timing.leadMs) || !nonNegative(timing.tailMs) || typeof timing.maxSlowdown !== "number" || timing.maxSlowdown < 1) {
    errors.push("timing: needs leadMs, tailMs >= 0 and maxSlowdown >= 1");
  }

  if (!Array.isArray(raw.scenes) || raw.scenes.length === 0) {
    errors.push("scenes: non-empty array required");
    return errors;
  }
  const seen = new Set<string>();
  raw.scenes.forEach((scene, i) => {
    const where = `scenes[${i}]`;
    if (!isObject(scene)) return void errors.push(`${where}: must be an object`);
    if (typeof scene.id !== "string" || !/^[a-z0-9-]+$/.test(scene.id)) errors.push(`${where}.id: lowercase letters, digits, dashes`);
    else if (seen.has(scene.id)) errors.push(`${where}.id: duplicate "${scene.id}"`);
    else seen.add(scene.id);
    if (typeof scene.narration !== "string" || !scene.narration.trim()) errors.push(`${where}.narration: required text`);
    if (!Array.isArray(scene.actions) || scene.actions.length === 0) {
      errors.push(`${where}.actions: non-empty array required`);
      return;
    }
    scene.actions.forEach((action, j) => {
      const at = `${where}.actions[${j}]`;
      if (!isObject(action) || typeof action.type !== "string" || !ACTION_TYPES.has(action.type)) {
        return void errors.push(`${at}: unknown action type`);
      }
      if (action.type === "pause" && !positive(action.ms)) errors.push(`${at}: pause needs positive ms`);
      if (SELECTOR_ACTIONS.has(action.type) && (typeof action.selector !== "string" || !action.selector)) errors.push(`${at}: ${action.type} needs selector`);
      if (action.type === "type" && (typeof action.text !== "string" || !action.text)) errors.push(`${at}: type needs text`);
      if (action.cue !== undefined && (typeof action.cue !== "string" || !action.cue)) errors.push(`${at}: cue must be a non-empty string`);
      else if (typeof action.cue === "string" && typeof scene.narration === "string" && !scene.narration.toLowerCase().includes(action.cue.toLowerCase())) {
        errors.push(`${at}: cue "${action.cue}" does not appear in the scene narration`);
      }
      if (action.type === "press" && (typeof action.key !== "string" || !action.key)) errors.push(`${at}: press needs key`);
    });
  });
  return errors;
}

export function parseScript(raw: unknown): DemoScript {
  const errors = validateScript(raw);
  if (errors.length) throw new Error(`Invalid demo script:\n  - ${errors.join("\n  - ")}`);
  return raw as DemoScript;
}

export function loadScript(file: string): DemoScript {
  return parseScript(JSON.parse(fs.readFileSync(file, "utf8")));
}

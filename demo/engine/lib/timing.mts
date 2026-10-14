/**
 * Scene timing: how long actions take on screen, how long narration takes,
 * and how compose reconciles the two. Pure functions so both the dry run and
 * the unit tests can use them without Electron or ffmpeg.
 */
import type { Action, Scene } from "./script.mts";

/** Shared with record.mts so the dry-run estimate matches what the driver actually does. */
export const MOVE_MS = 700;
export const CLICK_SETTLE_MS = 250;
export const PRESS_SETTLE_MS = 350;
export const WAIT_FOR_ESTIMATE_MS = 300;
export const DEFAULT_TYPE_DELAY_MS = 80;
export const SPEECH_WORDS_PER_MINUTE = 150;

export function estimateActionMs(action: Action): number {
  switch (action.type) {
    case "pause":
      return action.ms;
    case "click":
      return MOVE_MS + CLICK_SETTLE_MS;
    case "hover":
      return MOVE_MS;
    case "type":
      return action.text.length * (action.delayMs ?? DEFAULT_TYPE_DELAY_MS);
    case "press":
      return PRESS_SETTLE_MS;
    case "waitFor":
      return WAIT_FOR_ESTIMATE_MS;
  }
}

export function estimateSceneActionMs(scene: Scene): number {
  return scene.actions.reduce((sum, action) => sum + estimateActionMs(action), 0);
}

/** Used by the dry run before any audio exists. Real runs measure the mp3. */
export function estimateNarrationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words / SPEECH_WORDS_PER_MINUTE) * 60_000);
}

export interface TimingConfig {
  leadMs: number;
  tailMs: number;
  maxSlowdown: number;
}

export interface ScenePlan {
  actionMs: number;
  narrationMs: number;
  /** Final on-screen length of the scene in the output video. */
  totalMs: number;
  /** Playback speed applied to the recorded clip. 1 = untouched, below 1 = slow motion. */
  videoSpeed: number;
  /** Frozen last-frame time appended after the (possibly slowed) clip. */
  videoHoldMs: number;
  /** Silence before the narration starts. */
  audioDelayMs: number;
}

/**
 * Make the action length match the narration length.
 *
 * - Actions already outlast the narration: leave the video alone, pad the audio with silence.
 * - Narration slightly longer: slow the clip down, up to `maxSlowdown`, so it stays smooth.
 * - Narration much longer: slow to the limit, then hold the final frame for the rest,
 *   which reads as the presenter pausing while the voice finishes.
 */
export function planScene(actionMs: number, narrationMs: number, cfg: TimingConfig): ScenePlan {
  const needMs = cfg.leadMs + narrationMs + cfg.tailMs;
  const base = { actionMs, narrationMs, audioDelayMs: cfg.leadMs };
  if (actionMs >= needMs) {
    return { ...base, totalMs: Math.round(actionMs), videoSpeed: 1, videoHoldMs: 0 };
  }
  if (needMs / actionMs <= cfg.maxSlowdown) {
    return { ...base, totalMs: Math.round(needMs), videoSpeed: actionMs / needMs, videoHoldMs: 0 };
  }
  const stretchedMs = actionMs * cfg.maxSlowdown;
  return {
    ...base,
    totalMs: Math.round(needMs),
    videoSpeed: 1 / cfg.maxSlowdown,
    videoHoldMs: Math.round(needMs - stretchedMs),
  };
}

export interface TimelineEntry {
  id: string;
  startMs: number;
  endMs: number;
  plan: ScenePlan;
}

/** Lay scenes end to end in the output video. */
export function buildOutputTimeline(
  scenes: { id: string; actionMs: number; narrationMs: number }[],
  cfg: TimingConfig,
): TimelineEntry[] {
  let cursor = 0;
  return scenes.map((scene) => {
    const plan = planScene(scene.actionMs, scene.narrationMs, cfg);
    const entry = { id: scene.id, startMs: cursor, endMs: cursor + plan.totalMs, plan };
    cursor = entry.endMs;
    return entry;
  });
}

/** Time a scene should occupy so its narration fits: lead-in, speech, tail. */
export function sceneBudgetMs(narrationMs: number, cfg: TimingConfig): number {
  return cfg.leadMs + narrationMs + cfg.tailMs;
}

const MAX_PAUSE_STRETCH = 8;

/**
 * Recording pads scenes with live UI time instead of frozen frames: before each
 * pause, spread whatever budget is left over the pauses still to come. Adapting
 * as the take runs (rather than scaling up front) absorbs real-world latency in
 * typing and waits.
 *
 * `remaining[0]` is the pause about to run.
 */
export function stretchedPauseMs(remainingBudgetMs: number, remaining: Action[]): number {
  const current = remaining[0];
  if (!current || current.type !== "pause") throw new Error("stretchedPauseMs needs a pause as the first remaining action");
  let fixedMs = 0;
  let pauseMs = 0;
  for (const action of remaining) {
    if (action.type === "pause") pauseMs += action.ms;
    else fixedMs += estimateActionMs(action);
  }
  const extraMs = remainingBudgetMs - fixedMs - pauseMs;
  if (extraMs <= 0) return current.ms;
  return Math.round(current.ms * (1 + Math.min(MAX_PAUSE_STRETCH, extraMs / pauseMs)));
}

export function formatClock(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

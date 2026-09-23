import type { ScheduledItem, ScheduledItemSchedule, RunEvent } from './types';
import cron, { type ScheduledTask } from 'node-cron';
import { sharedScheduleCoordinator } from './ScheduleCoordinator';
import {
  GATE_INDETERMINATE_EXIT_CODE,
  type GateEnvironment,
  type GateResult,
} from './gateRunner';

/**
 * Fields that can be updated on a ScheduledItem. The `schedule` field accepts
 * partial overrides — only the provided sub-fields are merged into the existing
 * schedule (e.g. you can change `timeOfDay` without supplying `type`).
 */
export interface SchedulerItemPatch {
  name?: string;
  prompt?: string;
  enabled?: boolean;
  schedule?: Partial<ScheduledItemSchedule>;
  cwd?: string;
  projectId?: string | null;
  lastRun?: number;
  nextRun?: number;
  lastThreadId?: string;
  /**
   * The gate is a top-level field (not nested under `schedule`), so it merges
   * via `updateItem`'s plain spread of `restPatch` over the item — no special
   * nested-merge handling needed. Set to `undefined` to clear an existing gate.
   */
  gate?: ScheduledItem['gate'] | undefined;
}

export interface SchedulerOptions {
  getItems: () => ScheduledItem[];
  saveItem: (item: ScheduledItem) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  saveItems?: (items: ScheduledItem[]) => Promise<void>;
  createThread: (title: string, cwd: string, projectId?: string, scheduledItemId?: string) => { id: string };
  sendMessage: (threadId: string, prompt: string) => Promise<void>;
  getDefaultCwd: () => string;
  /** Resolve a Project cwd at use time. Undefined means the Project is stale. */
  getProjectCwd?: (projectId: string) => string | undefined;
  /**
   * Returns true when a thread with the given ID still exists. Used by items
   * with a targetThreadId (loops) to decide whether to reuse the thread or
   * fall back to creating a new one. Optional for backwards compatibility.
   */
  threadExists?: (threadId: string) => boolean;
  /**
   * Returns true when a thread with the given ID is still busy processing a
   * previous turn. Used to defer firing a loop item into a thread that
   * hasn't finished its last cycle yet, so ticks don't pile up as queued
   * duplicates. Optional for backwards compatibility.
   */
  isThreadBusy?: (threadId: string) => boolean;
  /**
   * Defense-in-depth fencing guard against duplicate fires from two coexisting
   * Scheduler instances (e.g. during a plugin reload race where the old
   * instance's timers haven't been torn down yet). Called with the in-memory
   * item that is about to fire; the caller should read the CURRENT on-disk
   * state (not any in-memory cache) and use `nextRun` as a fencing token:
   *
   *  - If the on-disk item is missing/disabled, or its `nextRun` no longer
   *    matches the `nextRun` this timer was armed against, someone else
   *    already claimed this cycle: return `{ claimed: false, fresh }` with
   *    the current on-disk item (if any) so the caller can rearm against it.
   *  - Otherwise, atomically advance `lastRun`/`nextRun` on disk and return
   *    `{ claimed: true, fresh }` with the updated item.
   *
   * Optional for backwards compatibility — when absent, Scheduler behaves
   * exactly as it did before this guard existed.
   */
  claimFire?: (item: ScheduledItem) => Promise<{ claimed: boolean; fresh?: ScheduledItem }>;
  /**
   * Called instead of creating a stray replacement thread when an
   * `isOrchestratorHeartbeat: true` item's `targetThreadId` no longer
   * resolves (the orchestrator thread was deleted/archived out from under
   * it). `lastRun`/`nextRun` still advance normally afterward so the item
   * doesn't spin retrying every cycle — this hook is purely a notification
   * point, e.g. for logging a warning to run "Open Thread Orchestrator" again.
   */
  onOrchestratorHeartbeatStale?: (item: ScheduledItem) => void;
  /**
   * Runs an item's gate command (see ScheduledItem.gate). Injected — like
   * createThread/sendMessage — so this module stays free of direct node
   * imports and remains unit-testable. Resolves with the command's exit code
   * and stdout; `timedOut` is true when the command exceeded `timeoutMs` and
   * was killed, and `spawnError` is set when the command could not be launched
   * at all (e.g. command-not-found). Those and reserved exit 75 are "could not
   * evaluate" conditions handled by the fail-open logic in fire(); other clean
   * non-zero exit codes deliberately skip the cycle. When this option is
   * absent (e.g. on mobile), a configured gate fails open (fires).
   */
  runGate?: (
    command: string,
    opts: { cwd: string; timeoutMs: number } & GateEnvironment,
  ) => Promise<GateResult>;
  /**
   * Supplies the ephemeral environment and keychain values used for diagnostic
   * redaction. fire() layers CRON_LAST_RUN_MS / CRON_ITEM_ID / CRON_ITEM_NAME
   * on top. Keeping host environment resolution in the caller keeps this module
   * node-free and prevents secrets from entering scheduled-item persistence.
   *
   * Called with the firing item's `projectId` (undefined for project-less
   * items) so the caller can apply per-secret Project scoping
   * (`PluginSettings.secretEnvScopes`) before handing back keychain values.
   */
  getGateBaseEnv?: (projectId?: string) => GateEnvironment;
}

/** Default gate timeout when an item doesn't specify one. */
const GATE_DEFAULT_TIMEOUT_SECONDS = 30;
/** Hard ceiling on a gate's timeout so a misconfigured item can't hang a cycle indefinitely. */
const GATE_MAX_TIMEOUT_SECONDS = 120;
/** Max bytes of gate stdout interpolated into the prompt (~8 KB). */
const GATE_STDOUT_MAX_BYTES = 8 * 1024;
/** Placeholder replaced with the gate's stdout when present in the prompt. */
const GATE_OUTPUT_PLACEHOLDER = '{{gateOutput}}';

/**
 * Max number of run-history entries retained per scheduled item. The history is
 * a ring buffer (oldest dropped first) so a frequently-firing item can't grow
 * its persisted state without bound. Exported so the Settings UI and tests can
 * reference the same cap.
 */
export const RUN_HISTORY_MAX = 50;
/** Native timers are deliberately chunked to avoid the signed 32-bit delay ceiling. */
export const MAX_SCHEDULER_TIMEOUT_MS = 86_400_000;

/**
 * Append a run outcome to an item's bounded history ring buffer, mutating the
 * item in place. Trims from the front so at most RUN_HISTORY_MAX entries remain,
 * most recent last. Kept as a free function so it's unit-testable in isolation.
 */
export function recordRunEvent(item: ScheduledItem, event: RunEvent): void {
  const history = item.runHistory ?? [];
  history.push(event);
  if (history.length > RUN_HISTORY_MAX) {
    history.splice(0, history.length - RUN_HISTORY_MAX);
  }
  item.runHistory = history;
}

// Internal: compute next fire time from an item.
// fromNow=true resets the base to Date.now() (used after a fired run).
// Exported (rather than kept as a private Scheduler method) so callers that
// need to replicate a scheduling decision outside the Scheduler instance —
// e.g. main.ts's claimFire fencing guard, which advances nextRun on disk
// before the Scheduler itself has a chance to — can reuse the exact same
// logic instead of duplicating it.
export function computeNextRun(item: ScheduledItem, fromNow = false): number {
  const now = Date.now();
  const { schedule } = item;

  if (schedule.type === 'interval') {
    const intervalMs = (schedule.intervalSeconds ?? 3600) * 1000;
    if (fromNow || !item.lastRun) {
      return now + intervalMs;
    }
    return item.lastRun + intervalMs;
  }

  if (schedule.type === 'daily') {
    return nextCalendarRun(item, now);
  }

  if (schedule.type === 'weekly') {
    return nextCalendarRun(item, now);
  }

  if (schedule.type === 'once') {
    // Fixed absolute fire time — fromNow is irrelevant since there is no
    // recurrence to re-anchor. Falls back to "now" only if fireAt was
    // somehow omitted, so the item still fires promptly rather than never.
    return schedule.fireAt ?? now;
  }

  return now + 86400 * 1000;
}

function cronExpression(schedule: ScheduledItemSchedule): string {
  const [hour = '9', minute = '0'] = (schedule.timeOfDay ?? '09:00').split(':');
  const days = schedule.type === 'weekly' ? (schedule.daysOfWeek ?? [1]).join(',') : '*';
  return `${Number(minute)} ${Number(hour)} * * ${days}`;
}

function nextCalendarRun(item: ScheduledItem, fromMs: number): number {
  // node-cron calculates in local time and owns DST/calendar edge cases. Its
  // public getNextRun API only returns a value for a started task, so start and
  // immediately destroy this calculation-only task.
  let task: ScheduledTask | undefined;
  try {
    task = cron.createTask(cronExpression(item.schedule), () => undefined);
    task.start();
    const candidate = task.getNextRun()?.getTime();
    if (candidate && isValidCalendarCandidate(item.schedule, fromMs, candidate)) return candidate;
    // 4.2.1's public matcher is the primary calculator. Keep a defensive
    // local-time fallback for an invalid/null result (including its known
    // far-future weekday walker edge case) so persisted nextRun stays sane.
    return item.schedule.type === 'weekly'
      ? nextWeeklyRun(item.schedule.timeOfDay ?? '09:00', item.schedule.daysOfWeek ?? [1], fromMs)
      : nextTimeOfDay(item.schedule.timeOfDay ?? '09:00', fromMs);
  } finally {
    task?.destroy();
  }
}

function isValidCalendarCandidate(schedule: ScheduledItemSchedule, fromMs: number, candidateMs: number): boolean {
  if (candidateMs <= fromMs) return false;
  const candidate = new Date(candidateMs);
  const [hour = '9', minute = '0'] = (schedule.timeOfDay ?? '09:00').split(':');
  if (candidate.getHours() !== Number(hour) || candidate.getMinutes() !== Number(minute)) return false;
  if (schedule.type === 'daily') return candidateMs - fromMs <= 26 * 60 * 60 * 1000;
  return (schedule.daysOfWeek ?? [1]).includes(candidate.getDay()) &&
    candidateMs - fromMs <= 8 * 24 * 60 * 60 * 1000;
}

// Returns true when `atMs` falls within the schedule's configured
// `activeHours` window (if any). No `activeHours` means unrestricted — always
// true. Supports overnight windows where start > end (e.g. "22:00"-"06:00")
// by wrapping past midnight. A zero-width window (start === end) is treated
// as a misconfiguration and, like no window at all, is unrestricted rather
// than silently never firing.
//
// Exported (like computeNextRun) so tests can exercise the boundary/wrap
// logic directly without driving a full Scheduler instance through fake timers.
export function isWithinActiveHours(schedule: ScheduledItemSchedule, atMs: number): boolean {
  const { activeHours } = schedule;
  if (!activeHours) return true;

  const nowMinutes = minutesOfDay(atMs);
  const startMinutes = parseHHMM(activeHours.start);
  const endMinutes = parseHHMM(activeHours.end);

  if (startMinutes === endMinutes) return true;

  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // Overnight window: active from start through midnight, then midnight through end.
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

// Truncate the gate's stdout to a byte cap so a runaway command can't stuff the
// prompt (and the transcript) with megabytes of output. Cuts on a UTF-8 code
// unit boundary via Buffer, then appends a marker so the truncation is visible.
function truncateGateStdout(stdout: string): string {
  const buf = Buffer.from(stdout, 'utf8');
  if (buf.length <= GATE_STDOUT_MAX_BYTES) return stdout;
  const truncated = buf.subarray(0, GATE_STDOUT_MAX_BYTES).toString('utf8');
  return `${truncated}\n… [gate output truncated]`;
}

// Fold a gate's stdout into the prompt sent to the agent on a fire. If the
// prompt contains the {{gateOutput}} placeholder, replace every occurrence with
// the (truncated) stdout. Otherwise, when stdout is non-empty, append it as a
// clearly delimited block so the agent still gets the context. An empty stdout
// with no placeholder leaves the prompt unchanged; a placeholder is always
// substituted (with empty string) so the literal token never reaches the agent.
export function interpolateGateOutput(prompt: string, stdout: string): string {
  const trimmed = stdout.trim();
  const capped = trimmed ? truncateGateStdout(trimmed) : '';
  if (prompt.includes(GATE_OUTPUT_PLACEHOLDER)) {
    return prompt.split(GATE_OUTPUT_PLACEHOLDER).join(capped);
  }
  if (!capped) return prompt;
  return `${prompt}\n\n---\nGate output:\n${capped}`;
}

function parseHHMM(timeOfDay: string): number {
  const [hStr, mStr] = timeOfDay.split(':');
  const h = parseInt(hStr ?? '0', 10);
  const m = parseInt(mStr ?? '0', 10);
  return h * 60 + m;
}

function minutesOfDay(atMs: number): number {
  const d = new Date(atMs);
  return d.getHours() * 60 + d.getMinutes();
}

// Returns the next epoch ms for a given HH:MM time today or tomorrow.
function nextTimeOfDay(timeOfDay: string, fromMs: number): number {
  const [hStr, mStr] = timeOfDay.split(':');
  const h = parseInt(hStr ?? '9', 10);
  const m = parseInt(mStr ?? '0', 10);

  const d = new Date(fromMs);
  const candidate = new Date(d);
  candidate.setHours(h, m, 0, 0);

  // If the time today has already passed, schedule for tomorrow
  if (candidate.getTime() <= fromMs) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}

// Returns the next epoch ms for weekly schedule.
function nextWeeklyRun(timeOfDay: string, daysOfWeek: number[], fromMs: number): number {
  const [hStr, mStr] = timeOfDay.split(':');
  const h = parseInt(hStr ?? '9', 10);
  const m = parseInt(mStr ?? '0', 10);

  let best = Infinity;

  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(fromMs);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(h, m, 0, 0);

    const dayOfWeek = candidate.getDay();
    if (!daysOfWeek.includes(dayOfWeek)) continue;
    if (candidate.getTime() <= fromMs) continue;

    if (candidate.getTime() < best) {
      best = candidate.getTime();
    }
  }

  // Fallback: 7 days from now if nothing matched (should not happen with valid config)
  return best === Infinity ? fromMs + 7 * 86400 * 1000 : best;
}

// Base delay before firing an item whose nextRun was already in the past when
// the timer was armed (e.g. plugin just started/reloaded). Additional items
// caught up in the same boot are staggered further out (see armTimer) so a
// batch of overdue items doesn't all fire in the same instant.
const CATCHUP_BASE_DELAY_MS = 5_000;
const CATCHUP_STAGGER_STEP_MS = 2_000;
const CATCHUP_STAGGER_MAX_MS = 30_000;

export class Scheduler {
  private timers = new Map<string, number>();
  private calendarTasks = new Map<string, ScheduledTask>();
  private items: ScheduledItem[] = [];
  private coordinator = sharedScheduleCoordinator();
  private coordinatorRegistration?: symbol;
  // Cheap reentrancy guard: prevents two overlapping fire() calls for the same
  // item (e.g. two timer callbacks racing within the same instance) from both
  // reaching thread creation. Cleared in a finally so it never gets stuck.
  private firing = new Set<string>();
  // Counts catch-up (missed-run) fires armed during the current boot, used to
  // stagger their delays so a batch of overdue items doesn't all fire at once.
  private catchUpCount = 0;

  constructor(private options: SchedulerOptions) {}

  /** Resolve the cwd exactly as a fire will: explicit item cwd, Project, global. */
  getEffectiveCwd(item: Pick<ScheduledItem, 'cwd' | 'projectId'>): string {
    if (item.cwd) return item.cwd;
    if (item.projectId) {
      if (!this.options.getProjectCwd) return this.options.getDefaultCwd();
      const projectCwd = this.options.getProjectCwd(item.projectId);
      if (!projectCwd) throw new Error(`Project not found: ${item.projectId}`);
      return projectCwd;
    }
    return this.options.getDefaultCwd();
  }

  private validateProject(projectId: string | undefined): void {
    if (projectId && this.options.getProjectCwd && !this.options.getProjectCwd(projectId)) {
      throw new Error(`Project not found: ${projectId}`);
    }
  }

  /** Load items from settings and arm timers. Call once on plugin load. */
  start(items: ScheduledItem[]): void {
    // Take an internal copy — do not mutate the passed-in array reference
    this.items = items.map((i) => ({ ...i }));
    this.activateCoordinator(true);
    this.catchUpCount = 0;
    for (const item of this.items) {
      if (item.enabled) {
        this.armTimer(item);
      }
    }
  }

  /** Stop all timers (call on plugin unload). */
  destroy(): void {
    for (const id of this.timers.values()) {
      window.clearTimeout(id);
    }
    this.timers.clear();
    for (const task of this.calendarTasks.values()) task.destroy();
    this.calendarTasks.clear();
    if (this.coordinatorRegistration) {
      this.coordinator.deactivate(this.coordinatorRegistration);
      this.coordinatorRegistration = undefined;
    }
  }

  // Internal: arm a setTimeout for an item, handling missed runs.
  private armTimer(item: ScheduledItem): void {
    this.cancelWakeSources(item.id);

    if (!item.enabled) return;

    const now = Date.now();
    let delayMs: number;

    // Missed run detection: if nextRun is in the past, fire after a short delay.
    // Successive catch-up items in the same boot are staggered further out so
    // a batch of overdue items (e.g. after a stale-data reload) doesn't all
    // fire in the same instant.
    if (item.nextRun && item.nextRun < now) {
      const stagger = Math.min(this.catchUpCount * CATCHUP_STAGGER_STEP_MS, CATCHUP_STAGGER_MAX_MS);
      delayMs = CATCHUP_BASE_DELAY_MS + stagger;
      if (this.catchUpCount > 0) {
        console.warn(
          `[Scheduler] Catch-up fire #${this.catchUpCount + 1} for "${item.name}" (${item.id}): ` +
            `overdue by ${now - item.nextRun}ms, staggered to fire in ${delayMs}ms`
        );
      }
      this.catchUpCount++;
    } else if (item.nextRun && item.nextRun >= now) {
      delayMs = item.nextRun - now;
    } else {
      // No nextRun set yet — compute from scratch
      const next = computeNextRun(item);
      item.nextRun = next;
      this.options.saveItem({ ...item }).catch(console.error);
      delayMs = next - now;
    }

    if (
      delayMs > 0 &&
      item.nextRun &&
      item.nextRun >= now &&
      (item.schedule.type === 'daily' || item.schedule.type === 'weekly')
    ) {
      const task = cron.createTask(
        cronExpression(item.schedule),
        (context) => this.requestFire(item.id, context.date.getTime()).catch(console.error),
        { noOverlap: true },
      );
      task.on('execution:missed', () => {
        this.requestFire(item.id, Date.now()).catch(console.error);
      });
      task.start();
      this.calendarTasks.set(item.id, task);
      return;
    }

    const cappedDelay = Math.min(Math.max(0, delayMs), MAX_SCHEDULER_TIMEOUT_MS);
    const dueAt = item.nextRun ?? now + cappedDelay;
    const id = window.setTimeout(() => {
      this.requestFire(item.id, dueAt).catch(console.error);
    }, cappedDelay) as unknown as number;

    this.timers.set(item.id, id);
  }

  private cancelWakeSources(id: string): void {
    const existing = this.timers.get(id);
    if (existing !== undefined) {
      window.clearTimeout(existing);
      this.timers.delete(id);
    }
    const task = this.calendarTasks.get(id);
    if (task) {
      task.destroy();
      this.calendarTasks.delete(id);
    }
  }

  private async requestFire(id: string, _wakeAt: number): Promise<void> {
    const current = this.items.find((candidate) => candidate.id === id);
    if (!current || !current.enabled) return;
    if (!current.nextRun || Date.now() < current.nextRun) {
      this.armTimer(current);
      return;
    }
    await this.fire(current, current.nextRun);
  }

  // Internal: fire a scheduled item — create thread, update timestamps, rearm.
  private async fire(item: ScheduledItem, dueAt?: number): Promise<void> {
    const forceDirectFire = dueAt === undefined;
    dueAt ??= item.nextRun ?? Date.now();
    // Cheap reentrancy guard: two overlapping calls for the same item (e.g. two
    // timer callbacks racing within this single instance) must not both reach
    // thread creation. The second call short-circuits here; the first clears
    // its own entry in the finally below once it's done (success or failure).
    if (this.firing.has(item.id)) return;
    this.firing.add(item.id);

    try {
      this.cancelWakeSources(item.id);

      // Re-fetch the current item state in case it was updated while the timer was pending
      let current = this.items.find((i) => i.id === item.id);
      if (!current || !current.enabled) return;

      // Active-hours gate: a cycle that comes due outside the item's
      // configured local-time window is skipped entirely — no thread is
      // created, no message is sent, and lastRun is left untouched (nothing
      // actually ran). nextRun jumps straight to the next window-open time
      // rather than following the schedule's normal interval/daily math, so
      // e.g. an every-6h interval scoped to 07:00-22:00 resumes cleanly at
      // the next window open instead of retrying every interval through the
      // night only to be skipped each time. Placed before claimFire/thread
      // creation so a skipped cycle never contends for the fencing token.
      if (current.schedule.activeHours && !isWithinActiveHours(current.schedule, Date.now())) {
        try {
          const updated = await this.coordinator.update(current.id, (fresh) => {
            fresh.nextRun = nextTimeOfDay(fresh.schedule.activeHours!.start, Date.now());
            recordRunEvent(fresh, { ts: Date.now(), outcome: 'skipped-active-hours' });
            fresh.lastSkipReason = 'active-hours';
            return fresh;
          });
          current = this.replaceLocal(updated);
        } catch (err) {
          console.error(
            `[Scheduler] Failed to persist active-hours skip for "${current.name}" (${current.id}):`,
            err,
          );
        }
        this.armTimer(current);
        return;
      }

      // Captures a fire-path error message so the post-fire bookkeeping below can
      // record an 'error' run-history event. The inner catch already logs and
      // swallows the error (this method must not throw — it's fire-and-forget
      // from a setTimeout), so this is how the outcome survives to the history.
      let fireError: string | undefined;
      // Hoisted out of the inner try so the post-fire bookkeeping below (which
      // lives in the outer scope) can read it when recording the run-history
      // outcome — a gate skip is not a fire but still a completed cycle.
      let gateSkip = false;
      let claimToken: string | undefined;
      try {
        // Loop items target an existing thread; fall back to a new thread if it's gone.
        const reuseTarget =
          current.targetThreadId &&
          (this.options.threadExists?.(current.targetThreadId) ?? false)
            ? current.targetThreadId
            : undefined;

        if (reuseTarget && this.options.isThreadBusy?.(reuseTarget)) {
          // The thread's previous turn hasn't finished yet. Retry shortly
          // instead of sending — do not touch lastRun/nextRun or call
          // armTimer, since this isn't a completed cycle. Deliberately NOT
          // fenced by claimFire: this is a deferral of an already-claimed
          // cycle, not a new one, and skips the lastRun/rearm bookkeeping
          // that claimFire's fencing token (nextRun) is tied to.
          const retryMs = Math.min(15_000, (current.schedule.intervalSeconds ?? 60) * 1000);
          const retryItem = current;
          const id = window.setTimeout(() => {
            this.fire(retryItem).catch(console.error);
          }, retryMs) as unknown as number;
          this.timers.set(item.id, id);
          return;
        }

        // Overlap guard for new-thread jobs: an item that spawns a FRESH thread
        // each cycle must not stack a second run on top of one that is still in
        // flight. Without this, a job whose work outlasts its interval (a long
        // agent turn on a 15m schedule) accumulates concurrent threads that all
        // race on the same working directory and duplicate each other's
        // side effects — the failure this guard exists to prevent.
        //
        // Unlike the reuse path above, this SKIPS rather than retries. A retry
        // would merely defer the pile-up: the queue of deferred cycles grows for
        // as long as the item stays busy, then stampedes when it frees up. A
        // recurring job's contract is "run at the scheduled time", so the
        // correct response to "still busy" is to drop this occurrence and take
        // the next one on schedule.
        //
        // Placed before claimFire/thread creation (mirroring the active-hours
        // skip) so a skipped cycle never contends for the fencing token.
        // lastRun is left untouched because nothing actually ran; nextRun
        // advances normally so the item stays on its cadence.
        //
        // Fails OPEN by design: isThreadBusy is absent on older callers and
        // returns false for an unknown/archived thread, so an item whose
        // previous thread is gone fires normally. A scheduler that guessed
        // "busy" here would wedge the job permanently, which is strictly worse
        // than an occasional overlap.
        const priorThreadId = current.lastThreadId;
        if (
          !reuseTarget &&
          !current.isOrchestratorHeartbeat &&
          priorThreadId &&
          (this.options.isThreadBusy?.(priorThreadId) ?? false)
        ) {
          console.warn(
            `[Scheduler] Skipping cycle for "${current.name}" (${current.id}): ` +
              `previous run in thread ${priorThreadId} is still in flight.`,
          );
          try {
            const updated = await this.coordinator.update(current.id, (fresh) => {
              fresh.nextRun = computeNextRun(fresh, true);
              recordRunEvent(fresh, {
                ts: Date.now(),
                outcome: 'skipped-busy',
                threadId: priorThreadId,
              });
              fresh.lastSkipReason = 'busy';
              return fresh;
            });
            current = this.replaceLocal(updated);
          } catch (err) {
            console.error(
              `[Scheduler] Failed to persist busy skip for "${current.name}" (${current.id}):`,
              err,
            );
          }
          this.armTimer(current);
          return;
        }

        // Defense-in-depth fencing guard: lets a caller confirm (against fresh
        // on-disk state) that no other Scheduler instance has already claimed
        // this cycle before we create a thread. Placed here — after the
        // busy-retry check above — so the retry path above stays completely
        // untouched, and before any thread creation below.
        if (this.options.claimFire) {
          const claim = await this.options.claimFire(current);
          if (!claim.claimed) {
            // Someone else already claimed this cycle (or the item was
            // disabled/removed). Do not create a thread. Merge in whatever
            // fresh state we got and rearm against it so future cycles
            // aren't lost.
            if (claim.fresh) {
              await this.coordinator.adopt(claim.fresh);
              const idx = this.items.findIndex((i) => i.id === claim.fresh!.id);
              const merged = { ...claim.fresh };
              if (idx >= 0) {
                this.items[idx] = merged;
              } else {
                this.items.push(merged);
              }
              this.armTimer(merged);
            }
            return;
          }
        }

        const durableClaim = await this.coordinator.claim(
          current.id,
          dueAt,
          (fresh) => computeNextRun(fresh, true),
          forceDirectFire,
        );
        if (!durableClaim.claimed || !durableClaim.item?._scheduleClaimToken) {
          if (durableClaim.item) {
            current = this.replaceLocal(durableClaim.item);
            this.armTimer(current);
          }
          return;
        }
        current = this.replaceLocal(durableClaim.item);
        claimToken = current._scheduleClaimToken;

        // Deterministic pre-check gate: run the item's gate command (if any)
        // before creating a thread or sending a message, so cycles with
        // "nothing to do" are skipped without burning an agent turn. Placed
        // after claimFire so the gate runs at most once per cycle even in the
        // rare dual-instance reload race, and a skip reuses the normal
        // post-fire bookkeeping below. A skipped gate cycle IS a completed
        // cycle (the check ran), so lastRun/nextRun advance normally — which
        // also gives the next gate run a natural "since last check" cursor via
        // CRON_LAST_RUN_MS.
        let promptToSend = current.prompt;
        let effectiveCwd: string | undefined;
        if (current.gate?.command) {
          const gate = current.gate;
          if (!this.options.runGate) {
            // Gate can't be evaluated in this environment (e.g. mobile, or not
            // wired). Fail open: fire unconditionally rather than blackhole a
            // real cron. Clear any stale error from a prior desktop run.
            current.lastGateError = undefined;
          } else {
            // A target-thread fire only needs cwd for a gate. An explicit cwd
            // remains usable after Project deletion; without one, Project cwd
            // resolution deliberately fails clearly.
            effectiveCwd = this.getEffectiveCwd(current);
            const timeoutMs =
              Math.min(
                Math.max(gate.timeoutSeconds ?? GATE_DEFAULT_TIMEOUT_SECONDS, 1),
                GATE_MAX_TIMEOUT_SECONDS,
              ) * 1000;
            const gateEnvironment = this.options.getGateBaseEnv?.(current.projectId) ?? { env: {}, sensitiveValues: [] };
            const env: Record<string, string | undefined> = {
              ...gateEnvironment.env,
              CRON_LAST_RUN_MS: current.lastRun !== undefined ? String(current.lastRun) : '',
              CRON_ITEM_ID: current.id,
              CRON_ITEM_NAME: current.name,
            };
            const result = await this.options.runGate(gate.command, {
              cwd: effectiveCwd,
              timeoutMs,
              env,
              sensitiveValues: gateEnvironment.sensitiveValues,
            });

            if (result.timedOut || result.spawnError || result.exitCode === GATE_INDETERMINATE_EXIT_CODE) {
              // Could not evaluate the gate. Fail open by default so a broken
              // check never silently stops a real cron; failOpen:false opts
              // into fail-closed (skip) instead. Other clean non-zero exits are
              // handled below as deliberate skips.
              const reason = result.timedOut
                ? `Gate timed out after ${timeoutMs}ms`
                : result.spawnError
                  ? `Gate failed to run: ${result.spawnError}`
                  : `Gate indeterminate (exit ${GATE_INDETERMINATE_EXIT_CODE})`;
              current.lastGateError = result.stderr ? `${reason}\n${result.stderr}` : reason;
              current.lastGateExitCode = result.exitCode === GATE_INDETERMINATE_EXIT_CODE
                ? GATE_INDETERMINATE_EXIT_CODE
                : undefined;
              gateSkip = gate.failOpen === false;
            } else if (result.exitCode === 0) {
              // Fire: fold the gate's stdout into the prompt so the agent has
              // the context the check already gathered.
              current.lastGateExitCode = 0;
              current.lastGateError = undefined;
              promptToSend = interpolateGateOutput(current.prompt, result.stdout);
            } else {
              // Clean non-zero exit: a deliberate "nothing to do". Skip this
              // cycle regardless of failOpen.
              current.lastGateExitCode = result.exitCode ?? undefined;
              current.lastGateError = undefined;
              gateSkip = true;
            }
          }

          // Record why this cycle was (or wasn't) skipped for CronList
          // observability. On a fire, clear a stale 'gate' skip reason.
          if (gateSkip) current.lastSkipReason = 'gate';
          else if (current.lastSkipReason === 'gate') current.lastSkipReason = undefined;
        }

        if (!gateSkip) {
          // Async gates create a window in which the item can be disabled or
          // edited. Re-authorize the persisted claim immediately before the
          // first irreversible external effect.
          const authorization = await this.coordinator.authorize(current.id, claimToken!);
          if (!authorization.claimed) {
            const abandoned = await this.coordinator.abandon(current.id, claimToken!);
            if (abandoned) {
              current = this.replaceLocal(abandoned);
              this.armTimer(current);
            }
            return;
          }
          if (reuseTarget) {
            await this.options.sendMessage(reuseTarget, promptToSend);
            current.lastThreadId = reuseTarget;
          } else if (current.isOrchestratorHeartbeat) {
            // The orchestrator's own heartbeat backstop, but its target thread
            // no longer resolves (deleted/archived out from under it). Do NOT
            // fall back to creating a stray generic replacement thread — just
            // notify so the caller can prompt the user to recreate it. lastRun/
            // nextRun still advance below so this doesn't spin retrying every cycle.
            this.options.onOrchestratorHeartbeatStale?.(current);
          } else {
            // New-thread jobs must never create a thread associated with a
            // deleted Project, even when an explicit cwd is present.
            this.validateProject(current.projectId);
            effectiveCwd ??= this.getEffectiveCwd(current);
            const thread = this.options.createThread(current.name, effectiveCwd, current.projectId, current.id);
            await this.options.sendMessage(thread.id, promptToSend);
            current.lastThreadId = thread.id;
          }
          // A cycle that actually dispatched clears any stale skip reason left
          // by a previous cycle ('gate', 'active-hours' or 'busy'), so CronList
          // reports why the LAST cycle was skipped rather than stranding the
          // reason from whenever a skip last happened. The gate block above
          // already clears its own reason pre-dispatch; this also covers the
          // active-hours and busy paths, which previously had no clear at all.
          current.lastSkipReason = undefined;
        }
      } catch (err) {
        fireError = err instanceof Error ? err.message : String(err);
        console.error(`[Scheduler] Failed to fire scheduled item "${current.name}" (${current.id}):`, err);
      }

      if (!claimToken) {
        // A persistence/claim failure never authorizes an external dispatch.
        if (current.enabled) this.armTimer(current);
        return;
      }

      const completedAt = Date.now();
      const event: RunEvent = {
        ts: completedAt,
        outcome: fireError ? 'error' : gateSkip ? 'skipped-gate' : 'fired',
      };
      if (fireError) {
        event.note = fireError;
      } else if (gateSkip) {
        event.gateExitCode = current.lastGateExitCode;
        if (current.lastGateError) event.note = current.lastGateError;
      } else {
        if (current.lastThreadId) event.threadId = current.lastThreadId;
        if (current.lastGateError) {
          event.gateExitCode = current.lastGateExitCode;
          event.note = `fired open despite gate error: ${current.lastGateError}`;
        }
      }

      try {
        const currentId = current.id;
        const finalized = await this.coordinator.finalize(currentId, claimToken, {
          completedAt,
          event,
          lastThreadId: current.lastThreadId,
          lastSkipReason: current.lastSkipReason,
          lastGateExitCode: current.lastGateExitCode,
          lastGateError: current.lastGateError,
        });
        if (!finalized) {
          const idx = this.items.findIndex((candidate) => candidate.id === currentId);
          if (idx >= 0) this.items.splice(idx, 1);
          this.cancelWakeSources(currentId);
        } else {
          current = this.replaceLocal(finalized);
          this.armTimer(current);
        }
      } catch (err) {
        console.error(`[Scheduler] Failed to persist post-fire state for "${current.name}" (${current.id}):`, err);
      }
    } finally {
      this.firing.delete(item.id);
    }
  }

  // CRUD used by the Cron tools

  async createItem(params: Omit<ScheduledItem, 'id' | 'lastRun' | 'nextRun'>): Promise<ScheduledItem> {
    this.validateProject(params.projectId);
    const item: ScheduledItem = {
      ...params,
      id: crypto.randomUUID(),
      _scheduleRevision: 1,
    };

    // Compute the initial nextRun
    item.nextRun = computeNextRun(item);

    // Synchronous mutation happens before the first await, so non-awaiting
    // callers still observe the immediate in-memory/UI effects.
    this.items.push(item);

    if (item.enabled) {
      this.armTimer(item);
    }

    try {
      this.activateCoordinator();
      const persisted = await this.coordinator.create(item);
      this.replaceLocal(persisted);
    } catch (err) {
      console.error(`[Scheduler] Failed to persist new item "${item.name}" (${item.id}):`, err);
      throw err;
    }

    return this.publicCopy(this.getLocal(item.id)!);
  }

  async updateItem(id: string, patch: SchedulerItemPatch): Promise<ScheduledItem> {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx < 0) {
      throw new Error(`Scheduled item not found: ${id}`);
    }

    const existing = this.items[idx];
    if (patch.projectId) this.validateProject(patch.projectId);

    // Merge schedule sub-fields so callers can change just timeOfDay without
    // supplying the full ScheduledItemSchedule object.
    const mergedSchedule: ScheduledItemSchedule = patch.schedule
      ? { ...existing.schedule, ...patch.schedule }
      : existing.schedule;

    const { schedule: _schedulePatch, projectId: projectIdPatch, ...restPatch } = patch;
    const updated: ScheduledItem = { ...existing, ...restPatch, schedule: mergedSchedule };
    if (projectIdPatch === null) delete updated.projectId;
    else if (projectIdPatch !== undefined) updated.projectId = projectIdPatch;

    // If schedule or enabled changed, recompute nextRun
    const scheduleChanged =
      patch.schedule !== undefined ||
      patch.enabled !== undefined;

    if (scheduleChanged) {
      updated.nextRun = computeNextRun(updated, true);
    }

    // Synchronous mutation + rearm happens before the first await, so
    // non-awaiting callers still observe the immediate in-memory/UI effects.
    this.items[idx] = updated;

    // Rearm (armTimer handles cancelling existing and skipping if disabled)
    this.armTimer(updated);

    try {
      this.activateCoordinator();
      const persisted = await this.coordinator.update(id, (fresh) => {
        const freshSchedule: ScheduledItemSchedule = patch.schedule
          ? { ...fresh.schedule, ...patch.schedule }
          : fresh.schedule;
        const { schedule: _ignoredSchedule, projectId: freshProjectIdPatch, ...freshRestPatch } = patch;
        const merged: ScheduledItem = { ...fresh, ...freshRestPatch, schedule: freshSchedule };
        if (freshProjectIdPatch === null) delete merged.projectId;
        else if (freshProjectIdPatch !== undefined) merged.projectId = freshProjectIdPatch;
        if (scheduleChanged) merged.nextRun = computeNextRun(merged, true);
        return merged;
      });
      this.replaceLocal(persisted);
    } catch (err) {
      console.error(`[Scheduler] Failed to persist update to "${updated.name}" (${updated.id}):`, err);
      throw err;
    }

    return this.publicCopy(this.getLocal(id)!);
  }

  async deleteItem(id: string): Promise<void> {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx < 0) return;

    // Cancel timer
    this.cancelWakeSources(id);

    // Synchronous mutation happens before the first await.
    this.items.splice(idx, 1);

    try {
      this.activateCoordinator();
      await this.coordinator.delete(id);
    } catch (err) {
      console.error(`[Scheduler] Failed to persist deletion of item ${id}:`, err);
      throw err;
    }
  }

  async detachProject(projectId: string, effectiveCwd: string): Promise<void> {
    const removedIds = this.items.filter(item => item.projectId === projectId && item.isOrchestratorHeartbeat).map(item => item.id);
    const replacements = this.items
      .filter(item => !removedIds.includes(item.id))
      .map(item => item.projectId === projectId
        ? { ...item, cwd: item.cwd ?? effectiveCwd, projectId: undefined }
        : item);
    this.activateCoordinator();
    const persisted = await this.coordinator.replaceAll(replacements);
    for (const id of removedIds) this.cancelWakeSources(id);
    this.items = persisted;
    for (const item of this.items) this.armTimer(item);
  }

  listItems(): ScheduledItem[] {
    return this.items.map((i) => this.publicCopy(i));
  }

  getItem(id: string): ScheduledItem | undefined {
    const item = this.items.find((i) => i.id === id);
    return item ? this.publicCopy(item) : undefined;
  }

  private getLocal(id: string): ScheduledItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  private activateCoordinator(refresh = false): void {
    if (this.coordinatorRegistration && !refresh) return;
    this.coordinatorRegistration = this.coordinator.activate(
      this.items,
      {
        saveItem: this.options.saveItem,
        removeItem: this.options.removeItem,
        saveItems: this.options.saveItems,
      },
      this.coordinatorRegistration,
    );
  }

  private replaceLocal(item: ScheduledItem): ScheduledItem {
    const copy = { ...item, schedule: { ...item.schedule } };
    const index = this.items.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) this.items[index] = copy;
    else this.items.push(copy);
    return copy;
  }

  private publicCopy(item: ScheduledItem): ScheduledItem {
    const {
      _scheduleRevision: _revision,
      _scheduleClaimToken: _claimToken,
      _scheduleClaimDueAt: _claimDueAt,
      _scheduleClaimRevision: _claimRevision,
      ...publicItem
    } = item;
    return { ...publicItem, schedule: { ...publicItem.schedule } };
  }
}

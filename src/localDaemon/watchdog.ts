/**
 * Local daemon: the health watchdog. Polls a quick snapshot on a timer and, when a daemon that is supposed to be
 * running stops answering `/healthz` for several checks in a row, force-restarts it (the same stop, kill, end the VM
 * helper path as the Restart button). A wedged VM emits no event to react to, so a timer is the only option here.
 *
 * It never fights the user or itself: it only counts failures for a container that is up and unhealthy, skips while
 * any operation is running, backs off between attempts and gives up after a capped number of attempts per window.
 */

import type { LocalDaemonSnapshot } from './controller';

export interface WatchdogConfig {
  /** Time between health checks. */
  intervalMs: number;
  /** Consecutive failed checks before recovery starts. */
  failuresBeforeRecovery: number;
  /** Recovery attempts allowed per {@link windowMs}. */
  maxAttempts: number;
  windowMs: number;
  /** Wait after the first attempt before another may start; doubles with each attempt in the window. */
  backoffBaseMs: number;
  now: () => number;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  intervalMs: 30_000,
  failuresBeforeRecovery: 3,
  maxAttempts: 3,
  windowMs: 30 * 60_000,
  backoffBaseMs: 2 * 60_000,
  now: () => Date.now(),
};

export interface WatchdogState {
  status: 'watching' | 'recovering' | 'gave-up';
  consecutiveFailures: number;
  /** Recovery attempts made inside the current window. */
  attempts: number;
  maxAttempts: number;
  /** When the last automatic restart finished (epoch ms) and whether it completed. */
  lastRestartAt?: number;
  lastRestartOk?: boolean;
  lastError?: string;
}

/** What the watchdog needs from the controller; narrow so tests can drive it without containers. */
export interface WatchdogTarget {
  snapshot(opts: { quick: boolean }): Promise<LocalDaemonSnapshot>;
  restart(): Promise<unknown>;
  getBusy(): unknown;
}

export interface WatchdogDeps extends Partial<WatchdogConfig> {
  target: WatchdogTarget;
  /** False when the user switched it off or the daemon is not set up; re-read on every tick. */
  isEnabled(): boolean;
  onChange?(): void;
  log?(message: string): void;
}

export class LocalDaemonWatchdog {
  private readonly cfg: WatchdogConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private ticking = false;
  private failures = 0;
  private attemptTimes: number[] = [];
  private cooldownUntil = 0;
  private gaveUp = false;
  private recovering = false;
  private last: Pick<WatchdogState, 'lastRestartAt' | 'lastRestartOk' | 'lastError'> = {};

  constructor(private readonly deps: WatchdogDeps) {
    const { target: _t, isEnabled: _e, onChange: _c, log: _l, ...overrides } = deps;
    const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
    this.cfg = { ...DEFAULT_WATCHDOG_CONFIG, ...defined };
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, this.cfg.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Clears the timer; an in-flight check or restart finishes but acts on nothing afterwards. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getState(): WatchdogState {
    this.pruneAttempts();
    return {
      status: this.recovering ? 'recovering' : this.gaveUp ? 'gave-up' : 'watching',
      consecutiveFailures: this.failures,
      attempts: this.attemptTimes.length,
      maxAttempts: this.cfg.maxAttempts,
      ...this.last,
    };
  }

  private pruneAttempts(): void {
    const cutoff = this.cfg.now() - this.cfg.windowMs;
    this.attemptTimes = this.attemptTimes.filter((t) => t > cutoff);
  }

  private mayAct(): boolean {
    return !this.stopped && this.deps.isEnabled() && !this.deps.target.getBusy();
  }

  /** One health check. Public so tests can drive it without waiting on the timer. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      if (!this.deps.isEnabled()) { this.failures = 0; return; }
      // An operation in flight (including the user's own Stop or Restart) owns the container: do not count or act.
      if (this.deps.target.getBusy()) return;
      let snap: LocalDaemonSnapshot;
      try {
        snap = await this.deps.target.snapshot({ quick: true });
      } catch (err) {
        // The check itself failing says nothing about the daemon: neither count nor act.
        this.deps.log?.(`Local daemon watchdog: health check failed to run: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (this.stopped) return;
      const o = snap.observed;
      // Only a container that is up and not answering counts. Stopped, absent, not set up or runtime-down states are
      // either deliberate or someone else's job; a healthy answer resets everything.
      const wedged = !snap.busy && snap.assessment.status === 'degraded' && snap.assessment.degraded === 'health-down'
        && o.container === 'running' && o.health === 'down';
      if (!wedged) {
        const changed = this.failures !== 0 || (o.health === 'ok' && this.gaveUp);
        this.failures = 0;
        if (o.health === 'ok') this.gaveUp = false;
        if (changed) this.deps.onChange?.();
        return;
      }
      this.failures++;
      if (this.failures < this.cfg.failuresBeforeRecovery) return;
      this.pruneAttempts();
      if (this.attemptTimes.length >= this.cfg.maxAttempts) {
        if (!this.gaveUp) {
          this.gaveUp = true;
          this.deps.log?.(`Local daemon watchdog: giving up after ${this.attemptTimes.length} restart attempts`);
          this.deps.onChange?.();
        }
        return;
      }
      this.gaveUp = false;
      if (this.cfg.now() < this.cooldownUntil || !this.mayAct()) return;
      await this.recover();
    } finally {
      this.ticking = false;
    }
  }

  private async recover(): Promise<void> {
    this.attemptTimes.push(this.cfg.now());
    this.cooldownUntil = this.cfg.now() + this.cfg.backoffBaseMs * 2 ** (this.attemptTimes.length - 1);
    this.failures = 0;
    this.recovering = true;
    this.deps.log?.(`Local daemon watchdog: daemon stopped answering, restarting (attempt ${this.attemptTimes.length} of ${this.cfg.maxAttempts})`);
    this.deps.onChange?.();
    try {
      await this.deps.target.restart();
      this.last = { lastRestartAt: this.cfg.now(), lastRestartOk: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.last = { lastRestartAt: this.cfg.now(), lastRestartOk: false, lastError: message };
      this.deps.log?.(`Local daemon watchdog: restart failed: ${message}`);
    } finally {
      this.recovering = false;
      if (this.attemptTimes.length >= this.cfg.maxAttempts && this.last.lastRestartOk !== true) this.gaveUp = true;
      this.deps.onChange?.();
    }
  }
}

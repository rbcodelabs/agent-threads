/**
 * The in-daemon update loop. One timer ticks every `tickMs`; each tick:
 *   1. picks up an `update --apply` request (a bundle the operator installed, waiting for a restart),
 *   2. when auto-update is on and the check is due: look for a newer stable release and, if there is one, stage it
 *      (download, checksum, sanity check, swap) via `apply`,
 *   3. when a newer bundle is on disk: restart onto it, but only when the daemon is idle (`IdleGate`) or the request
 *      said `now`. A turn is never interrupted; while busy the loop just keeps looking on its short tick.
 *
 * A restart is `onRestart` (the CLI shuts the daemon down and exits 75, non-zero on purpose: the units use
 * `Restart=on-failure`, which does not restart a clean exit 0). Failures leave the running bundle untouched and back
 * off. Everything outside (network, clock, filesystem effects, the restart itself) is injected.
 */
import { isMajorBump, isNewerVersion } from './semver';
import { UpdateError, UpdateHeld, type LatestRelease, type ReleaseSource } from './release';
import type { Applied } from './apply';
import type { InstallAssessment } from './install';
import { IdleGate, type ActivitySource } from './idle';
import { patchState, readState, takeRequest, withUpdateLock, writeStatus, type UpdatePhase, type UpdateStatus } from './state';

export interface AutoUpdaterOptions {
  dataDir: string;
  currentVersion: string;
  /** Operator opted in to automatic checks. Without it the updater only honours `update --apply` requests. */
  enabled: boolean;
  assessment: InstallAssessment;
  intervalMs: number;
  quietMs: number;
  tickMs?: number;
  /** Delay before the first check after start. */
  initialDelayMs?: number;
  /** First retry delay after a failure; doubles up to `intervalMs`. */
  retryBaseMs?: number;
  releases: ReleaseSource;
  apply: (release: LatestRelease) => Promise<Applied>;
  activity: ActivitySource;
  now?: () => number;
  log: (line: string) => void;
  audit: (record: Record<string, unknown>) => void;
  onRestart: (info: { to: string }) => void;
}

interface Pending { to: string; now: boolean }

export class AutoUpdater {
  private readonly now: () => number;
  private readonly gate: IdleGate;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private ticking = false;
  private pending: Pending | null = null;
  private phase: UpdatePhase;
  private nextCheckAt: number;
  private failures = 0;
  private latestVersion: string | undefined;
  private lastCheckAt: number | undefined;
  private lastError: string | undefined;
  private waiting: UpdateStatus['waiting'];
  private lastWritten = '';
  private readonly tickMs: number;
  private readonly retryBase: number;

  constructor(private readonly o: AutoUpdaterOptions) {
    this.now = o.now ?? (() => Date.now());
    this.gate = new IdleGate(o.activity, o.quietMs, this.now);
    this.tickMs = o.tickMs ?? 15_000;
    this.retryBase = o.retryBaseMs ?? 60_000;
    this.nextCheckAt = this.now() + (o.initialDelayMs ?? 60_000);
    this.phase = !o.assessment.available ? 'unavailable' : o.enabled ? 'idle' : 'off';
  }

  /** Will this daemon apply updates by itself? (Advertised as the `update.auto` capability.) */
  get autoEnabled(): boolean { return this.o.enabled && this.o.assessment.available; }
  get currentPhase(): UpdatePhase { return this.phase; }
  get pendingVersion(): string | undefined { return this.pending?.to; }

  start(): void {
    const { assessment } = this.o;
    if (!assessment.available) {
      if (this.o.enabled) this.o.log(`auto-update is on but unavailable here: ${assessment.reason ?? 'unknown reason'}`);
    } else if (this.o.enabled) {
      const u = assessment.unit;
      this.o.log(`auto-update on: checking every ${Math.round(this.o.intervalMs / 60_000)} min, restarting after ${Math.round(this.o.quietMs / 60_000)} min of quiet${u ? ` (supervised by ${u.name}, Restart=${u.restart})` : ''}`);
    }
    this.writeStatus();
    if (!assessment.available || this.stopped) return;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.tick(); }, this.tickMs);
    this.timer.unref?.();
  }

  /** One pass of the loop; public so tests (and a future "check now") can drive it. */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      this.consumeRequest();
      if (!this.pending && this.o.enabled && this.now() >= this.nextCheckAt) await this.check();
      if (this.pending && !this.stopped) this.maybeRestart();
    } catch (err) {
      this.fail('check', err);
    } finally {
      this.ticking = false;
      this.writeStatus();
      if (!this.stopped) this.schedule();
    }
  }

  private consumeRequest(): void {
    const req = takeRequest(this.o.dataDir);
    if (!req) return;
    if (!isNewerVersion(req.version, this.o.currentVersion)) {
      this.o.log(`ignoring update request for ${req.version}: not newer than ${this.o.currentVersion}`);
      return;
    }
    this.pending = { to: req.version, now: req.now };
    this.o.audit({ event: 'update_requested', to: req.version, now: req.now });
    this.o.log(`update to ${req.version} requested${req.now ? ' (restart now)' : '; will restart when idle'}`);
  }

  private async check(): Promise<void> {
    this.phase = 'checking';
    let release: LatestRelease | null;
    try {
      release = await this.o.releases.latest();
    } catch (err) {
      this.fail('check', err);
      return;
    }
    this.lastCheckAt = this.now();
    this.failures = 0;
    this.lastError = undefined;
    this.nextCheckAt = this.now() + this.o.intervalMs;
    this.latestVersion = release?.version;
    this.o.audit({ event: 'update_check', current: this.o.currentVersion, latest: release?.version ?? null });
    if (!release || !isNewerVersion(release.version, this.o.currentVersion)) {
      this.phase = 'up_to_date';
      return;
    }
    const state = readState(this.o.dataDir);
    if (state.rolledBack && state.rolledBack.from === release.version) {
      this.phase = 'paused_after_rollback';
      return;
    }
    if (state.rolledBack) patchState(this.o.dataDir, (s) => ({ ...s, rolledBack: undefined }));
    if (state.held?.version === release.version) {
      this.phase = 'held';
      return;
    }
    if (isMajorBump(release.version, this.o.currentVersion)) {
      this.hold(release.version, `${release.version} is a new major version; not applied automatically. Upgrade by hand after reading the release notes`);
      return;
    }
    this.phase = 'downloading';
    this.writeStatus();
    const outcome = await withUpdateLock(this.o.dataDir, async () => {
      try {
        const applied = await this.o.apply(release!);
        this.o.audit({ event: 'update_apply', from: applied.from, to: applied.to, prev: applied.prevPath });
        this.pending = { to: applied.to, now: false };
        return true;
      } catch (err) {
        if (err instanceof UpdateHeld) this.hold(err.version, err.reason);
        else this.fail(err instanceof UpdateError ? err.stage : 'apply', err);
        return false;
      }
    }, this.now);
    if (outcome === null) {
      this.phase = 'idle';
      this.nextCheckAt = this.now() + this.retryBase;
    }
  }

  private hold(version: string, reason: string): void {
    patchState(this.o.dataDir, (s) => ({ ...s, held: { version, reason, at: this.now() } }));
    this.phase = 'held';
    this.lastError = reason;
    this.o.log(`auto-update: ${reason}`);
    this.o.audit({ event: 'update_held', version, reason });
  }

  private fail(stage: string, err: unknown): void {
    this.failures++;
    const message = err instanceof Error ? err.message : String(err);
    const retryAfter = err instanceof UpdateError ? err.retryAfterMs : undefined;
    const backoff = Math.min(this.o.intervalMs, this.retryBase * 2 ** (this.failures - 1));
    this.nextCheckAt = this.now() + Math.max(backoff, retryAfter ?? 0);
    this.phase = 'error';
    this.lastError = `${stage}: ${message}`;
    this.o.log(`auto-update ${stage} failed (retry in ${Math.round((this.nextCheckAt - this.now()) / 1000)}s): ${message}`);
    this.o.audit({ event: 'update_failed', stage, error: message, failures: this.failures });
  }

  private maybeRestart(): void {
    const pending = this.pending!;
    if (!pending.now) {
      const verdict = this.gate.evaluate();
      this.phase = 'waiting_for_idle';
      this.waiting = { busyThreads: verdict.busyThreads, quietRemainingMs: verdict.quietRemainingMs };
      if (!verdict.idle) return;
    }
    this.phase = 'restarting';
    this.waiting = undefined;
    this.stop();
    this.o.log(`restarting to run ${pending.to}`);
    this.o.audit({ event: 'update_restart', from: this.o.currentVersion, to: pending.to, forced: pending.now });
    this.writeStatus();
    this.o.onRestart({ to: pending.to });
  }

  status(): UpdateStatus {
    const a = this.o.assessment;
    return {
      pid: process.pid,
      version: this.o.currentVersion,
      enabled: this.o.enabled,
      available: a.available,
      ...(a.reason ? { reason: a.reason } : {}),
      phase: this.phase,
      intervalMinutes: Math.round(this.o.intervalMs / 60_000),
      quietMinutes: Math.round(this.o.quietMs / 60_000),
      ...(this.latestVersion ? { latestVersion: this.latestVersion } : {}),
      ...(this.lastCheckAt ? { lastCheckAt: this.lastCheckAt } : {}),
      ...(this.o.enabled && a.available && !this.pending ? { nextCheckAt: this.nextCheckAt } : {}),
      ...(this.pending ? { pendingVersion: this.pending.to } : {}),
      ...(this.waiting ? { waiting: this.waiting } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      updatedAt: this.now(),
    };
  }

  private writeStatus(): void {
    const status = this.status();
    const key = JSON.stringify({ ...status, updatedAt: 0, waiting: status.waiting ? { b: status.waiting.busyThreads } : undefined });
    if (key === this.lastWritten) return;
    this.lastWritten = key;
    try { writeStatus(this.o.dataDir, status); } catch { /* the status file is a convenience */ }
  }
}

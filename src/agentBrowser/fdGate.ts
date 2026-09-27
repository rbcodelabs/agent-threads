/**
 * File-descriptor admission gate.
 *
 * Geode already measures FD pressure — `probeFdPressure()` in
 * `src/main/crash-diagnostics.ts`, surfaced to the renderer as
 * `window.geode.getFdPressure` — but only ever reports it. Nothing has gated on
 * it, which is why the failure it predicts shows up as an unexplained crash
 * rather than a refusal.
 *
 * That failure is specific and documented: a `<webview>` guest is the only
 * sandboxed renderer in Geode, it needs a spare descriptor at launch to receive
 * its seatbelt policy, and without one it dies as a bare "crashed (exit code 6)"
 * (see Geode's `src/renderer/views/web-view-crash-message.ts`). Spawning a guest
 * under pressure is therefore not merely risky, it is the known way to produce
 * the crash this feature exists to stop.
 *
 * The probe is injected rather than read off `window` so the hysteresis can be
 * tested without a host.
 */

import {
  FD_GREEN,
  FD_PROBE_CACHE_MS,
  FD_RED,
} from './agentBrowserPolicy';

/** Mirrors Geode's `FdPressureSnapshot`. `ratio` is null when the limit is unknown. */
export interface FdPressureSnapshot {
  openFileDescriptors: number | null;
  limit: number | null;
  ratio: number | null;
  underPressure: boolean;
  exhausted: boolean;
}

export type FdProbe = () => Promise<FdPressureSnapshot>;

export type FdVerdict =
  /** Safe to create a guest. `snapshot` is null when no probe is available. */
  | { kind: 'allow'; snapshot: FdPressureSnapshot | null }
  /** Near the limit. Refuse new guests and reap idle ones. */
  | { kind: 'deny-pressure'; reason: string; snapshot: FdPressureSnapshot }
  /** At the limit. Refuse new guests and destroy every existing one. */
  | { kind: 'deny-exhausted'; reason: string; snapshot: FdPressureSnapshot };

/** Human-readable explanation reused in tool errors and Notices. */
export const FD_CRASH_HINT =
  'This process is low on file handles, so a sandboxed page process cannot start. ' +
  'Close some browser sessions, or restart Geode, and try again.';

export class FdGate {
  private probe: FdProbe | null;
  private cached: { at: number; snapshot: FdPressureSnapshot } | null = null;
  /**
   * True once pressure crossed RED, and stays true until it falls below GREEN.
   *
   * Without this latch a single threshold flaps: admit at 0.849, the new guest
   * pushes the ratio to 0.86, the guest is reaped, the ratio drops, admit again.
   * That loop churns descriptors faster than the leak it is meant to prevent.
   */
  private blocked = false;
  private readonly now: () => number;

  constructor(probe: FdProbe | null, now: () => number = Date.now) {
    this.probe = probe;
    this.now = now;
  }

  /** True when the host exposes an FD probe at all (Geode desktop only). */
  get available(): boolean {
    return this.probe !== null;
  }

  /** Test seam: drop the cache so the next evaluate() re-probes. */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * Read pressure, reusing a reading younger than `FD_PROBE_CACHE_MS`.
   * A probe that throws is treated as no reading rather than as pressure: the
   * gate must never become the reason the feature stops working.
   */
  private async read(): Promise<FdPressureSnapshot | null> {
    if (!this.probe) return null;
    const cached = this.cached;
    if (cached && this.now() - cached.at < FD_PROBE_CACHE_MS) return cached.snapshot;
    try {
      const snapshot = await this.probe();
      this.cached = { at: this.now(), snapshot };
      return snapshot;
    } catch {
      return null;
    }
  }

  /**
   * Decide whether a new guest may be created.
   *
   * Callers must treat `deny-exhausted` as an instruction to destroy every
   * existing agent guest, not merely to refuse a new one. The agent's browser is
   * discretionary; the user's editor and Web Viewer are not, so when descriptors
   * run out the discretionary processes are the ones that go.
   */
  async evaluate(): Promise<FdVerdict> {
    const snapshot = await this.read();
    if (!snapshot) return { kind: 'allow', snapshot: null };

    if (snapshot.exhausted) {
      this.blocked = true;
      return {
        kind: 'deny-exhausted',
        reason: `The process is out of file handles. ${FD_CRASH_HINT}`,
        snapshot,
      };
    }

    const { ratio } = snapshot;
    // A null ratio means the limit could not be determined, so there is nothing
    // to compare against. Fall back to the host's own boolean.
    if (ratio === null) {
      if (snapshot.underPressure) {
        this.blocked = true;
        return {
          kind: 'deny-pressure',
          reason: `The process is low on file handles. ${FD_CRASH_HINT}`,
          snapshot,
        };
      }
      this.blocked = false;
      return { kind: 'allow', snapshot };
    }

    if (this.blocked) {
      // Latched: stay closed until pressure clears the lower mark.
      if (ratio >= FD_GREEN) {
        return {
          kind: 'deny-pressure',
          reason:
            `File-handle use is still elevated (${formatRatio(ratio)}). ${FD_CRASH_HINT}`,
          snapshot,
        };
      }
      this.blocked = false;
      return { kind: 'allow', snapshot };
    }

    if (ratio >= FD_RED) {
      this.blocked = true;
      return {
        kind: 'deny-pressure',
        reason: `File-handle use is at ${formatRatio(ratio)}. ${FD_CRASH_HINT}`,
        snapshot,
      };
    }

    return { kind: 'allow', snapshot };
  }

  /** Current latch state, for status reporting. */
  get isBlocked(): boolean {
    return this.blocked;
  }
}

function formatRatio(ratio: number): string {
  return `${Math.round(ratio * 100)}% of the limit`;
}

/**
 * Build a gate from a host window, or a probe-less gate when the host does not
 * expose diagnostics. Geode's non-Electron hosts stub `getFdPressure` out
 * entirely (`legacy-facade.ts` throws `unavailable("processDiagnostics")`), and
 * Obsidian has no equivalent at all.
 */
export function createFdGate(hostWindow: unknown, now: () => number = Date.now): FdGate {
  const probe = readProbe(hostWindow);
  return new FdGate(probe, now);
}

function readProbe(hostWindow: unknown): FdProbe | null {
  if (!hostWindow || typeof hostWindow !== 'object') return null;
  const geode = (hostWindow as { geode?: unknown }).geode;
  if (!geode || typeof geode !== 'object') return null;
  const probe = (geode as { getFdPressure?: unknown }).getFdPressure;
  if (typeof probe !== 'function') return null;
  return () => Promise.resolve((probe as FdProbe).call(geode));
}

/**
 * Boot guard for a freshly installed bundle.
 *
 * `applyUpdate` leaves a `pendingUpgrade` marker. The new version, at start (after its config resolved, before it
 * serves), counts itself in; when it stays up and listening for `healthyAfterMs` the marker is cleared. If it
 * dies before that twice, the third start restores the saved `.prev` bundle instead of starting, records the
 * rollback (which pauses auto-update until a different release appears) and asks to be restarted.
 *
 * Limit, stated plainly: the guard is part of the new bundle, so it cannot catch a bundle that fails before
 * its first lines run. The sanity check (`--version`) before the swap is what covers a bundle that does not load.
 * Only one level of rollback exists: the bundle that was running before the upgrade.
 */
import { existsSync, renameSync } from 'node:fs';
import { patchState, readState, type PendingUpgrade } from './state';

/** Starts of the new version that may end before healthy; the next start rolls back. */
export const MAX_FAILED_BOOTS = 2;
export const HEALTHY_AFTER_MS = 60_000;

export interface GuardDeps {
  dataDir: string;
  currentVersion: string;
  /** The running bundle; rollback only acts when it is the one the marker names. */
  bundlePath: string | undefined;
  now?: () => number;
  log: (line: string) => void;
  audit: (record: Record<string, unknown>) => void;
}

export type BootDecision =
  | { action: 'proceed'; watch: PendingUpgrade | null }
  | { action: 'rolled_back'; from: string; to: string };

export function evaluateBoot(d: GuardDeps): BootDecision {
  const now = d.now ?? (() => Date.now());
  const state = readState(d.dataDir);
  const marker = state.pendingUpgrade;
  if (!marker) return { action: 'proceed', watch: null };
  if (marker.to !== d.currentVersion) {
    // Still the old version (the swap happened, the restart has not): leave the marker for the next start.
    if (marker.from === d.currentVersion) return { action: 'proceed', watch: null };
    // Neither: someone installed another version by hand. The marker is stale.
    patchState(d.dataDir, (s) => ({ ...s, pendingUpgrade: undefined }));
    return { action: 'proceed', watch: null };
  }
  if (marker.boots < MAX_FAILED_BOOTS) {
    const next = { ...marker, boots: marker.boots + 1 };
    patchState(d.dataDir, (s) => ({ ...s, pendingUpgrade: next }));
    return { action: 'proceed', watch: next };
  }

  // The new version has failed to become healthy MAX_FAILED_BOOTS times: put the previous bundle back.
  const canRollBack = !!d.bundlePath && d.bundlePath === marker.bundlePath && existsSync(marker.prevPath);
  const record = { from: marker.to, to: marker.from, boots: marker.boots };
  if (canRollBack) {
    try {
      renameSync(marker.prevPath, marker.bundlePath);
      patchState(d.dataDir, (s) => ({ ...s, pendingUpgrade: undefined, rolledBack: { from: marker.to, to: marker.from, at: now() } }));
      d.log(`auto-update: ${marker.to} did not become healthy in ${marker.boots} starts; rolled back to ${marker.from}. Auto-update is paused until a release other than ${marker.to} is published.`);
      d.audit({ event: 'update_rollback', ...record, ok: true });
      return { action: 'rolled_back', from: marker.to, to: marker.from };
    } catch (err) {
      d.log(`auto-update: rollback to ${marker.from} failed: ${err instanceof Error ? err.message : String(err)}`);
      d.audit({ event: 'update_rollback', ...record, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  } else {
    d.log(`auto-update: ${marker.to} did not become healthy ${marker.boots} times and the previous bundle (${marker.prevPath}) cannot be restored from here; leaving ${marker.to} in place. Auto-update is paused.`);
    d.audit({ event: 'update_rollback', ...record, ok: false, error: 'previous bundle unavailable' });
  }
  patchState(d.dataDir, (s) => ({ ...s, pendingUpgrade: undefined, rolledBack: { from: marker.to, to: marker.from, at: now() } }));
  return { action: 'proceed', watch: null };
}

export interface HealthWatch {
  /** `startDaemon` returned: the daemon is listening. */
  listening(): void;
  dispose(): void;
}

/**
 * Arms the health deadline for a marked start. At `healthyAfterMs` a listening daemon clears the marker; a daemon that
 * is still starting calls `onWedged` (the CLI exits non-zero so the supervisor restarts it and the boot counts).
 */
export function watchHealth(d: GuardDeps, marker: PendingUpgrade, onWedged: () => void, healthyAfterMs: number = HEALTHY_AFTER_MS): HealthWatch {
  let up = false;
  const timer = setTimeout(() => {
    if (!up) {
      d.log(`auto-update: ${marker.to} had not finished starting after ${Math.round(healthyAfterMs / 1000)}s; exiting so it is restarted (and rolled back if this repeats)`);
      d.audit({ event: 'update_unhealthy', to: marker.to, boots: marker.boots });
      onWedged();
      return;
    }
    patchState(d.dataDir, (s) => (s.pendingUpgrade?.to === marker.to ? { ...s, pendingUpgrade: undefined } : s));
    d.log(`auto-update: ${marker.to} is healthy; upgrade from ${marker.from} confirmed`);
    d.audit({ event: 'update_healthy', from: marker.from, to: marker.to });
  }, healthyAfterMs);
  timer.unref?.();
  return { listening() { up = true; }, dispose() { clearTimeout(timer); } };
}

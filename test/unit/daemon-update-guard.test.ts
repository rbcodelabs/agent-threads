import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateBoot, watchHealth, MAX_FAILED_BOOTS } from '../../daemon/update/guard';
import { readState, writeState } from '../../daemon/update/state';

let dir: string;
let bundle: string;
let prev: string;
const logs: string[] = [];
const audits: Array<Record<string, unknown>> = [];
const deps = (version: string, bundlePath: string | undefined = bundle) => ({
  dataDir: dir, currentVersion: version, bundlePath, log: (l: string) => logs.push(l), audit: (r: Record<string, unknown>) => audits.push(r), now: () => 1234,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'at-guard-'));
  bundle = join(dir, 'agent-threads.cjs');
  prev = `${bundle}.prev-0.68.2`;
  writeFileSync(bundle, 'NEW');
  writeFileSync(prev, 'OLD');
  writeState(dir, { pendingUpgrade: { from: '0.68.2', to: '0.68.3', prevPath: prev, bundlePath: bundle, appliedAt: 1, boots: 0 } });
  logs.length = 0;
  audits.length = 0;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

describe('evaluateBoot', () => {
  it('does nothing without a marker', () => {
    writeState(dir, {});
    expect(evaluateBoot(deps('0.68.3'))).toEqual({ action: 'proceed', watch: null });
  });
  it('leaves the marker alone while the OLD version is still the one running', () => {
    expect(evaluateBoot(deps('0.68.2'))).toEqual({ action: 'proceed', watch: null });
    expect(readState(dir).pendingUpgrade?.boots).toBe(0);
  });
  it('drops a stale marker when some other version runs', () => {
    expect(evaluateBoot(deps('0.70.0')).action).toBe('proceed');
    expect(readState(dir).pendingUpgrade).toBeUndefined();
  });
  it('counts each start of the new version and rolls back on the third', () => {
    for (let boot = 1; boot <= MAX_FAILED_BOOTS; boot++) {
      const d = evaluateBoot(deps('0.68.3'));
      expect(d.action).toBe('proceed');
      expect(readState(dir).pendingUpgrade?.boots).toBe(boot);
    }
    const third = evaluateBoot(deps('0.68.3'));
    expect(third).toEqual({ action: 'rolled_back', from: '0.68.3', to: '0.68.2' });
    expect(readFileSync(bundle, 'utf8')).toBe('OLD');
    expect(existsSync(prev)).toBe(false);
    const s = readState(dir);
    expect(s.pendingUpgrade).toBeUndefined();
    expect(s.rolledBack).toEqual({ from: '0.68.3', to: '0.68.2', at: 1234 });
    expect(logs.join('\n')).toMatch(/rolled back to 0.68.2.*paused/);
    expect(audits).toContainEqual(expect.objectContaining({ event: 'update_rollback', from: '0.68.3', to: '0.68.2', ok: true }));
  });
  it('without the previous bundle it cannot roll back: logs, pauses auto-update, keeps serving', () => {
    rmSync(prev);
    writeState(dir, { pendingUpgrade: { ...readState(dir).pendingUpgrade!, boots: MAX_FAILED_BOOTS } });
    expect(evaluateBoot(deps('0.68.3'))).toEqual({ action: 'proceed', watch: null });
    expect(readFileSync(bundle, 'utf8')).toBe('NEW');
    expect(readState(dir).rolledBack?.from).toBe('0.68.3');
    expect(logs.join('\n')).toMatch(/cannot be restored/);
    expect(audits).toContainEqual(expect.objectContaining({ event: 'update_rollback', ok: false }));
  });
  it('never swaps a file other than the bundle the marker names', () => {
    writeState(dir, { pendingUpgrade: { ...readState(dir).pendingUpgrade!, boots: MAX_FAILED_BOOTS } });
    expect(evaluateBoot(deps('0.68.3', join(dir, 'elsewhere.cjs'))).action).toBe('proceed');
    expect(readFileSync(bundle, 'utf8')).toBe('NEW');
  });
});

describe('watchHealth', () => {
  it('clears the marker once the daemon has been listening long enough', () => {
    vi.useFakeTimers();
    const w = evaluateBoot(deps('0.68.3')) as { watch: any };
    const wedged = vi.fn();
    const h = watchHealth(deps('0.68.3'), w.watch, wedged, 1000);
    h.listening();
    vi.advanceTimersByTime(1001);
    expect(readState(dir).pendingUpgrade).toBeUndefined();
    expect(wedged).not.toHaveBeenCalled();
    expect(audits).toContainEqual(expect.objectContaining({ event: 'update_healthy' }));
  });
  it('a start that never finishes calls onWedged and keeps the marker (so the boot counts)', () => {
    vi.useFakeTimers();
    const w = evaluateBoot(deps('0.68.3')) as { watch: any };
    const wedged = vi.fn();
    watchHealth(deps('0.68.3'), w.watch, wedged, 1000);
    vi.advanceTimersByTime(1001);
    expect(wedged).toHaveBeenCalledOnce();
    expect(readState(dir).pendingUpgrade?.boots).toBe(1);
  });
  it('dispose cancels the deadline', () => {
    vi.useFakeTimers();
    const w = evaluateBoot(deps('0.68.3')) as { watch: any };
    const wedged = vi.fn();
    watchHealth(deps('0.68.3'), w.watch, wedged, 1000).dispose();
    vi.advanceTimersByTime(5000);
    expect(wedged).not.toHaveBeenCalled();
  });
});

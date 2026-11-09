import { describe, it, expect } from 'vitest';
import { deriveDockState, type DockStateInput } from '../../src/orchestratorDockModel';

const base: DockStateInput = { orchestratorId: 'o', thread: {}, isRunning: false, daemon: undefined, needsYouCount: 0, hasUnreadReply: false };
const d = (p: Partial<DockStateInput>) => deriveDockState({ ...base, ...p });

describe('S3 deriveDockState', () => {
  it('none: no id, or stale id (thread deleted)', () => {
    expect(d({ orchestratorId: undefined })).toBe('none');
    expect(d({ thread: undefined })).toBe('none');
  });
  it('idle / working / attention', () => {
    expect(d({})).toBe('idle');
    expect(d({ isRunning: true })).toBe('working');
    expect(d({ needsYouCount: 2 })).toBe('attention');
    expect(d({ hasUnreadReply: true })).toBe('attention');
  });
  it('error: lastError | authRequired | status=error when not running; clears while running (next send clears lastError)', () => {
    expect(d({ thread: { lastError: 'boom' } })).toBe('error');
    expect(d({ thread: { authRequired: { message: 'm', at: 1 } } })).toBe('error');
    expect(d({ thread: { status: 'error' } })).toBe('error');
    expect(d({ thread: { lastError: 'boom' }, isRunning: true })).toBe('working');
  });
  it('offline: remote daemon down; transient states are not offline', () => {
    const remote = { daemonId: 'x' };
    for (const status of ['unreachable', 'closed', 'incompatible', 'unauthorized'] as const)
      expect(d({ thread: { remote }, daemon: { status, attempt: 1 } })).toBe('offline');
    for (const status of ['connecting', 'reconnecting', 'idle', 'connected'] as const)
      expect(d({ thread: { remote }, daemon: { status, attempt: 0 } })).toBe('idle');
    // local thread ignores daemon state
    expect(d({ daemon: { status: 'unreachable', attempt: 1 } })).toBe('idle');
  });
  it('offline outranks error; error outranks attention', () => {
    expect(d({ thread: { remote: { daemonId: 'x' }, lastError: 'e' }, daemon: { status: 'unreachable', attempt: 1 } })).toBe('offline');
    expect(d({ thread: { lastError: 'e' }, needsYouCount: 3 })).toBe('error');
  });
});

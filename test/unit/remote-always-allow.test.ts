import { describe, it, expect } from 'vitest';
import {
  normalizeRemoteAlwaysAllowed,
  addRemoteAlwaysAllow,
  removeRemoteAlwaysAllow,
  isPermissionPreApprovedForThread,
  alwaysAllowScopeFor,
  recordAlwaysAllow,
  type AlwaysAllowSettings,
} from '../../src/remoteAlwaysAllow';

const settings = (over: Partial<AlwaysAllowSettings> = {}): AlwaysAllowSettings => ({
  alwaysAllowedTools: [],
  remoteAlwaysAllowedTools: {},
  ...over,
});

describe('remote always-allow, per daemon', () => {
  it('approves only for the daemon the tool was allowed on', () => {
    const s = settings();
    expect(addRemoteAlwaysAllow(s, 'box', 'mcp__x__read')).toBe(true);
    expect(isPermissionPreApprovedForThread('mcp__x__read', { daemonId: 'box' }, s)).toBe(true);
    expect(isPermissionPreApprovedForThread('mcp__x__read', { daemonId: 'other' }, s)).toBe(false);
    expect(isPermissionPreApprovedForThread('mcp__x__read', undefined, s)).toBe(false);
  });

  it('a remote entry never approves a local thread', () => {
    const s = settings({ remoteAlwaysAllowedTools: { box: ['mcp__x__read'] } });
    expect(isPermissionPreApprovedForThread('mcp__x__read', undefined, s)).toBe(false);
  });

  it('the local list and trusted built-ins never approve a remote thread', () => {
    const s = settings({ alwaysAllowedTools: ['mcp__x__read'] });
    expect(isPermissionPreApprovedForThread('mcp__x__read', { daemonId: 'box' }, s)).toBe(false);
    expect(isPermissionPreApprovedForThread('mcp__claude_threads__threads_list', { daemonId: 'box' }, s)).toBe(false);
  });

  it('local threads still use the local list', () => {
    const s = settings({ alwaysAllowedTools: ['mcp__x__read'] });
    expect(isPermissionPreApprovedForThread('mcp__x__read', undefined, s)).toBe(true);
  });

  it('host_exec and sync_resolve_conflict are never approvable, even if stored', () => {
    const s = settings({ remoteAlwaysAllowedTools: { box: ['host_exec', 'mcp__claude_threads__host_exec', 'sync_resolve_conflict'] } });
    for (const t of ['host_exec', 'mcp__claude_threads__host_exec', 'sync_resolve_conflict']) {
      expect(isPermissionPreApprovedForThread(t, { daemonId: 'box' }, s)).toBe(false);
      expect(addRemoteAlwaysAllow(s, 'box', t)).toBe(false);
    }
  });

  it('add is idempotent and remove drops empty daemons', () => {
    const s = settings();
    expect(addRemoteAlwaysAllow(s, 'box', 'a')).toBe(true);
    expect(addRemoteAlwaysAllow(s, 'box', 'a')).toBe(false);
    expect(removeRemoteAlwaysAllow(s, 'box', 'a')).toBe(true);
    expect(s.remoteAlwaysAllowedTools).toEqual({});
    expect(removeRemoteAlwaysAllow(s, 'box', 'a')).toBe(false);
  });

  it('recordAlwaysAllow stores under the thread scope and reports change', () => {
    const s = settings();
    expect(alwaysAllowScopeFor({ daemonId: 'box' })).toEqual({ daemonId: 'box' });
    expect(alwaysAllowScopeFor(undefined)).toBeNull();
    expect(recordAlwaysAllow(s, 'a', { daemonId: 'box' })).toBe(true);
    expect(s.remoteAlwaysAllowedTools).toEqual({ box: ['a'] });
    expect(s.alwaysAllowedTools).toEqual([]);
    expect(recordAlwaysAllow(s, 'b', undefined)).toBe(true);
    expect(s.alwaysAllowedTools).toEqual(['b']);
    expect(recordAlwaysAllow(s, 'b', undefined)).toBe(false);
    expect(recordAlwaysAllow(s, 'host_exec', undefined)).toBe(false);
  });

  it('tolerates settings saved before the field existed', () => {
    const s = { alwaysAllowedTools: [] } as unknown as AlwaysAllowSettings;
    expect(isPermissionPreApprovedForThread('a', { daemonId: 'box' }, s)).toBe(false);
    expect(addRemoteAlwaysAllow(s, 'box', 'a')).toBe(true);
  });
});

describe('normalizeRemoteAlwaysAllowed', () => {
  it('returns {} for junk', () => {
    expect(normalizeRemoteAlwaysAllowed(undefined)).toEqual({});
    expect(normalizeRemoteAlwaysAllowed('x')).toEqual({});
    expect(normalizeRemoteAlwaysAllowed(['a'])).toEqual({});
    expect(normalizeRemoteAlwaysAllowed(null)).toEqual({});
  });
  it('drops bad entries, duplicates, never-allowable tools and empty daemons', () => {
    expect(normalizeRemoteAlwaysAllowed({
      box: ['a', 'a', 5, '', 'host_exec', 'sync_resolve_conflict', 'b'],
      empty: [],
      bad: 'nope',
      onlyBad: ['host_exec'],
    })).toEqual({ box: ['a', 'b'] });
  });
  it('is prototype-safe', () => {
    const out = normalizeRemoteAlwaysAllowed(JSON.parse('{"__proto__":["a"],"box":["a"]}'));
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).a).toBeUndefined();
    expect(out.box).toEqual(['a']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  customRoutes, hostToolsSettingsFrom, isGroupOn, isServerOn, proxiedServerNames, removeRoute, setGroupAvailable,
  setHostToolsEnabled, setMcpSent, setServerAvailable,
} from '../../src/hostToolsChecklist';
import type { RemoteHostToolsSettings } from '../../src/types';

describe('hostToolsSettingsFrom', () => {
  it('omits the field at defaults', () => {
    expect(hostToolsSettingsFrom(undefined)).toEqual({});
    expect(hostToolsSettingsFrom({ enabled: false, routes: {}, mcpAllowlist: [] })).toEqual({});
  });
  it('keeps routes while off, but not the false flag', () => {
    expect(hostToolsSettingsFrom({ enabled: false, routes: { vault: 'host' } })).toEqual({ hostTools: { routes: { vault: 'host' } } });
  });
});

describe('setServerAvailable', () => {
  it('on: turns host tools on and names only that server, never the whole mcp group', () => {
    expect(setServerAvailable(undefined, 'hiptrip-new', true)).toEqual({ enabled: true, routes: { 'hiptrip-new': 'host' } });
    const next = setServerAvailable({ enabled: true, routes: { vault: 'host' } }, 'hiptrip-new', true);
    expect(next).toEqual({ enabled: true, routes: { vault: 'host', 'hiptrip-new': 'host' } });
    expect(next?.routes).not.toHaveProperty('mcp');
    expect(isServerOn(next, 'hiptrip-new')).toBe(true);
    expect(isServerOn(next, 'other')).toBe(false);
  });
  it('on from off does not revive routes left over while host tools were off', () => {
    const next = setServerAvailable({ enabled: false, routes: { vault: 'host' }, mcpAllowlist: ['docs'] }, 's', true);
    expect(next).toEqual({ enabled: true, routes: { s: 'host' }, mcpAllowlist: ['docs'] });
  });
  it('off: removes the route, keeps other routes and the master switch', () => {
    const next = setServerAvailable({ enabled: true, routes: { vault: 'host', s: 'host' } }, 's', false);
    expect(next).toEqual({ enabled: true, routes: { vault: 'host' } });
  });
  it('off: the last route going turns host tools off and leaves a default config', () => {
    expect(setServerAvailable({ enabled: true, routes: { s: 'host' } }, 's', false)).toBeUndefined();
    expect(setServerAvailable({ enabled: true, routes: { s: 'host' }, mcpAllowlist: ['docs'] }, 's', false)).toEqual({ mcpAllowlist: ['docs'] });
  });
  it('off under the legacy mcp group names just that server absent', () => {
    const legacy: RemoteHostToolsSettings = { enabled: true, routes: { mcp: 'host' } };
    expect(isServerOn(legacy, 's')).toBe(true);
    const next = setServerAvailable(legacy, 's', false);
    expect(next).toEqual({ enabled: true, routes: { mcp: 'host', s: 'absent' } });
    expect(isServerOn(next, 's')).toBe(false);
    expect(isServerOn(next, 't')).toBe(true);
    expect(isServerOn(setServerAvailable(next, 's', true), 's')).toBe(true);
  });
  it('is off whenever the master switch is off', () => {
    expect(isServerOn({ enabled: false, routes: { s: 'host' } }, 's')).toBe(false);
    expect(isGroupOn({ routes: { vault: 'host' } }, 'vault')).toBe(false);
  });
});

describe('groups, custom rows and the allowlist', () => {
  it('groups switch like servers', () => {
    const on = setGroupAvailable(undefined, 'vault', true);
    expect(isGroupOn(on, 'vault')).toBe(true);
    expect(setGroupAvailable(on, 'vault', false)).toBeUndefined();
  });
  it('master off keeps the list; on restores it', () => {
    const off = setHostToolsEnabled({ enabled: true, routes: { vault: 'host' } }, false);
    expect(off).toEqual({ routes: { vault: 'host' } });
    expect(setHostToolsEnabled(off, true)).toEqual({ enabled: true, routes: { vault: 'host' } });
  });
  it('legacy entries show as custom rows and round-trip unchanged', () => {
    const legacy: RemoteHostToolsSettings = { enabled: true, routes: { vault: 'host', mcp: 'host', vault_search: 'host', gone: 'host', x: 'absent' }, mcpAllowlist: ['docs', 'search'] };
    expect(customRoutes(legacy, ['hiptrip-new'])).toEqual(['mcp', 'vault_search', 'gone']);
    expect(hostToolsSettingsFrom(legacy)).toEqual({ hostTools: legacy });
    expect(removeRoute(legacy, 'gone')?.routes).toEqual({ vault: 'host', mcp: 'host', vault_search: 'host', x: 'absent' });
  });
  it('a proxied server is not custom', () => {
    expect(customRoutes({ enabled: true, routes: { s: 'host' } }, ['s'])).toEqual([]);
  });
  it('allowlist toggles add and remove names', () => {
    const a = setMcpSent(undefined, 'docs', true);
    expect(a).toEqual({ mcpAllowlist: ['docs'] });
    expect(setMcpSent(a, 'docs', false)).toBeUndefined();
  });
});

describe('proxiedServerNames', () => {
  it('lists connected OAuth servers and enabled Google services, sorted', () => {
    expect(proxiedServerNames({ oauthMcpServers: { 'hiptrip-new': {}, figma: {} }, googleWorkspaceMcp: { docs: true, gmail: false, drive: true } }))
      .toEqual(['figma', 'google-docs', 'google-drive', 'hiptrip-new']);
    expect(proxiedServerNames({})).toEqual([]);
  });
});

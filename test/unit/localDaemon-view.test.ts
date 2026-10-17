import { describe, it, expect } from 'vitest';
import { buildLocalDaemonView, describeSetup, formatProgress } from '../../src/localDaemon/view';
import type { LocalDaemonSnapshot } from '../../src/localDaemon/controller';

import { snap } from '../helpers/localDaemonSnap';
import type { Observed } from '../../src/localDaemon/assess';

const PLUGIN = '0.65.0';

const ids = (s: LocalDaemonSnapshot) => buildLocalDaemonView(s).buttons.map((b) => b.id);

describe('buildLocalDaemonView', () => {
  it('not set up offers Set up only', () => {
    const v = buildLocalDaemonView(snap({ container: 'absent', imageReady: false, volumesPresent: false, health: 'na', welcome: undefined }, {}, false));
    expect(v.statusLabel).toBe('Not set up');
    expect(v.buttons).toEqual([{ id: 'setup', label: 'Set up', cta: true }]);
  });

  it('running offers Stop, Restart, Reset and Remove', () => {
    const v = buildLocalDaemonView(snap());
    expect(v).toMatchObject({ statusLabel: 'Running', tone: 'ok' });
    expect(ids(snap())).toEqual(['stop', 'restart', 'reset', 'remove']);
    expect(v.lines.map((l) => l.label)).toEqual(['Vault', 'Daemon', 'Address']);
    expect(v.lines[0]!.value).toContain('read-write');
    expect(v.lines[0]!.value).toContain('.geode and .obsidian');
    expect(v.lines[2]!.value).toContain('this Mac only');
  });

  it('stopped offers Start first', () => {
    expect(ids(snap({ container: 'stopped', health: 'na', welcome: undefined }))).toEqual(['start', 'reset', 'remove']);
  });

  it('an older compatible daemon gets an Update available button (prompt only)', () => {
    const s = snap({ containerVersion: '0.64.0', welcome: { daemonVersion: '0.64.0', protocol: 1, minClientVersion: '0.0.0' } });
    expect(ids(s)).toEqual(['stop', 'restart', 'update', 'reset', 'remove']);
    expect(buildLocalDaemonView(s).buttons.find((b) => b.id === 'update')).toMatchObject({ label: 'Update available' });
  });

  it('needs sign-in leads with the sign-in action', () => {
    const s = snap({ credentialInKeychain: false, credentialInVolume: false });
    expect(buildLocalDaemonView(s).statusLabel).toMatch(/needs Claude sign-in/);
    expect(ids(s)[0]).toBe('sign-in');
  });

  it('degraded states each name their own fix', () => {
    expect(ids(snap({ health: 'down', welcome: undefined, tokenAccepted: 'unknown' }))[0]).toBe('restart');
    expect(ids(snap({ tokenAccepted: 'no', welcome: undefined }))[0]).toBe('start');
    expect(ids(snap({ welcome: { daemonVersion: PLUGIN, protocol: 2, minClientVersion: '0.0.0' } }))[0]).toBe('update');
    const tooOld = buildLocalDaemonView(snap({ welcome: { daemonVersion: PLUGIN, protocol: 1, minClientVersion: '9.0.0' } }));
    expect(tooOld.buttons.map((b) => b.id)).not.toContain('update');
    expect(tooOld.hint).toMatch(/update the plugin/i);
  });

  it('busy shows progress and no actions; unsupported and conflict offer none', () => {
    const busy = buildLocalDaemonView(snap({}, { busy: { kind: 'setup', label: 'Setting up the local daemon' } }));
    expect(busy).toMatchObject({ busy: true, buttons: [] });
    expect(buildLocalDaemonView(snap({ supported: false, unsupportedReason: 'macOS 26 required' })).buttons).toEqual([]);
    expect(buildLocalDaemonView(snap({ container: 'foreign' })).statusLabel).toBe('Name conflict');
  });

  it('shows the last error', () => {
    expect(buildLocalDaemonView(snap({}, { lastError: { code: 'health', message: 'never answered' } })).error).toBe('never answered');
  });
});

describe('describeSetup (the consent text)', () => {
  it('names the vault path, read-write, the read-only config folders, loopback and the downloads', () => {
    const text = describeSetup(snap({ container: 'absent', runtimeInstalled: false, runtimeRunning: false, imageReady: false, volumesPresent: false, health: 'na', welcome: undefined }, {}, false));
    expect(text).toContain('/Users/user/Vault');
    expect(text).toContain('READ-WRITE');
    expect(text).toContain('.geode and .obsidian');
    expect(text).toContain('read-only');
    expect(text).toContain('127.0.0.1');
    expect(text).toMatch(/118 MB|runtime/);
    expect(text).toContain('ghcr.io');
    expect(text).toContain('Anthropic');
    expect(text).toMatch(/backups/);
  });
  it('says nothing needs downloading when everything is present', () => {
    expect(describeSetup(snap())).toContain('Nothing needs downloading');
    expect(describeSetup(snap())).toContain('GitHub token');
    expect(describeSetup(snap())).not.toContain('sandbox');
  });
});

describe('formatProgress', () => {
  it('joins label, percent and line', () => {
    expect(formatProgress({ label: 'Downloading', percent: 40, line: 'layer 3' })).toBe('Downloading 40%: layer 3');
    expect(formatProgress({ label: 'Starting' })).toBe('Starting');
  });
});

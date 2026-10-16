/**
 * Folder discovery end to end over a real socket: the plugin's probe and
 * folder source (real DaemonClient, real `ws`) against the daemon's real
 * in-process server, with real directories on disk.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonClient, daemonWsUrl, probeDaemon, type WebSocketFactory } from '../../src/remote/DaemonClient';
import { createRemoteFolderSource } from '../../src/remote/folderSource';
import { applyDiscovery } from '../../src/remote/workspaceChoice';
import { startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';

const wsFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as ReturnType<WebSocketFactory>;

let base: string;
let td: TestDaemon;
const disposers: Array<() => void> = [];

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'folder-discovery-')));
  mkdirSync(join(base, 'projects', 'app'), { recursive: true });
  mkdirSync(join(base, 'notes', '.obsidian'), { recursive: true });
  mkdirSync(join(base, 'notes', 'Products'), { recursive: true });
  mkdirSync(join(base, 'private'), { recursive: true });
  symlinkSync(join(base, 'private'), join(base, 'notes', 'link-out'));
  td = await startTestDaemon({ config: { workspaces: [join(base, 'projects'), join(base, 'notes')] } });
});
afterEach(async () => {
  while (disposers.length) disposers.pop()!();
  await td.cleanup();
  rmSync(base, { recursive: true, force: true });
});

const wsUrl = () => td.daemon.url;

describe('plugin probe against a real daemon', () => {
  it('discovers the workspaces and auto-selects the only vault', async () => {
    const r = await probeDaemon({ url: wsUrl(), token: td.adminToken, createSocket: wsFactory, clientVersion: '0.62.2', listWorkspaces: true });
    expect(r.ok).toBe(true);
    if (!r.ok || !r.workspaces || !('list' in r.workspaces)) throw new Error('no workspaces');
    expect(r.workspaces.list.map((w) => [w.name, w.kind, w.isDefault])).toEqual([['projects', 'folder', true], ['notes', 'vault', false]]);
    const applied = applyDiscovery({ vaultRemote: '', folder: '', vaultTouched: false, folderTouched: false }, r.workspaces.list, 'Personal');
    expect(applied.draft).toEqual({ vaultRemote: join(base, 'notes'), folder: join(base, 'projects'), vaultTouched: false, folderTouched: false });
  });
});

describe('folder source against a real daemon', () => {
  function source() {
    const client = new DaemonClient({ url: wsUrl(), getToken: () => td.adminToken, createSocket: wsFactory, clientVersion: '0.62.2', backoffMs: [20, 40], idleProbeMs: 60_000 });
    disposers.push(() => client.dispose());
    return createRemoteFolderSource({ clientFor: () => client, nameOf: (id) => id });
  }

  it('lists workspaces and subfolders, and the escape link is not offered', async () => {
    const src = source();
    const ws = await src.workspaces('d');
    expect(ws.ok && ws.value.map((w) => w.path)).toEqual([join(base, 'projects'), join(base, 'notes')]);
    const sub = await src.subfolders('d', join(base, 'notes'));
    expect(sub).toMatchObject({ ok: true, value: { allowed: true, truncated: false } });
    expect(sub.ok && sub.value.entries.map((e) => e.name)).toEqual(['Products']);
  });

  it('refuses a folder outside every workspace with no names', async () => {
    const out = await source().subfolders('d', join(base, 'private'));
    expect(out).toEqual({ ok: true, value: { allowed: false, entries: [], truncated: false } });
  });

  it('daemonWsUrl round trip is not required: the daemon URL is used as is', () => {
    expect(daemonWsUrl(wsUrl())).toBe(wsUrl());
  });
});

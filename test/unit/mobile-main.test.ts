/**
 * @vitest-environment jsdom
 *
 * Behaviour of the mobile plugin entry under a fake Geode-mobile host.
 */
import '../setup/obsidian-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Notice, Platform } from 'obsidian';

const relayInstances: Array<{ args: unknown[]; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
vi.mock('../../src/RelayClient', () => ({
  RelayClient: class {
    args: unknown[];
    connect = vi.fn();
    disconnect = vi.fn();
    constructor(...args: unknown[]) {
      this.args = args;
      relayInstances.push(this);
    }
    onFrame() { return () => {}; }
    isConnected() { return false; }
  },
}));

import ClaudeThreadsMobilePlugin, { ROOM_ID_SECRET_KEY } from '../../src/mobile-main';

const ROOM = 'abcdef0123456789abcdef0123456789';

interface Harness {
  plugin: ClaudeThreadsMobilePlugin;
  registered: { views: string[]; handlers: Record<string, (p: Record<string, string>) => void>; commands: string[]; ribbons: string[]; tabs: number };
  saved: Array<Record<string, unknown>>;
  secrets: Map<string, string>;
}

function makeHarness(opts: { data?: Record<string, unknown> | null; secrets?: 'ok' | 'none' | 'reject-write'; secretValue?: string } = {}): Harness {
  const plugin = new ClaudeThreadsMobilePlugin() as ClaudeThreadsMobilePlugin & Record<string, unknown>;
  const registered: Harness['registered'] = { views: [], handlers: {}, commands: [], ribbons: [], tabs: 0 };
  const saved: Harness['saved'] = [];
  const secrets = new Map<string, string>();
  if (opts.secretValue) secrets.set(ROOM_ID_SECRET_KEY, opts.secretValue);

  const leaf = { setViewState: vi.fn().mockResolvedValue(undefined) };
  plugin.app = { workspace: { getRightLeaf: () => leaf, revealLeaf: vi.fn(), detachLeavesOfType: vi.fn() } };
  plugin.loadData = async () => (opts.data === undefined ? {} : opts.data);
  plugin.saveData = async (d: Record<string, unknown>) => { saved.push(JSON.parse(JSON.stringify(d))); };
  plugin.registerView = (t: string) => { registered.views.push(t); };
  plugin.registerObsidianProtocolHandler = (a: string, h: (p: Record<string, string>) => void) => { registered.handlers[a] = h; };
  plugin.addCommand = (c: { id: string }) => { registered.commands.push(c.id); };
  plugin.addRibbonIcon = (icon: string) => { registered.ribbons.push(icon); return document.createElement('div'); };
  plugin.addSettingTab = () => { registered.tabs++; };

  const mode = opts.secrets ?? 'ok';
  if (mode !== 'none') {
    plugin.loadSecret = async (k: string) => secrets.get(k) ?? null;
    plugin.saveSecret = async (k: string, v: string) => {
      if (mode === 'reject-write') throw new Error('Secure secret storage is unavailable on this host');
      secrets.set(k, v);
    };
    plugin.removeSecret = async (k: string) => { secrets.delete(k); };
  }
  return { plugin, registered, saved, secrets };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  relayInstances.length = 0;
  Notice.messages.length = 0;
  (Platform as { isMobile: boolean }).isMobile = true;
});

describe('mobile entry onload', () => {
  it('registers the view, ribbon icon, pair handler, diagnostics command and settings tab', async () => {
    const h = makeHarness();
    await h.plugin.onload();
    expect(h.registered.views).toEqual(['claude-threads:mobile']);
    expect(h.registered.ribbons).toEqual(['smartphone']);
    expect(Object.keys(h.registered.handlers)).toEqual(['pair']);
    expect(h.registered.commands).toEqual(['generate-diagnostics-report']);
    expect(h.registered.tabs).toBe(1);
    expect(relayInstances).toHaveLength(0); // unpaired: no connection
  });

  it('connects on load when a room id is in the secret store', async () => {
    const h = makeHarness({ secretValue: ROOM, data: { remoteAccess: { relayUrl: 'wss://mine.example' } } });
    await h.plugin.onload();
    expect(relayInstances).toHaveLength(1);
    expect(relayInstances[0].args).toEqual(['mobile', 'wss://mine.example', ROOM]);
  });
});

describe('pair handler', () => {
  it('stores the room id with saveSecret, not in data.json, and connects', async () => {
    const h = makeHarness({ data: { someDesktopKey: 42 } });
    await h.plugin.onload();
    h.registered.handlers['pair']({ roomId: ROOM.toUpperCase(), relay: 'wss://relay.example' });
    await flush(); await flush();

    expect(h.secrets.get(ROOM_ID_SECRET_KEY)).toBe(ROOM);
    const last = h.saved[h.saved.length - 1];
    expect(JSON.stringify(last)).not.toContain(ROOM);
    expect(last.someDesktopKey).toBe(42); // unrelated settings preserved
    expect((last.remoteAccess as { enabled: boolean; relayUrl: string }).enabled).toBe(true);
    expect((last.remoteAccess as { relayUrl: string }).relayUrl).toBe('wss://relay.example');
    expect(relayInstances[0].args).toEqual(['mobile', 'wss://relay.example', ROOM]);
  });

  it('falls back to data.json when secure storage rejects writes', async () => {
    const h = makeHarness({ secrets: 'reject-write' });
    await h.plugin.onload();
    h.registered.handlers['pair']({ roomId: ROOM });
    await flush(); await flush();
    const last = h.saved[h.saved.length - 1];
    expect((last.remoteAccess as { roomId: string }).roomId).toBe(ROOM);
    expect(h.plugin.isRoomIdInSecretStore()).toBe(false);
  });

  it('falls back to data.json when the host has no secret API', async () => {
    const h = makeHarness({ secrets: 'none' });
    await h.plugin.onload();
    h.registered.handlers['pair']({ roomId: ROOM });
    await flush(); await flush();
    expect((h.saved[h.saved.length - 1].remoteAccess as { roomId: string }).roomId).toBe(ROOM);
  });

  it('rejects malformed room ids and non-websocket relays', async () => {
    const h = makeHarness();
    await h.plugin.onload();
    h.registered.handlers['pair']({ roomId: 'nope' });
    h.registered.handlers['pair']({ roomId: ROOM, relay: 'https://evil.example' });
    await flush();
    expect(h.secrets.size).toBe(0);
    expect(relayInstances).toHaveLength(0);
    expect(Notice.messages.filter((m) => m.message.startsWith('Invalid pairing link'))).toHaveLength(2);
  });

  it('never logs the room id', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const h = makeHarness({ secrets: 'reject-write' });
    await h.plugin.onload();
    h.registered.handlers['pair']({ roomId: ROOM });
    await flush(); await flush();
    const logged = spies.flatMap((s) => s.mock.calls).map((c) => JSON.stringify(c)).join('\n');
    expect(logged).not.toContain(ROOM);
    spies.forEach((s) => s.mockRestore());
  });
});

describe('legacy data.json migration', () => {
  it('moves an existing plaintext room id into the secret store and scrubs data.json', async () => {
    const h = makeHarness({ data: { remoteAccess: { enabled: true, roomId: ROOM, relayUrl: 'wss://r.example' } } });
    await h.plugin.onload();
    expect(h.secrets.get(ROOM_ID_SECRET_KEY)).toBe(ROOM);
    expect(h.saved.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.saved[h.saved.length - 1])).not.toContain(ROOM);
    expect(relayInstances[0].args[2]).toBe(ROOM); // still connects with the migrated id
  });

  it('keeps the plaintext room id when secure storage is unavailable', async () => {
    const h = makeHarness({ secrets: 'reject-write', data: { remoteAccess: { enabled: true, roomId: ROOM } } });
    await h.plugin.onload();
    expect(relayInstances[0].args[2]).toBe(ROOM);
    await h.plugin.saveSettings();
    expect((h.saved[h.saved.length - 1].remoteAccess as { roomId: string }).roomId).toBe(ROOM);
  });
});

describe('disconnect', () => {
  it('removes the secret and clears the room id', async () => {
    const h = makeHarness({ secretValue: ROOM });
    await h.plugin.onload();
    h.plugin.disconnectRelay();
    await h.plugin.clearRoomId();
    expect(h.secrets.has(ROOM_ID_SECRET_KEY)).toBe(false);
    expect(relayInstances[0].disconnect).toHaveBeenCalled();
    expect((h.saved[h.saved.length - 1].remoteAccess as { roomId: string; enabled: boolean })).toMatchObject({ roomId: '', enabled: false });
  });
});

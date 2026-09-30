/**
 * The login-handoff state machine (ADR-0014), now plugin-owned so the preview
 * pane and the chat's session card share it. Everything is injected, so these
 * tests use fakes for the pool, the guests and Geode's window.geode / ipc bridge.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HANDOFF_CAPTURE_MS,
  HANDOFF_RETURNED_MS,
  LoginHandoffController,
  type LoginHandoffSnapshot,
} from '../../src/agentBrowser/LoginHandoffController';
import type { AgentBrowserPool } from '../../src/agentBrowser/AgentBrowserPool';
import type { AgentBrowserGuest } from '../../src/agentBrowser/AgentBrowserGuest';

const PNG = new Uint8Array([137, 80, 78, 71]);
const LOGIN_URL = 'https://accounts.acme.io/login?next=%2Fbilling&token=SECRET';

function makeLoginGuest() {
  const capture = vi.fn().mockResolvedValue(PNG);
  const sendInputEvent = vi.fn();
  const focus = vi.fn();
  const guest = {
    capture,
    sendInputEvent,
    focus,
    facts: () => ({ viewport: { width: 1280, height: 800 } }),
  } as unknown as AgentBrowserGuest;
  return { guest, capture, sendInputEvent, focus };
}

interface Harness {
  controller: LoginHandoffController;
  pool: AgentBrowserPool;
  acquire: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  loginGuest: ReturnType<typeof makeLoginGuest>;
  fireOpen(url: string, guestId?: number): void;
  fireClose(id?: number): void;
  fireFocus(id?: number): void;
  notify: ReturnType<typeof vi.fn>;
  setThreadFor(id: number, threadId: string | null): void;
}

function harness(options: { withBridge?: boolean; withPool?: boolean } = {}): Harness {
  const { withBridge = true, withPool = true } = options;
  const loginGuest = makeLoginGuest();
  const acquire = vi.fn().mockResolvedValue(loginGuest.guest);
  const release = vi.fn();
  const primaryByWc = new Map<number, string | null>([[42, 'thread-1']]);
  const pool = {
    findPrimaryByWebContentsId: (id: number) => primaryByWc.get(id) ?? null,
    findLoginByWebContentsId: (id: number) => (id === 43 ? 'thread-1' : null),
    acquireLoginGuest: acquire,
    releaseLoginGuest: release,
  } as unknown as AgentBrowserPool;

  let openCb: ((r: { url: string; guestId: number; disposition: string }) => void) | null = null;
  const ipc = new Map<string, Array<(...args: unknown[]) => void>>();
  const notify = vi.fn();
  const controller = new LoginHandoffController({
    getPool: () => (withPool ? pool : null),
    bridgeDeps: withBridge
      ? {
          geode: { onAgentBrowserWindowOpen: (cb) => { openCb = cb as typeof openCb; return () => { openCb = null; }; } },
          ipcRenderer: {
            on: (channel, listener) => { ipc.set(channel, [...(ipc.get(channel) ?? []), listener]); },
            removeListener: (channel, listener) => { ipc.set(channel, (ipc.get(channel) ?? []).filter((l) => l !== listener)); },
          },
        }
      : { geode: null, ipcRenderer: null },
    notify,
  });
  const emit = (channel: string, id: number) => (ipc.get(channel) ?? []).forEach((l) => l({}, id));
  return {
    controller, pool, acquire, release, loginGuest, notify,
    fireOpen: (url, guestId = 42) => openCb?.({ url, guestId, disposition: 'foreground-tab' }),
    fireClose: (id = 43) => emit('agent-browser-window-close', id),
    fireFocus: (id = 43) => emit('agent-browser-window-focus', id),
    setThreadFor: (id, threadId) => { primaryByWc.set(id, threadId); },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function takeControl(h: Harness): Promise<void> {
  h.fireOpen(LOGIN_URL);
  const result = await h.controller.takeControl('thread-1');
  expect(result.ok).toBe(true);
}

describe('LoginHandoffController — request -> take -> return', () => {
  it('a denied popup on a known primary guest becomes a requested snapshot for that thread', () => {
    const h = harness();
    h.controller.start();
    const seen: string[] = [];
    h.controller.subscribe((t) => seen.push(t));

    h.fireOpen(LOGIN_URL);

    const snap = h.controller.getSnapshot('thread-1')!;
    expect(snap).toMatchObject({ threadId: 'thread-1', phase: 'requested', host: 'accounts.acme.io', url: LOGIN_URL });
    expect(snap.expiresAt).toBeGreaterThan(Date.now());
    expect(seen).toEqual(['thread-1']);
    expect(h.controller.available).toBe(true);
    h.controller.stop();
  });

  it('take control acquires the login guest, focuses it and becomes active', async () => {
    const h = harness();
    h.controller.start();
    await takeControl(h);

    expect(h.acquire).toHaveBeenCalledWith('thread-1', LOGIN_URL);
    expect(h.loginGuest.focus).toHaveBeenCalled();
    expect(h.controller.getSnapshot('thread-1')).toMatchObject({ phase: 'active', host: 'accounts.acme.io' });
    expect(h.controller.getActiveSnapshot()?.threadId).toBe('thread-1');
    h.controller.stop();
  });

  it('return control releases the guest, shows "returned" for ~4s, then goes idle and remembers the step', async () => {
    const h = harness();
    h.controller.start();
    await takeControl(h);
    vi.advanceTimersByTime(14_000);

    h.controller.returnControl('thread-1', 'login-complete');

    expect(h.release).toHaveBeenCalledWith('thread-1', 'login-complete');
    expect(h.controller.getSnapshot('thread-1')).toMatchObject({ phase: 'returned', host: 'accounts.acme.io' });
    expect(h.controller.getActiveSnapshot()).toBeNull();

    vi.advanceTimersByTime(HANDOFF_RETURNED_MS + 1);
    expect(h.controller.getSnapshot('thread-1')).toBeNull();
    expect(h.controller.getHistory('thread-1')).toEqual([
      expect.objectContaining({ outcome: 'returned', host: 'accounts.acme.io', durationMs: 14_000 }),
    ]);
    h.controller.stop();
  });

  it('return control with nothing active is a harmless no-op', () => {
    const h = harness();
    h.controller.start();
    expect(() => h.controller.returnControl('thread-1')).not.toThrow();
    expect(h.release).not.toHaveBeenCalled();
    h.controller.stop();
  });

  it('the login window closing itself returns control', async () => {
    const h = harness();
    h.controller.start();
    await takeControl(h);

    h.fireClose();

    expect(h.release).toHaveBeenCalledWith('thread-1', 'login-complete');
    expect(h.controller.getSnapshot('thread-1')?.phase).toBe('returned');
    h.controller.stop();
  });

  it('a close for a webContents nobody owns is ignored', async () => {
    const h = harness();
    h.controller.start();
    await takeControl(h);
    h.fireClose(9999);
    expect(h.controller.getSnapshot('thread-1')?.phase).toBe('active');
    h.controller.stop();
  });

  it('the login window regaining OS focus notifies focus subscribers only while active', async () => {
    const h = harness();
    h.controller.start();
    const onFocus = vi.fn();
    h.controller.subscribeFocus(onFocus);
    h.fireOpen(LOGIN_URL);
    h.fireFocus();
    expect(onFocus).not.toHaveBeenCalled();
    await h.controller.takeControl('thread-1');
    h.fireFocus();
    expect(onFocus).toHaveBeenCalledWith('thread-1');
    h.controller.stop();
  });

  it('a failed acquire is reported once and leaves the request actionable', async () => {
    const h = harness();
    h.acquire.mockRejectedValueOnce(new Error('no file handles'));
    h.controller.start();
    h.fireOpen(LOGIN_URL);

    const result = await h.controller.takeControl('thread-1');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('no file handles');
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot('thread-1')?.phase).toBe('requested');
    h.controller.stop();
  });

  it('"Not now" dismisses the request', () => {
    const h = harness();
    h.controller.start();
    h.fireOpen(LOGIN_URL);
    h.controller.dismissRequest('thread-1');
    expect(h.controller.getSnapshot('thread-1')).toBeNull();
    h.controller.stop();
  });
});

describe('LoginHandoffController — expiry and stale requests', () => {
  it('a request expires after the 30s TTL and can no longer be taken', async () => {
    const h = harness();
    h.controller.start();
    h.fireOpen(LOGIN_URL);

    vi.advanceTimersByTime(30_001);

    expect(h.controller.getSnapshot('thread-1')).toMatchObject({ phase: 'expired', host: 'accounts.acme.io' });
    expect(h.controller.getHistory('thread-1')).toEqual([expect.objectContaining({ outcome: 'expired' })]);
    expect((await h.controller.takeControl('thread-1')).ok).toBe(false);
    expect(h.acquire).not.toHaveBeenCalled();
    h.controller.stop();
  });

  it('a newer request replaces an expired one', () => {
    const h = harness();
    h.controller.start();
    h.fireOpen(LOGIN_URL);
    vi.advanceTimersByTime(30_001);
    h.fireOpen('https://accounts.acme.io/login2');
    expect(h.controller.getSnapshot('thread-1')).toMatchObject({ phase: 'requested', url: 'https://accounts.acme.io/login2' });
    h.controller.stop();
  });

  it("an older request's timer never expires a newer request for the same thread", () => {
    const h = harness();
    h.controller.start();
    h.fireOpen(LOGIN_URL);
    vi.advanceTimersByTime(20_000);
    h.fireOpen('https://accounts.acme.io/login2');
    vi.advanceTimersByTime(15_000); // the first request's 30s has elapsed; the second's has not
    expect(h.controller.getSnapshot('thread-1')?.phase).toBe('requested');
    h.controller.stop();
  });

  it('a popup from a guest the pool does not recognise is ignored entirely', () => {
    const h = harness();
    h.controller.start();
    expect(() => h.fireOpen('https://evil.example.com', 999)).not.toThrow();
    expect(h.controller.getSnapshot('thread-1')).toBeNull();
    h.controller.stop();
  });

  it('taking control for a thread with no pending request does nothing', async () => {
    const h = harness();
    h.controller.start();
    h.setThreadFor(50, 'thread-2');
    h.fireOpen(LOGIN_URL, 50); // only thread-2 has a request
    expect((await h.controller.takeControl('thread-1')).ok).toBe(false);
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot('thread-1')).toBeNull();
    expect(h.controller.getSnapshot('thread-2')?.phase).toBe('requested');
    h.controller.stop();
  });

  it('stop() discards a pending request so it can never be taken afterwards', async () => {
    const h = harness();
    h.controller.start();
    h.fireOpen(LOGIN_URL);
    h.controller.stop(); // tears state down mid-flight
    h.controller.start();
    const result = await h.controller.takeControl('thread-1');
    expect(result.ok).toBe(false);
  });
});

describe('LoginHandoffController — frames and input', () => {
  it('captures a frame only while an attached viewer is visible', async () => {
    const h = harness();
    h.controller.start();
    let visible = true;
    h.controller.attachViewer(() => visible);
    const frames: Array<string | null> = [];
    h.controller.subscribeFrames((_t, url) => frames.push(url));
    await takeControl(h);

    await vi.advanceTimersByTimeAsync(HANDOFF_CAPTURE_MS);
    expect(h.loginGuest.capture).toHaveBeenCalledTimes(1);
    expect(frames[0]).toMatch(/^data:image\/png;base64,/);
    expect(h.controller.getFrame('thread-1')).toBe(frames[0]);

    visible = false;
    await vi.advanceTimersByTimeAsync(HANDOFF_CAPTURE_MS * 4);
    expect(h.loginGuest.capture).toHaveBeenCalledTimes(1);
    h.controller.stop();
  });

  it('captures nothing with no viewer attached at all', async () => {
    const h = harness();
    h.controller.start();
    await takeControl(h);
    await vi.advanceTimersByTimeAsync(HANDOFF_CAPTURE_MS * 4);
    expect(h.loginGuest.capture).not.toHaveBeenCalled();
    h.controller.stop();
  });

  it('a viewer scoped to another thread does not trigger captures', async () => {
    const h = harness();
    h.controller.start();
    h.controller.attachViewer(() => true, 'thread-2');
    await takeControl(h);
    await vi.advanceTimersByTimeAsync(HANDOFF_CAPTURE_MS * 3);
    expect(h.loginGuest.capture).not.toHaveBeenCalled();
    h.controller.stop();
  });

  it('a crashed login guest returns control instead of freezing on a stale frame', async () => {
    const h = harness();
    h.controller.start();
    h.controller.attachViewer(() => true);
    await takeControl(h);
    h.loginGuest.capture.mockRejectedValueOnce(new Error('gone'));

    await vi.advanceTimersByTimeAsync(HANDOFF_CAPTURE_MS);

    expect(h.release).toHaveBeenCalledWith('thread-1', 'crash');
    expect(h.controller.getSnapshot('thread-1')?.phase).toBe('returned');
    expect(h.controller.getFrame('thread-1')).toBeNull();
    h.controller.stop();
  });

  it('stops the capture loop when the last handoff ends', async () => {
    const h = harness();
    h.controller.start();
    h.controller.attachViewer(() => true);
    await takeControl(h);
    h.controller.returnControl('thread-1');
    h.loginGuest.capture.mockClear();
    await vi.advanceTimersByTimeAsync(HANDOFF_CAPTURE_MS * 4);
    expect(h.loginGuest.capture).not.toHaveBeenCalled();
    h.controller.stop();
  });

  it('forwards pointer and keyboard input only to the active login guest', async () => {
    const h = harness();
    h.controller.start();
    // Nothing active yet: no throw, nothing sent.
    h.controller.forwardPointer('thread-1', 'mouseDown', 5, 5, { left: 0, top: 0, width: 640, height: 400 });
    expect(h.controller.forwardKey('thread-1', { key: 'a', type: 'keydown', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false })).toBe(false);
    expect(h.loginGuest.sendInputEvent).not.toHaveBeenCalled();

    await takeControl(h);
    h.controller.forwardPointer('thread-1', 'mouseDown', 320, 200, { left: 0, top: 0, width: 640, height: 400 });
    expect(h.loginGuest.sendInputEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'mouseDown', x: 640, y: 400 }));

    expect(h.controller.forwardKey('thread-1', { key: 'p', type: 'keydown', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false })).toBe(true);
    // A key the mapper cannot express is dropped, not forwarded.
    expect(h.controller.forwardKey('thread-1', { key: 'Shift', type: 'keydown', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false })).toBe(false);
    h.controller.stop();
  });
});

describe('LoginHandoffController — inert without a bridge or pool', () => {
  it('with no Geode bridge: not available, no throws, no card affordances', async () => {
    const h = harness({ withBridge: false });
    expect(() => h.controller.start()).not.toThrow();
    expect(h.controller.available).toBe(false);
    expect(h.controller.getSnapshot('thread-1')).toBeNull();
    expect(h.controller.getActiveSnapshot()).toBeNull();
    expect((await h.controller.takeControl('thread-1')).ok).toBe(false);
    expect(() => h.controller.returnControl('thread-1')).not.toThrow();
    expect(() => h.controller.dismissRequest('thread-1')).not.toThrow();
    expect(h.controller.forwardKey('thread-1', { key: 'a', type: 'keydown', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false })).toBe(false);
    expect(() => h.controller.stop()).not.toThrow();
  });

  it('with no pool (feature off): inert', async () => {
    const h = harness({ withPool: false });
    h.controller.start();
    h.fireOpen(LOGIN_URL); // the pool cannot resolve a thread, so the bridge drops it
    expect(h.controller.available).toBe(false);
    expect(h.controller.getSnapshot('thread-1')).toBeNull();
    expect((await h.controller.takeControl('thread-1')).ok).toBe(false);
    h.controller.stop();
  });

  it('start/stop are idempotent', () => {
    const h = harness();
    h.controller.start();
    h.controller.start();
    h.controller.stop();
    expect(() => h.controller.stop()).not.toThrow();
  });
});

describe('LoginHandoffController — privacy: the login page never reaches the agent or disk', () => {
  it('keeps frames out of snapshots and out of history', async () => {
    const h = harness();
    h.controller.start();
    h.controller.attachViewer(() => true);
    await takeControl(h);
    await vi.advanceTimersByTimeAsync(HANDOFF_CAPTURE_MS);
    expect(h.controller.getFrame('thread-1')).toMatch(/^data:image/);

    const snap = h.controller.getSnapshot('thread-1') as LoginHandoffSnapshot;
    h.controller.returnControl('thread-1');
    const serialized = JSON.stringify([snap, h.controller.getSnapshot('thread-1'), h.controller.getHistory('thread-1')]);
    expect(serialized).not.toContain('data:image');
    expect(serialized).not.toContain('base64');
    h.controller.stop();
  });

  it('keystrokes reach ONLY the login guest: nothing is retained or re-emitted', async () => {
    const h = harness();
    h.controller.start();
    const notified: unknown[] = [];
    h.controller.subscribe((t) => notified.push(t));
    h.controller.subscribeFrames((_t, f) => notified.push(f));
    await takeControl(h);
    notified.length = 0;

    for (const ch of 'hunter2') {
      h.controller.forwardKey('thread-1', { key: ch, type: 'keydown', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
    }

    expect(h.loginGuest.sendInputEvent).toHaveBeenCalledTimes(14); // keyDown + char per character;
    // No subscriber is told about individual keys, and no state records them.
    expect(notified).toEqual([]);
    expect(JSON.stringify(h.controller.getSnapshot('thread-1'))).not.toContain('hunter2');
    expect(JSON.stringify(h.controller.getHistory('thread-1'))).not.toContain('hunter2');
    h.controller.stop();
  });

  it('drops the frame from memory when control returns or the controller stops', async () => {
    const h = harness();
    h.controller.start();
    h.controller.attachViewer(() => true);
    await takeControl(h);
    await vi.advanceTimersByTimeAsync(HANDOFF_CAPTURE_MS);
    h.controller.returnControl('thread-1');
    expect(h.controller.getFrame('thread-1')).toBeNull();
    h.controller.stop();
  });

  it('cannot reach transcripts, images, settings, logs or MCP: its module graph excludes them', () => {
    const raw = readFileSync('src/agentBrowser/LoginHandoffController.ts', 'utf8');
    // Judge the code, not the prose that documents the invariant.
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(imports).toEqual([
      './AgentBrowserGuest',
      './AgentBrowserLoginBridge',
      './AgentBrowserPool',
      './agentBrowserImage',
      './agentBrowserInput',
    ]);
    // No logging of anything, and no persistence hooks.
    expect(source).not.toMatch(/debugLog|console\.|RawLogWriter|saveSettings|toolResultImages|ChatMessage/);
  });
});

describe('LoginHandoffController — take over the agent\'s own page', () => {
  function takeoverHarness(alive = true) {
    const guest = makeLoginGuest();
    (guest.guest as unknown as Record<string, unknown>).isAlive = () => alive;
    (guest.guest as unknown as Record<string, unknown>).facts = () => ({ url: 'https://www.reddit.com/login/', viewport: { width: 1280, height: 800 } });
    const release = vi.fn();
    const pool = { peek: (id: string) => (id === 'thread-1' ? guest.guest : null), releaseLoginGuest: release } as unknown as AgentBrowserPool;
    const controller = new LoginHandoffController({ getPool: () => pool, bridgeDeps: { geode: null, ipcRenderer: null } });
    return { controller, guest, release };
  }

  it('takes over without any popup request: active, takeover mode, agent locked out, capture as human', async () => {
    const { controller, guest } = takeoverHarness();
    controller.attachViewer(() => true);
    expect(controller.takeOver('thread-1')).toEqual({ ok: true });

    expect(controller.getSnapshot('thread-1')).toMatchObject({ phase: 'active', mode: 'takeover', host: 'www.reddit.com' });
    const g = guest.guest as unknown as { userDriving: boolean; handoffActive: boolean };
    expect(g.userDriving).toBe(true);
    expect(g.handoffActive).toBe(true);
    expect(guest.focus).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HANDOFF_CAPTURE_MS + 1);
    expect(guest.capture).toHaveBeenCalledWith(expect.any(Number), { human: true });
    controller.stop();
  });

  it('returning control unlocks the agent and does NOT retire the agent\'s own guest', () => {
    const { controller, guest, release } = takeoverHarness();
    controller.takeOver('thread-1');
    controller.returnControl('thread-1');

    const g = guest.guest as unknown as { userDriving: boolean; handoffActive: boolean };
    expect(g.userDriving).toBe(false);
    expect(g.handoffActive).toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(controller.getSnapshot('thread-1')?.phase).toBe('returned');
    controller.stop();
  });

  it('refuses when there is no live page, or a handoff is already active', () => {
    expect(takeoverHarness(false).controller.takeOver('thread-1').ok).toBe(false);
    expect(takeoverHarness().controller.takeOver('nope').ok).toBe(false);
    const { controller } = takeoverHarness();
    controller.takeOver('thread-1');
    expect(controller.takeOver('thread-1').ok).toBe(false);
    controller.stop();
  });
});

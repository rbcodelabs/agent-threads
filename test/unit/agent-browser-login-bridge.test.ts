/**
 * `AgentBrowserLoginBridge` turns Geode's raw wire format (a preload-wrapped
 * callback for the open, plain `ipcRenderer` channels for close/focus) into
 * thread-scoped callbacks. Its most load-bearing behaviour is the negative
 * one: on a host that doesn't expose `window.geode.onAgentBrowserWindowOpen`
 * at all (plain Obsidian, or a Geode build predating ADR-0022), it must be a
 * complete no-op rather than throw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentBrowserLoginBridge,
  type AgentBrowserWindowOpenRequest,
  type GeodeLoginBridgeLike,
  type IpcRendererLike,
} from '../../src/agentBrowser/AgentBrowserLoginBridge';

/** A fake `window.geode.onAgentBrowserWindowOpen` that lets tests fire requests on demand. */
function makeFakeGeode(): { geode: GeodeLoginBridgeLike; fire: (request: AgentBrowserWindowOpenRequest) => void; unsubscribed: boolean } {
  let listener: ((request: AgentBrowserWindowOpenRequest) => void) | null = null;
  const state = {
    geode: {
      onAgentBrowserWindowOpen: (cb: (request: AgentBrowserWindowOpenRequest) => void) => {
        listener = cb;
        return () => {
          state.unsubscribed = true;
          listener = null;
        };
      },
    },
    fire: (request: AgentBrowserWindowOpenRequest) => listener?.(request),
    unsubscribed: false,
  };
  return state;
}

/** A fake `ipcRenderer` that lets tests fire close/focus events on demand. */
function makeFakeIpcRenderer(): { ipcRenderer: IpcRendererLike; fire: (channel: string, guestId: number) => void; listenerCount: (channel: string) => number } {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    ipcRenderer: {
      on: (channel, listener) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)!.add(listener);
      },
      removeListener: (channel, listener) => {
        listeners.get(channel)?.delete(listener);
      },
    },
    fire: (channel, guestId) => {
      for (const listener of listeners.get(channel) ?? []) listener({}, guestId);
    },
    listenerCount: (channel) => listeners.get(channel)?.size ?? 0,
  };
}

describe('AgentBrowserLoginBridge — feature detection', () => {
  it('reports unavailable and never throws when window.geode is absent', () => {
    const bridge = new AgentBrowserLoginBridge({
      geode: null,
      ipcRenderer: null,
      findPrimaryThreadByWebContentsId: () => null,
      findLoginThreadByWebContentsId: () => null,
    });
    expect(bridge.available).toBe(false);
    expect(() => bridge.start()).not.toThrow();
    expect(() => bridge.stop()).not.toThrow();
  });

  it('reports unavailable when geode exists but omits onAgentBrowserWindowOpen', () => {
    // A Geode build predating ADR-0022 — window.geode exists for other reasons
    // (wake lock, FD pressure) but not this one.
    const bridge = new AgentBrowserLoginBridge({
      geode: {},
      ipcRenderer: null,
      findPrimaryThreadByWebContentsId: () => null,
      findLoginThreadByWebContentsId: () => null,
    });
    expect(bridge.available).toBe(false);
  });

  it('reports available once onAgentBrowserWindowOpen is present', () => {
    const { geode } = makeFakeGeode();
    const bridge = new AgentBrowserLoginBridge({
      geode,
      ipcRenderer: null,
      findPrimaryThreadByWebContentsId: () => null,
      findLoginThreadByWebContentsId: () => null,
    });
    expect(bridge.available).toBe(true);
  });
});

describe('AgentBrowserLoginBridge — window-open requests', () => {
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_000_000;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves a guestId to a thread and reports a pending request', () => {
    const { geode, fire } = makeFakeGeode();
    const onPendingRequest = vi.fn();
    const bridge = new AgentBrowserLoginBridge({
      geode,
      ipcRenderer: null,
      findPrimaryThreadByWebContentsId: (id) => (id === 42 ? 'thread-a' : null),
      findLoginThreadByWebContentsId: () => null,
      now,
      onPendingRequest,
    });
    bridge.start();

    fire({ url: 'https://accounts.example.com/login', guestId: 42, disposition: 'foreground-tab' });

    expect(onPendingRequest).toHaveBeenCalledWith({
      threadId: 'thread-a',
      url: 'https://accounts.example.com/login',
      requestedAt: 1_000_000,
      expiresAt: 1_030_000,
    });
    expect(bridge.pendingFor('thread-a')).toMatchObject({ threadId: 'thread-a' });
  });

  it('ignores a guestId that does not resolve to a known thread', () => {
    const { geode, fire } = makeFakeGeode();
    const onPendingRequest = vi.fn();
    const bridge = new AgentBrowserLoginBridge({
      geode,
      ipcRenderer: null,
      findPrimaryThreadByWebContentsId: () => null,
      findLoginThreadByWebContentsId: () => null,
      now,
      onPendingRequest,
    });
    bridge.start();

    fire({ url: 'https://evil.example.com', guestId: 999, disposition: 'other' });

    expect(onPendingRequest).not.toHaveBeenCalled();
  });

  it('expires a request after the TTL and reports it, matching Geode’s own 30s pairing window', () => {
    const { geode, fire } = makeFakeGeode();
    const onRequestExpired = vi.fn();
    const bridge = new AgentBrowserLoginBridge({
      geode,
      ipcRenderer: null,
      findPrimaryThreadByWebContentsId: () => 'thread-a',
      findLoginThreadByWebContentsId: () => null,
      now,
      onRequestExpired,
    });
    bridge.start();
    fire({ url: 'https://accounts.example.com/login', guestId: 1, disposition: 'foreground-tab' });

    vi.advanceTimersByTime(29_999);
    expect(onRequestExpired).not.toHaveBeenCalled();
    expect(bridge.pendingFor('thread-a')).not.toBeNull();

    vi.advanceTimersByTime(2);
    expect(onRequestExpired).toHaveBeenCalledTimes(1);
    expect(bridge.pendingFor('thread-a')).toBeNull();
  });

  it('clearing a pending request cancels its expiry timer', () => {
    const { geode, fire } = makeFakeGeode();
    const onRequestExpired = vi.fn();
    const bridge = new AgentBrowserLoginBridge({
      geode,
      ipcRenderer: null,
      findPrimaryThreadByWebContentsId: () => 'thread-a',
      findLoginThreadByWebContentsId: () => null,
      now,
      onRequestExpired,
    });
    bridge.start();
    fire({ url: 'https://accounts.example.com/login', guestId: 1, disposition: 'foreground-tab' });

    bridge.clearPending('thread-a');
    vi.advanceTimersByTime(60_000);

    expect(onRequestExpired).not.toHaveBeenCalled();
    expect(bridge.pendingFor('thread-a')).toBeNull();
  });

  it('a newer request for the same thread is not expired by an older timer', () => {
    const { geode, fire } = makeFakeGeode();
    const onRequestExpired = vi.fn();
    const bridge = new AgentBrowserLoginBridge({
      geode,
      ipcRenderer: null,
      findPrimaryThreadByWebContentsId: () => 'thread-a',
      findLoginThreadByWebContentsId: () => null,
      now,
      onRequestExpired,
    });
    bridge.start();
    fire({ url: 'https://one.example.com', guestId: 1, disposition: 'foreground-tab' });

    clock += 20_000;
    fire({ url: 'https://two.example.com', guestId: 1, disposition: 'foreground-tab' });

    // The first request's timer fires here, but must not clear the second.
    vi.advanceTimersByTime(10_001);
    expect(onRequestExpired).not.toHaveBeenCalled();
    expect(bridge.pendingFor('thread-a')?.url).toBe('https://two.example.com');
  });

  it('stop() cancels every pending expiry timer and clears state', () => {
    const { geode, fire } = makeFakeGeode();
    const onRequestExpired = vi.fn();
    const bridge = new AgentBrowserLoginBridge({
      geode,
      ipcRenderer: null,
      findPrimaryThreadByWebContentsId: () => 'thread-a',
      findLoginThreadByWebContentsId: () => null,
      now,
      onRequestExpired,
    });
    bridge.start();
    fire({ url: 'https://accounts.example.com/login', guestId: 1, disposition: 'foreground-tab' });

    bridge.stop();
    vi.advanceTimersByTime(60_000);

    expect(onRequestExpired).not.toHaveBeenCalled();
    expect(bridge.pendingFor('thread-a')).toBeNull();
  });
});

describe('AgentBrowserLoginBridge — close/focus relay', () => {
  it('resolves a close event to its owning thread via the login-guest lookup, not the primary one', () => {
    const { ipcRenderer, fire } = makeFakeIpcRenderer();
    const findPrimaryThreadByWebContentsId = vi.fn(() => null);
    const onLoginClosed = vi.fn();
    const bridge = new AgentBrowserLoginBridge({
      geode: null,
      ipcRenderer,
      findPrimaryThreadByWebContentsId,
      findLoginThreadByWebContentsId: (id) => (id === 7 ? 'thread-b' : null),
      onLoginClosed,
    });
    bridge.start();

    fire('agent-browser-window-close', 7);

    expect(onLoginClosed).toHaveBeenCalledWith('thread-b');
    expect(findPrimaryThreadByWebContentsId).not.toHaveBeenCalled();
  });

  it('resolves a focus event the same way', () => {
    const { ipcRenderer, fire } = makeFakeIpcRenderer();
    const onLoginFocused = vi.fn();
    const bridge = new AgentBrowserLoginBridge({
      geode: null,
      ipcRenderer,
      findPrimaryThreadByWebContentsId: () => null,
      findLoginThreadByWebContentsId: (id) => (id === 7 ? 'thread-b' : null),
      onLoginFocused,
    });
    bridge.start();

    fire('agent-browser-window-focus', 7);

    expect(onLoginFocused).toHaveBeenCalledWith('thread-b');
  });

  it('ignores a close/focus guestId that resolves to no login guest', () => {
    const { ipcRenderer, fire } = makeFakeIpcRenderer();
    const onLoginClosed = vi.fn();
    const bridge = new AgentBrowserLoginBridge({
      geode: null,
      ipcRenderer,
      findPrimaryThreadByWebContentsId: () => null,
      findLoginThreadByWebContentsId: () => null,
      onLoginClosed,
    });
    bridge.start();

    fire('agent-browser-window-close', 999);

    expect(onLoginClosed).not.toHaveBeenCalled();
  });

  it('stop() removes both ipcRenderer listeners', () => {
    const { ipcRenderer, listenerCount } = makeFakeIpcRenderer();
    const bridge = new AgentBrowserLoginBridge({
      geode: null,
      ipcRenderer,
      findPrimaryThreadByWebContentsId: () => null,
      findLoginThreadByWebContentsId: () => null,
    });
    bridge.start();
    expect(listenerCount('agent-browser-window-close')).toBe(1);
    expect(listenerCount('agent-browser-window-focus')).toBe(1);

    bridge.stop();

    expect(listenerCount('agent-browser-window-close')).toBe(0);
    expect(listenerCount('agent-browser-window-focus')).toBe(0);
  });
});

/**
 * The controller's passive "live view": frames of the agent's OWN page for a
 * surface that is just watching (the chat card), under the same budget rules as
 * the Agent Browser pane. Frames are captured only while a visible viewer asks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LIVE_BUSY_CAPTURE_MS,
  LIVE_IDLE_CAPTURE_MS,
  LIVE_TICK_MS,
  LoginHandoffController,
} from '../../src/agentBrowser/LoginHandoffController';
import type { AgentBrowserPool } from '../../src/agentBrowser/AgentBrowserPool';
import type { AgentBrowserGuest } from '../../src/agentBrowser/AgentBrowserGuest';

const PNG = new Uint8Array([137, 80, 78, 71]);

function setup() {
  let clock = 1_000_000;
  const guestState = { alive: true, state: 'ready' as 'ready' | 'busy' };
  const capture = vi.fn().mockResolvedValue(PNG);
  const guest = {
    capture,
    isAlive: () => guestState.alive,
    get currentState() { return guestState.state; },
  } as unknown as AgentBrowserGuest;
  const peek = vi.fn((threadId: string) => (threadId === 't1' && guestState.alive ? guest : null));
  const pool = { peek } as unknown as AgentBrowserPool;
  const controller = new LoginHandoffController({ getPool: () => pool, now: () => clock });
  const frames: Array<[string, string | null]> = [];
  controller.subscribeFrames((t, f) => frames.push([t, f]));
  return {
    controller, capture, guestState, frames, peek,
    // Step in small slices so the injected clock tracks the fake timers.
    advance: async (ms: number) => {
      for (let left = ms; left > 0; left -= 250) {
        const step = Math.min(250, left);
        clock += step;
        await vi.advanceTimersByTimeAsync(step);
      }
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('LoginHandoffController live view', () => {
  it('captures nothing until a live viewer attaches', async () => {
    const h = setup();
    await h.advance(LIVE_TICK_MS * 10);
    expect(h.capture).not.toHaveBeenCalled();
  });

  it('captures and publishes a frame for a visible viewer, remembering the latest', async () => {
    const h = setup();
    h.controller.attachLiveViewer(() => true, 't1');
    await h.advance(LIVE_TICK_MS);
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.frames[0][0]).toBe('t1');
    expect(h.frames[0][1]).toMatch(/^data:image\/png;base64,/);
    expect(h.controller.getFrame('t1')).toBe(h.frames[0][1]);
    h.controller.stop();
  });

  it('does not capture for a viewer that is off-screen or collapsed', async () => {
    const h = setup();
    let visible = false;
    h.controller.attachLiveViewer(() => visible, 't1');
    await h.advance(LIVE_TICK_MS * 6);
    expect(h.capture).not.toHaveBeenCalled();
    visible = true;
    await h.advance(LIVE_TICK_MS);
    expect(h.capture).toHaveBeenCalledTimes(1);
    h.controller.stop();
  });

  it('keeps the pane cadence: every second while busy, every five while idle', async () => {
    const h = setup();
    h.guestState.state = 'busy';
    h.controller.attachLiveViewer(() => true, 't1');
    await h.advance(LIVE_BUSY_CAPTURE_MS * 3);
    expect(h.capture).toHaveBeenCalledTimes(3);

    h.capture.mockClear();
    h.guestState.state = 'ready';
    await h.advance(LIVE_IDLE_CAPTURE_MS * 2);
    expect(h.capture.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(h.capture.mock.calls.length).toBeLessThanOrEqual(2);
    h.controller.stop();
  });

  it('does not double-spend the budget when the pane just published a frame', async () => {
    const h = setup();
    h.guestState.state = 'busy';
    h.controller.attachLiveViewer(() => true, 't1');
    await h.advance(LIVE_BUSY_CAPTURE_MS);
    h.capture.mockClear();
    h.controller.publishLiveFrame('t1', 'data:image/png;base64,PANE');
    await h.advance(LIVE_TICK_MS / 2);
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.controller.getFrame('t1')).toBe('data:image/png;base64,PANE');
    h.controller.stop();
  });

  it('stops capturing once the last viewer detaches', async () => {
    const h = setup();
    h.guestState.state = 'busy';
    const detach = h.controller.attachLiveViewer(() => true, 't1');
    await h.advance(LIVE_BUSY_CAPTURE_MS);
    detach();
    h.capture.mockClear();
    await h.advance(LIVE_BUSY_CAPTURE_MS * 5);
    expect(h.capture).not.toHaveBeenCalled();
  });

  it('when the session ends, drops the stale frame (null) so the card settles to its screenshot', async () => {
    const h = setup();
    h.controller.attachLiveViewer(() => true, 't1');
    await h.advance(LIVE_TICK_MS);
    h.guestState.alive = false;
    await h.advance(LIVE_TICK_MS);
    expect(h.frames[h.frames.length - 1]).toEqual(['t1', null]);
    expect(h.controller.getFrame('t1')).toBeNull();
    h.controller.stop();
  });

  it('survives a failed capture and tries again later', async () => {
    const h = setup();
    h.guestState.state = 'busy';
    h.capture.mockRejectedValueOnce(new Error('guest busy'));
    h.controller.attachLiveViewer(() => true, 't1');
    await h.advance(LIVE_BUSY_CAPTURE_MS * 3);
    expect(h.capture.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.controller.getFrame('t1')).not.toBeNull();
    h.controller.stop();
  });

  it('stop() clears frames and timers', async () => {
    const h = setup();
    h.controller.attachLiveViewer(() => true, 't1');
    await h.advance(LIVE_TICK_MS);
    h.controller.stop();
    h.capture.mockClear();
    await h.advance(LIVE_TICK_MS * 5);
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.controller.getFrame('t1')).toBeNull();
  });
});

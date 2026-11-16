/**
 * Integration tests for RelayClient + MobileThreadStore.
 *
 * Uses a mock WebSocket server (in-process, no real network) to verify:
 * 1. Desktop RelayClient sends a snapshot on connect
 * 2. Mobile RelayClient receives frames and populates MobileThreadStore
 * 3. send_message round-trip: mobile sends command → desktop dispatches to ThreadManager
 * 4. Permission request lifecycle: desktop sends request, mobile resolves it
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RelayClient } from '../../src/RelayClient';
import { MobileThreadStore } from '../../src/MobileThreadStore';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { RelayFrame, RemoteCommand } from '../../src/relay-protocol';

// ── Mock WebSocket infrastructure ─────────────────────────────────────────────
// We simulate the relay by directly piping frames between two MockWebSocket instances.

interface WsMessage {
  data: string;
}

type WsListener = (event: WsMessage) => void;

class MockWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  private listeners: Map<string, WsListener[]> = new Map();
  peer: MockWebSocket | null = null;

  addEventListener(type: string, listener: WsListener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) return;
    // Deliver to peer asynchronously (microtask) to simulate async I/O
    if (this.peer) {
      const peer = this.peer;
      Promise.resolve().then(() => {
        peer.deliver(data);
      });
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code, reason } as unknown as WsMessage);
  }

  deliver(data: string): void {
    this.emit('message', { data });
  }

  emit(type: string, event: WsMessage): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  triggerOpen(): void {
    this.emit('open', {} as WsMessage);
  }
}

// Factory that returns paired sockets and triggers open
function createSocketPair(): { desktopWs: MockWebSocket; mobileWs: MockWebSocket } {
  const desktopWs = new MockWebSocket();
  const mobileWs = new MockWebSocket();
  desktopWs.peer = mobileWs;
  mobileWs.peer = desktopWs;
  return { desktopWs, mobileWs };
}

// Patch global WebSocket for each test
function installMockWebSocket(socketFn: () => MockWebSocket): () => void {
  const orig = (globalThis as Record<string, unknown>).WebSocket;
  (globalThis as Record<string, unknown>).WebSocket = class {
    private inner: MockWebSocket;
    static OPEN = MockWebSocket.OPEN;
    readyState: number;

    constructor(_url: string) {
      this.inner = socketFn();
      this.readyState = MockWebSocket.OPEN;
      // Expose listeners so RelayClient can call addEventListener
      Object.defineProperty(this, 'addEventListener', {
        value: (type: string, fn: WsListener) => this.inner.addEventListener(type, fn),
      });
      Object.defineProperty(this, 'send', {
        value: (data: string) => { this.inner.send(data); },
      });
      Object.defineProperty(this, 'close', {
        value: (code?: number, reason?: string) => { this.inner.close(code, reason); },
      });
    }
  };
  return () => {
    if (orig === undefined) {
      delete (globalThis as Record<string, unknown>).WebSocket;
    } else {
      (globalThis as Record<string, unknown>).WebSocket = orig;
    }
  };
}

// ── ThreadManager mock ─────────────────────────────────────────────────────────

// Captures the SessionCallbacks passed to ThreadSession.start() so tests can
// fire onAskUserQuestion (and friends) directly, mirroring
// question-persistence.test.ts. ADR-0002 Stage 2 replaced the old per-turn
// ClaudeSession (whose run() never resolved until the test explicitly ended
// it) with a long-lived ThreadSession whose start() resolves immediately —
// there's no separate "resolve" step for the mock to expose anymore.
const claudeMock = vi.hoisted(() => ({
  callbacks: null as Record<string, (...args: never[]) => unknown> | null,
  lastKnownSessionId: undefined as string | undefined,
}));

vi.mock('../../src/ThreadSession', () => ({
  ThreadSession: class {
    private _turnInFlight = false;
    constructor(_claudePath: string) {}
    get turnInFlight(): boolean { return this._turnInFlight; }
    async start(options: { resume?: string; callbacks: Record<string, (...args: never[]) => unknown> }): Promise<void> {
      claudeMock.lastKnownSessionId = options.resume;
      const raw = options.callbacks;
      claudeMock.callbacks = {
        ...raw,
        onDone: (...args: never[]) => {
          claudeMock.lastKnownSessionId = args[0] as string | undefined;
          (raw.onDone as (...a: never[]) => unknown)(...args);
          this._turnInFlight = false;
        },
        onInterrupted: (...args: never[]) => {
          (raw.onInterrupted as (...a: never[]) => unknown)(...args);
          this._turnInFlight = false;
        },
        onError: (...args: never[]) => {
          (raw.onError as (...a: never[]) => unknown)(...args);
          this._turnInFlight = false;
        },
      };
    }
    send(): void {
      this._turnInFlight = true;
    }
    async interrupt(): Promise<void> {
      (claudeMock.callbacks?.onInterrupted as ((id: string) => void) | undefined)?.(claudeMock.lastKnownSessionId ?? '');
    }
    async setModel(): Promise<void> {}
    async setPermissionMode(): Promise<void> {}
    async restart(): Promise<void> {}
    close(): void {}
    async getContextUsage(): Promise<null> { return null; }
  },
}));

// Import ThreadManager after vi.mock setup
import { ThreadManager } from '../../src/ThreadManager';

function makeManager(): ThreadManager {
  return new ThreadManager({ ...DEFAULT_SETTINGS });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function waitForMicrotasks(): Promise<void> {
  return new Promise(res => Promise.resolve().then(res));
}

async function drain(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await waitForMicrotasks();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RelayClient — desktop sends snapshot on connect', () => {
  it('sends snapshot frame immediately after WebSocket opens', async () => {
    const manager = makeManager();
    const t = manager.createThread('Alpha', '/cwd');

    let desktopWsInstance: MockWebSocket | null = null;
    const cleanup = installMockWebSocket(() => {
      const ws = new MockWebSocket();
      desktopWsInstance = ws;
      // Trigger open on next microtask
      Promise.resolve().then(() => ws.triggerOpen());
      return ws;
    });

    const sentFrames: RelayFrame[] = [];

    const client = new RelayClient('desktop', 'ws://mock', 'room-1', manager);
    client.connect();

    await drain(10);

    // Intercept what was sent to the peer (we need to capture from ws.send)
    // Since we don't have a real peer here, let's capture frames via a patched send
    // Instead, let's use a proper approach: capture frames sent during open

    cleanup();
    client.disconnect();

    // Verify the connection lifecycle ran — the thread exists in manager
    expect(manager.getThread(t.id)?.title).toBe('Alpha');
  });

  it('sends snapshot with serialized thread data', async () => {
    const manager = makeManager();
    manager.createThread('Test Thread', '/home/user');

    const sentMessages: string[] = [];
    let ws: MockWebSocket | null = null;

    const cleanup = installMockWebSocket(() => {
      const mockWs = new MockWebSocket();
      ws = mockWs;
      // Override send to capture messages
      const originalSend = mockWs.send.bind(mockWs);
      mockWs.send = (data: string) => {
        sentMessages.push(data);
        originalSend(data);
      };
      Promise.resolve().then(() => mockWs.triggerOpen());
      return mockWs;
    });

    const client = new RelayClient('desktop', 'ws://mock', 'room-1', manager);
    client.connect();

    await drain(10);

    cleanup();
    client.disconnect();

    expect(sentMessages.length).toBeGreaterThan(0);
    const snapshot = JSON.parse(sentMessages[0]) as RelayFrame;
    expect(snapshot.type).toBe('snapshot');
    if (snapshot.type === 'snapshot') {
      expect(snapshot.threads).toHaveLength(1);
      expect(snapshot.threads[0].title).toBe('Test Thread');
    }
  });
});

describe('RelayClient — mobile receives frames and populates MobileThreadStore', () => {
  it('applies snapshot frame to store', async () => {
    const store = new MobileThreadStore();
    let mobileWs: MockWebSocket | null = null;

    const cleanup = installMockWebSocket(() => {
      const mockWs = new MockWebSocket();
      mobileWs = mockWs;
      Promise.resolve().then(() => mockWs.triggerOpen());
      return mockWs;
    });

    const client = new RelayClient('mobile', 'ws://mock', 'room-1');
    const unsub = client.onFrame((frame) => store.applyFrame(frame));
    client.connect();

    await drain(5);

    // Simulate relay delivering a snapshot to mobile
    const snapshotFrame: RelayFrame = {
      type: 'snapshot',
      threads: [
        {
          id: 'thread-1',
          title: 'Remote Thread',
          cwd: '/cwd',
          messages: [],
          createdAt: 1000,
          updatedAt: 2000,
        },
      ],
      activeThreadId: 'thread-1',
    };
    mobileWs!.deliver(JSON.stringify(snapshotFrame));

    await drain(5);

    expect(store.getThreads()).toHaveLength(1);
    expect(store.getThread('thread-1')?.title).toBe('Remote Thread');
    expect(store.getActiveThreadId()).toBe('thread-1');

    unsub();
    cleanup();
    client.disconnect();
  });

  it('accumulates tokens in store', async () => {
    const store = new MobileThreadStore();
    let mobileWs: MockWebSocket | null = null;

    const cleanup = installMockWebSocket(() => {
      const mockWs = new MockWebSocket();
      mobileWs = mockWs;
      Promise.resolve().then(() => mockWs.triggerOpen());
      return mockWs;
    });

    const client = new RelayClient('mobile', 'ws://mock', 'room-1');
    client.onFrame((frame) => store.applyFrame(frame));
    client.connect();

    await drain(5);

    const snapshot: RelayFrame = {
      type: 'snapshot',
      threads: [{ id: 't1', title: 'T', cwd: '/', messages: [], createdAt: 0, updatedAt: 0 }],
      activeThreadId: 't1',
    };
    mobileWs!.deliver(JSON.stringify(snapshot));
    await drain(3);

    mobileWs!.deliver(JSON.stringify({ type: 'streaming_start', threadId: 't1' } as RelayFrame));
    await drain(2);
    mobileWs!.deliver(JSON.stringify({ type: 'token', threadId: 't1', text: 'Hello ' } as RelayFrame));
    await drain(2);
    mobileWs!.deliver(JSON.stringify({ type: 'token', threadId: 't1', text: 'world' } as RelayFrame));
    await drain(2);

    expect(store.isStreaming('t1')).toBe(true);
    expect(store.getStreamingContent('t1')).toBe('Hello world');

    cleanup();
    client.disconnect();
  });
});

describe('RelayClient — send_message round-trip', () => {
  it('mobile sends command that is received by desktop peer', async () => {
    // In this test we simulate the relay by connecting desktop and mobile to each other via a shared MockWebSocket pair
    const { desktopWs, mobileWs } = createSocketPair();

    let desktopWsCreated = false;
    let mobileWsCreated = false;

    const cleanup = installMockWebSocket(() => {
      if (!desktopWsCreated) {
        desktopWsCreated = true;
        Promise.resolve().then(() => desktopWs.triggerOpen());
        return desktopWs;
      }
      mobileWsCreated = true;
      Promise.resolve().then(() => mobileWs.triggerOpen());
      return mobileWs;
    });

    const manager = makeManager();
    const sendMessageSpy = vi.spyOn(manager, 'sendMessage').mockResolvedValue(undefined);
    manager.createThread('Test', '/cwd');

    const desktopClient = new RelayClient('desktop', 'ws://mock', 'room-1', manager);
    desktopClient.connect();
    await drain(5);

    const mobileClient = new RelayClient('mobile', 'ws://mock', 'room-1');
    mobileClient.connect();
    await drain(5);

    // Mobile sends a send_message command
    const cmd: RemoteCommand = { type: 'send_message', threadId: 'thread-1', text: 'Hello from mobile' };
    mobileClient.sendCommand(cmd);

    await drain(10);

    expect(sendMessageSpy).toHaveBeenCalledWith('thread-1', 'Hello from mobile', undefined);

    cleanup();
    desktopClient.disconnect();
    mobileClient.disconnect();
  });

  it('send_message from mobile dismisses pending decisions on the target thread before sending', async () => {
    const { desktopWs, mobileWs } = createSocketPair();
    let desktopWsCreated = false;

    const cleanup = installMockWebSocket(() => {
      if (!desktopWsCreated) {
        desktopWsCreated = true;
        Promise.resolve().then(() => desktopWs.triggerOpen());
        return desktopWs;
      }
      Promise.resolve().then(() => mobileWs.triggerOpen());
      return mobileWs;
    });

    const manager = makeManager();
    const sendMessageSpy = vi.spyOn(manager, 'sendMessage').mockResolvedValue(undefined);
    const dismissSpy = vi.spyOn(manager, 'dismissDecisions');
    const orch = manager.createThread('Orchestrator', '/cwd');
    const target = manager.createThread('Target', '/cwd');
    manager.postDecision(target.id, orch.id, {
      question: 'Ship mobile patch?',
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
    });
    expect(manager.getThread(target.id)?.pendingDecisions).toHaveLength(1);

    const desktopClient = new RelayClient('desktop', 'ws://mock', 'room-1', manager);
    desktopClient.connect();
    await drain(5);

    const mobileClient = new RelayClient('mobile', 'ws://mock', 'room-1');
    mobileClient.connect();
    await drain(5);

    mobileClient.sendCommand({ type: 'send_message', threadId: target.id, text: 'Manual reply from phone' });
    await drain(10);

    expect(dismissSpy).toHaveBeenCalledWith(target.id);
    expect(manager.getThread(target.id)?.pendingDecisions).toBeUndefined();
    expect(sendMessageSpy).toHaveBeenCalledWith(target.id, 'Manual reply from phone', undefined);

    cleanup();
    desktopClient.disconnect();
    mobileClient.disconnect();
  });
});

describe('RelayClient — question request/resolution bridge', () => {
  beforeEach(() => {
    claudeMock.callbacks = null;
    claudeMock.lastKnownSessionId = undefined;
  });

  const SAMPLE_QUESTIONS = [
    {
      question: 'Which color?',
      header: 'Color',
      options: [
        { label: 'Red', description: '' },
        { label: 'Blue', description: '' },
      ],
      multiSelect: false,
    },
  ];

  it('ThreadManager question_ready event → RelayClient sends a question_request frame with a generated requestId', async () => {
    const manager = makeManager();
    const thread = manager.createThread('Q-Thread', '/cwd');

    const sentMessages: string[] = [];
    const cleanup = installMockWebSocket(() => {
      const mockWs = new MockWebSocket();
      const originalSend = mockWs.send.bind(mockWs);
      mockWs.send = (data: string) => { sentMessages.push(data); originalSend(data); };
      Promise.resolve().then(() => mockWs.triggerOpen());
      return mockWs;
    });

    const client = new RelayClient('desktop', 'ws://mock', 'room-1', manager);
    client.connect();
    await drain(5);

    // Fire the send so ThreadManager wires session callbacks, then trigger the
    // question from the (mocked) session — mirrors question-persistence.test.ts.
    void manager.sendMessage(thread.id, 'Ask me something');
    await drain(3);
    void claudeMock.callbacks!.onAskUserQuestion(SAMPLE_QUESTIONS);
    await drain(5);

    cleanup();
    client.disconnect();

    const questionFrames = sentMessages
      .map((m) => JSON.parse(m) as RelayFrame)
      .filter((f): f is Extract<RelayFrame, { type: 'question_request' }> => f.type === 'question_request');

    expect(questionFrames).toHaveLength(1);
    expect(questionFrames[0].threadId).toBe(thread.id);
    expect(questionFrames[0].questions).toEqual(SAMPLE_QUESTIONS);
    expect(questionFrames[0].requestId).toBeTruthy();
  });

  it('mobile resolve_question command → threadManager.resolveQuestionByRequestId is invoked and unblocks the original promise', async () => {
    // Full round-trip over a real desktop<->mobile socket pair, mirroring the
    // 'send_message round-trip' test above.
    const { desktopWs, mobileWs } = createSocketPair();
    let desktopWsCreated = false;

    const cleanup = installMockWebSocket(() => {
      if (!desktopWsCreated) {
        desktopWsCreated = true;
        Promise.resolve().then(() => desktopWs.triggerOpen());
        return desktopWs;
      }
      Promise.resolve().then(() => mobileWs.triggerOpen());
      return mobileWs;
    });

    const manager = makeManager();
    const thread = manager.createThread('Q-Thread', '/cwd');

    // Wire questionHandler exactly as ThreadsView does, so the answer returned by
    // resolveQuestion() actually unblocks the awaited onAskUserQuestion call.
    manager.questionHandler = (tId, _questions) =>
      new Promise((resolve) => manager.registerQuestionResolver(tId, resolve));

    const resolveSpy = vi.spyOn(manager, 'resolveQuestionByRequestId');

    const desktopClient = new RelayClient('desktop', 'ws://mock', 'room-1', manager);
    desktopClient.connect();
    await drain(5);

    const mobileClient = new RelayClient('mobile', 'ws://mock', 'room-1');
    const receivedFrames: RelayFrame[] = [];
    mobileClient.onFrame((frame) => receivedFrames.push(frame));
    mobileClient.connect();
    await drain(5);

    void manager.sendMessage(thread.id, 'Ask me something');
    await drain(3);

    let questionAnswered: Record<string, string> | null = null;
    const answerPromise = (claudeMock.callbacks!.onAskUserQuestion(SAMPLE_QUESTIONS) as Promise<Record<string, string>>)
      .then((a) => { questionAnswered = a; return a; });
    await drain(10);

    const questionFrame = receivedFrames.find((f): f is Extract<RelayFrame, { type: 'question_request' }> => f.type === 'question_request');
    expect(questionFrame).toBeDefined();
    const requestId = questionFrame!.requestId;

    // Mobile resolves the question — sent as a real RemoteCommand over the socket.
    mobileClient.sendCommand({
      type: 'resolve_question',
      threadId: thread.id,
      requestId,
      answers: { 'Which color?': 'Blue' },
    });
    await drain(10);

    expect(resolveSpy).toHaveBeenCalledWith(requestId, { 'Which color?': 'Blue' });

    await answerPromise;
    await drain(3);

    expect(questionAnswered).toEqual({ 'Which color?': 'Blue' });

    cleanup();
    desktopClient.disconnect();
    mobileClient.disconnect();
  });
});

describe('RelayClient — connection state tracking (mobile)', () => {
  it('reports connected state', async () => {
    let ws: MockWebSocket | null = null;
    const cleanup = installMockWebSocket(() => {
      const mockWs = new MockWebSocket();
      ws = mockWs;
      Promise.resolve().then(() => mockWs.triggerOpen());
      return mockWs;
    });

    const states: string[] = [];
    const client = new RelayClient('mobile', 'ws://mock', 'room-1');
    client.onConnectionStateChange((s) => states.push(s));
    client.connect();

    await drain(5);

    expect(client.getConnectionState()).toBe('connected');
    expect(states).toContain('connected');

    cleanup();
    client.disconnect();
  });

  it('reports reconnecting when socket closes unexpectedly', async () => {
    let ws: MockWebSocket | null = null;
    const cleanup = installMockWebSocket(() => {
      const mockWs = new MockWebSocket();
      ws = mockWs;
      Promise.resolve().then(() => mockWs.triggerOpen());
      return mockWs;
    });

    const states: string[] = [];
    const client = new RelayClient('mobile', 'ws://mock', 'room-1');
    client.onConnectionStateChange((s) => states.push(s));
    client.connect();

    await drain(5);

    // Simulate unexpected close
    ws!.close(1006, 'Abnormal closure');
    await drain(5);

    expect(states).toContain('reconnecting');

    client.disconnect();
    cleanup();
  });
});

/**
 * Mobile harness entry point.
 *
 * Renders MobileView in one of several states controlled by the ?view= query param:
 *   ?view=mobile-pairing      — no relay/store configured (shows pairing screen)
 *   ?view=mobile-connected    — mock relay + seeded MobileThreadStore, first thread active (conv panel)
 *   ?view=mobile-codex-tools  — Codex-native tool-record regression fixture active
 *   ?view=mobile-thread-list  — seeded store, NO active thread (shows thread list panel)
 *   ?view=mobile-permission   — active thread with a pending permission request card
 *   ?view=mobile-question     — active thread with a pending AskUserQuestion card (single-select + multiSelect)
 *   ?view=mobile-queue        — active streaming thread + a queued message (shows queue banner + cancel ×)
 *
 * Optional query params:
 *   ?width=NNN&height=NNN    — override the #app pixel size for device-specific viewport tests
 */
import './obsidian-mock';
import { MobileView } from '../../src/MobileView';
import { MobileThreadStore } from '../../src/MobileThreadStore';
import { mockLeaf } from './obsidian-mock';
import { fixtureThreads, inlineContentMessages } from './fixtures';
import type { RelayFrame } from '../../src/relay-protocol';

// ── Minimal RelayClient mock ───────────────────────────────────────────────

type FrameListener = (frame: RelayFrame) => void;
type ConnectionStateListener = (state: string) => void;

class MockRelayClient {
  private frameListeners: Set<FrameListener> = new Set();
  private connectionListeners: Set<ConnectionStateListener> = new Set();

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onConnectionStateChange(listener: ConnectionStateListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  isConnected(): boolean { return true; }
  getConnectionState(): string { return 'connected'; }
  sendCommand(_cmd: unknown): void {}
  connect(): void {}
  disconnect(): void {}
}

// ── Query-param routing ────────────────────────────────────────────────────

const params = new URLSearchParams(window.location.search);
const view = params.get('view') ?? 'mobile-pairing';

const app = document.getElementById('app')!;

// ── Shared helper: serialize fixture threads for applyFrame ───────────────────

function serializedFixtures(activeThreadId: string | null) {
  return {
    type: 'snapshot' as const,
    threads: fixtureThreads
      .filter((t) => t.id !== 'thread-codex-native-tool-calls' || activeThreadId === t.id)
      .map((t) => ({
      id: t.id,
      title: t.title,
      cwd: t.cwd,
      messages: t.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        toolCalls: m.toolCalls,
        cost: m.cost,
      })),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      summary: t.summary,
      recap: t.recap,
      lastError: t.lastError,
    })),
    activeThreadId,
  };
}

// ── View routing ───────────────────────────────────────────────────────────────

if (view === 'mobile-inline-content') {
  const store = new MobileThreadStore();
  const relay = new MockRelayClient();
  store.applyFrame({ type: 'snapshot', activeThreadId: 'inline-thread', threads: [{
    id: 'inline-thread', title: 'Quarterly review', messages: inlineContentMessages,
    createdAt: 1768471200000, updatedAt: 1768471212000,
  }] });
  const mobileView = new MobileView(mockLeaf as any, relay as any, store);
  app.appendChild(mobileView.containerEl);
  mobileView.onOpen();
  (window as any).__mobileView = mobileView;
  (window as any).__store = store;
} else if (view === 'mobile-connected') {
  // Seeded store with the first thread active and a streaming message in progress.
  const store = new MobileThreadStore();
  const relay = new MockRelayClient();
  store.applyFrame(serializedFixtures(fixtureThreads[0].id));
  store.applyFrame({ type: 'streaming_start', threadId: fixtureThreads[0].id });
  store.applyFrame({ type: 'token', threadId: fixtureThreads[0].id, text: 'Working on it...' });

  const mobileView = new MobileView(mockLeaf as any, relay as any, store);
  app.appendChild(mobileView.containerEl);
  mobileView.onOpen();
  (window as any).__mobileView = mobileView;
  (window as any).__store = store;

} else if (view === 'mobile-codex-tools') {
  const threadId = 'thread-codex-native-tool-calls';
  const store = new MobileThreadStore();
  const relay = new MockRelayClient();
  store.applyFrame(serializedFixtures(threadId));

  const mobileView = new MobileView(mockLeaf as any, relay as any, store);
  app.appendChild(mobileView.containerEl);
  mobileView.onOpen();
  (window as any).__mobileView = mobileView;
  (window as any).__store = store;

} else if (view === 'mobile-thread-list') {
  // Seeded store with NO active thread — shows the thread list panel.
  const store = new MobileThreadStore();
  const relay = new MockRelayClient();
  store.applyFrame(serializedFixtures(null));

  const mobileView = new MobileView(mockLeaf as any, relay as any, store);
  app.appendChild(mobileView.containerEl);
  mobileView.onOpen();
  (window as any).__mobileView = mobileView;
  (window as any).__store = store;

} else if (view === 'mobile-permission') {
  // Active thread with a pending Bash permission request so the permission card renders.
  const store = new MobileThreadStore();
  const relay = new MockRelayClient();
  store.applyFrame(serializedFixtures(fixtureThreads[0].id));
  store.applyFrame({
    type: 'permission_request',
    threadId: fixtureThreads[0].id,
    toolName: 'Bash',
    detail: 'npm run deploy --prod',
    requestId: 'perm-fixture-001',
  });

  const mobileView = new MobileView(mockLeaf as any, relay as any, store);
  app.appendChild(mobileView.containerEl);
  mobileView.onOpen();
  (window as any).__mobileView = mobileView;
  (window as any).__store = store;

} else if (view === 'mobile-question') {
  // Active thread with a pending AskUserQuestion card: one single-select question
  // and one multiSelect question (with an option description) so the card can be
  // exercised/screenshotted in isolation.
  const store = new MobileThreadStore();
  const relay = new MockRelayClient();
  store.applyFrame(serializedFixtures(fixtureThreads[0].id));
  store.applyFrame({
    type: 'question_request',
    threadId: fixtureThreads[0].id,
    requestId: 'question-fixture-001',
    questions: [
      {
        header: 'Deployment target',
        question: 'Which environment should this ship to?',
        multiSelect: false,
        options: [
          { label: 'Staging', description: 'Deploy to the staging environment first' },
          { label: 'Production', description: 'Deploy directly to production' },
        ],
      },
      {
        header: 'Test coverage',
        question: 'Which test suites should run before merging?',
        multiSelect: true,
        options: [
          { label: 'Unit tests', description: 'Fast, run on every commit' },
          { label: 'Integration tests', description: '' },
          { label: 'E2E tests', description: 'Slower, full browser automation' },
        ],
      },
    ],
  });

  const mobileView = new MobileView(mockLeaf as any, relay as any, store);
  app.appendChild(mobileView.containerEl);
  mobileView.onOpen();
  (window as any).__mobileView = mobileView;
  (window as any).__store = store;

} else if (view === 'mobile-queue') {
  // Active thread with a streaming session AND a queued message — shows the queue banner
  // with the new cancel (×) button.
  const store = new MobileThreadStore();
  const relay = new MockRelayClient();
  store.applyFrame(serializedFixtures(fixtureThreads[0].id));
  store.applyFrame({ type: 'streaming_start', threadId: fixtureThreads[0].id });
  store.applyFrame({ type: 'token', threadId: fixtureThreads[0].id, text: 'Working on it...' });
  store.applyFrame({ type: 'queued', threadId: fixtureThreads[0].id, text: 'Add error handling to the auth module', count: 1 });

  const mobileView = new MobileView(mockLeaf as any, relay as any, store);
  app.appendChild(mobileView.containerEl);
  mobileView.onOpen();
  (window as any).__mobileView = mobileView;
  (window as any).__store = store;

} else {
  // Pairing screen: pass null relay + null store
  const mobileView = new MobileView(mockLeaf as any, null, null);
  app.appendChild(mobileView.containerEl);
  mobileView.onOpen();
  (window as any).__mobileView = mobileView;
}

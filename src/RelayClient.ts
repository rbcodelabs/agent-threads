/**
 * RelayClient.ts
 *
 * Manages the WebSocket connection to the Agent Threads relay server.
 * Operates in two modes determined at construction:
 *
 * - desktop: forwards ThreadManager events to mobile; handles RemoteCommands
 *   from mobile and dispatches them to ThreadManager.
 * - mobile: receives RelayFrames and notifies registered listeners; sends
 *   RemoteCommands to desktop. Queues commands when disconnected.
 */

import type { ThreadManager } from './ThreadManager';
import type {
  RelayFrame,
  RemoteCommand,
  SerializedThread,
  SerializedMessage,
  ConnectionState,
} from './relay-protocol';
import type { Thread, ChatMessage } from './types';
import { debugLog } from './logger';
import { RECONNECT_BACKOFF_MS } from './remote/backoff';

type FrameListener = (frame: RelayFrame) => void;
type ConnectionStateListener = (state: ConnectionState) => void;

/** How long to wait for a pong before assuming the connection is dead (mobile mode). */
const PONG_TIMEOUT_MS = 10_000;
/** How often to send pings (mobile mode). */
const PING_INTERVAL_MS = 20_000;

/** Backoff sequence in ms, capped at 30s. */
const BACKOFF = RECONNECT_BACKOFF_MS;

function serializeThread(thread: Thread): SerializedThread {
  return {
    id: thread.id,
    title: thread.title,
    cwd: thread.cwd,
    messages: thread.messages.map(serializeMessage),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    sessionId: thread.sessionId,
    agentHarness: thread.agentHarness,
    recap: thread.recap,
    summary: thread.summary,
    lastError: thread.lastError,
    model: thread.model,
    projectId: thread.projectId,
    reviewed: thread.reviewed,
  };
}

function serializeMessage(msg: ChatMessage): SerializedMessage {
  return {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
    toolCalls: msg.toolCalls,
    cost: msg.cost,
    compactTrigger: msg.compactTrigger,
    preTokens: msg.preTokens,
    images: msg.images,
  };
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  // Desktop-mode state
  private threadManagerUnsub: (() => void) | null = null;
  private activeThreadIdForDesktop: string | null = null;
  /**
   * Called in desktop mode when a mobile client joins. Returns the current
   * pairingExpiresAt value (null means pairing is already complete / no expiry
   * applies). Injected by the plugin after construction.
   */
  getPairingExpiresAt: (() => number | null) | null = null;
  /**
   * Called in desktop mode after a successful first join to mark pairing
   * complete (clear the expiry so reconnects are always allowed).
   */
  onPairingComplete: (() => void) | null = null;
  /**
   * Called in desktop mode when a mobile client sends resolve_permission with
   * alwaysAllow=true. The plugin injects this to add the tool to alwaysAllowedTools.
   */
  onAlwaysAllowTool: ((toolName: string) => void) | null = null;

  /** Maps requestId → toolName so alwaysAllow can be persisted on the desktop. */
  private permissionToolNames: Map<string, string> = new Map();

  // Mobile-mode state
  private frameListeners: Set<FrameListener> = new Set();
  private connectionListeners: Set<ConnectionStateListener> = new Set();
  private connectionState: ConnectionState = 'disconnected';
  private commandQueue: RemoteCommand[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly mode: 'desktop' | 'mobile',
    private readonly relayUrl: string,
    private readonly roomId: string,
    private readonly threadManager?: ThreadManager,
  ) {}

  // ── Public API ──────────────────────────────────────────────────────────

  connect(): void {
    if (this.destroyed) return;
    this.openWebSocket();
  }

  disconnect(): void {
    this.destroyed = true;
    this.stopReconnect();
    this.stopPingPong();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnecting');
      this.ws = null;
    }
    this.threadManagerUnsub?.();
    this.threadManagerUnsub = null;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Send a frame to the relay (desktop mode — sends RelayFrames to mobile).
   * Silently drops if not connected; callers in desktop mode handle reconnect
   * by re-sending a snapshot on reconnect.
   */
  sendFrame(frame: RelayFrame): void {
    if (!this.isConnected()) return;
    try {
      this.ws!.send(JSON.stringify(frame));
    } catch (err) {
      console.error('[RelayClient] sendFrame error:', err);
    }
  }

  /**
   * Send a command to the relay (mobile mode — sends RemoteCommands to desktop).
   * Queues the command if not currently connected; flushes on reconnect.
   */
  sendCommand(command: RemoteCommand): void {
    if (!this.isConnected()) {
      this.commandQueue.push(command);
      return;
    }
    try {
      this.ws!.send(JSON.stringify(command));
    } catch (err) {
      console.error('[RelayClient] sendCommand error:', err);
      this.commandQueue.push(command);
    }
  }

  /** Register a listener for incoming RelayFrames (mobile mode). */
  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** Register a listener for connection state changes (mobile mode). */
  onConnectionStateChange(listener: ConnectionStateListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  /** Track which thread is active on desktop so snapshot can include it. */
  setActiveThreadId(threadId: string | null): void {
    this.activeThreadIdForDesktop = threadId;
  }

  // ── Private: WebSocket lifecycle ────────────────────────────────────────

  private openWebSocket(): void {
    if (this.destroyed) return;

    const url = `${this.relayUrl}/room/${this.roomId}?role=${this.mode}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error('[RelayClient] WebSocket constructor failed:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      debugLog(`[RelayClient] Connected as ${this.mode}`);

      if (this.mode === 'desktop') {
        this.sendSnapshot();
        this.subscribeToThreadManager();
      } else {
        this.setConnectionState('connected');
        this.flushCommandQueue();
        this.startPingPong();
      }
    });

    ws.addEventListener('message', (event) => {
      this.handleMessage(event.data as string);
    });

    ws.addEventListener('close', (_event) => {
      debugLog(`[RelayClient] WebSocket closed (${this.mode})`);
      this.ws = null;
      this.stopPingPong();

      if (this.mode === 'desktop') {
        this.threadManagerUnsub?.();
        this.threadManagerUnsub = null;
      } else {
        this.setConnectionState('reconnecting');
      }

      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    });

    ws.addEventListener('error', (event) => {
      console.error('[RelayClient] WebSocket error:', event);
      // The close event fires after error, so reconnect happens there.
    });
  }

  private handleMessage(raw: string): void {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      console.warn('[RelayClient] Received non-JSON message, ignoring');
      return;
    }

    if (typeof data !== 'object' || data === null || !('type' in data)) return;
    const msg = data as { type: string };

    if (this.mode === 'desktop') {
      // The relay itself sends mobile_joined; this is not a RemoteCommand from the plugin.
      if (msg.type === 'mobile_joined') {
        // Enforce pairing expiry on first-time joins. Once pairing is complete
        // (pairingExpiresAt is null) reconnects from the already-paired device
        // are always allowed.
        const expiresAt = this.getPairingExpiresAt?.() ?? null;
        if (expiresAt !== null && Date.now() > expiresAt) {
          // Code has expired before the mobile scanned it — disconnect and inform.
          this.sendFrame({ type: 'error', threadId: '', error: 'Pairing code expired. Generate a new code in Settings > Remote Access.' });
          console.warn('[RelayClient] Rejected mobile_joined: pairing code expired');
          return;
        }
        // Mark pairing complete on the first successful join (while code was valid).
        if (expiresAt !== null) {
          this.onPairingComplete?.();
        }
        this.sendSnapshot();
        return;
      }
      this.handleRemoteCommand(msg as RemoteCommand);
    } else {
      const frame = msg as RelayFrame;

      // Handle pong before emitting to listeners
      if (frame.type === 'pong') {
        this.clearPongTimeout();
        return;
      }

      // Emit to all registered frame listeners (MobileThreadStore, MobileView, etc.)
      for (const listener of this.frameListeners) {
        try {
          listener(frame);
        } catch (err) {
          console.error('[RelayClient] Frame listener error:', err);
        }
      }
    }
  }

  private handleRemoteCommand(cmd: RemoteCommand): void {
    if (!this.threadManager) return;

    switch (cmd.type) {
      case 'ping':
        this.sendFrame({ type: 'pong' });
        break;

      case 'send_message':
        this.threadManager.sendMessage(cmd.threadId, cmd.text, cmd.images).catch((err) => {
          console.error('[RelayClient] send_message error:', err);
        });
        break;

      case 'stop_session':
        this.threadManager.interrupt(cmd.threadId).catch((err) => {
          console.error('[RelayClient] stop_session error:', err);
        });
        break;

      case 'resolve_permission':
        // 3.11 — If alwaysAllow, fire the plugin callback before resolving
        if (cmd.alwaysAllow) {
          const toolName = this.permissionToolNames.get(cmd.requestId);
          if (toolName && this.onAlwaysAllowTool) {
            this.onAlwaysAllowTool(toolName);
          }
        }
        this.threadManager.resolvePermissionByRequestId(cmd.requestId, cmd.allow);
        break;

      case 'resolve_question':
        this.threadManager.resolveQuestionByRequestId(cmd.requestId, cmd.answers);
        break;

      case 'cancel_queued_message':
        this.threadManager.removeQueuedMessageAt(cmd.threadId, cmd.index);
        // Send a dequeued frame so mobile updates its banner immediately.
        this.sendFrame({ type: 'dequeued', threadId: cmd.threadId });
        break;

      case 'create_thread': {
        const thread = this.threadManager.createThread(cmd.title, cmd.cwd);
        // Snapshot will propagate the new thread; thread_created event also fires
        void thread;
        break;
      }

      case 'set_active_thread':
        this.activeThreadIdForDesktop = cmd.threadId;
        break;

      default:
        console.warn('[RelayClient] Unknown remote command type:', (cmd as { type: string }).type);
    }
  }

  // ── Private: Desktop snapshot and subscription ─────────────────────────

  private sendSnapshot(): void {
    if (!this.threadManager) return;
    const threads = this.threadManager.getThreads().map(serializeThread);

    // Diagnostic logging — visible in desktop DevTools console
    const totalMessages = threads.reduce((sum, t) => sum + t.messages.length, 0);
    const payloadJson = JSON.stringify({ type: 'snapshot', threads, activeThreadId: this.activeThreadIdForDesktop });
    debugLog(
      `[RelayClient] Sending snapshot: ${threads.length} threads, ${totalMessages} total messages, ${(payloadJson.length / 1024).toFixed(1)} KB`,
      threads.map(t => `${t.title}: ${t.messages.length} msgs`),
    );

    // If payload exceeds 900 KB warn loudly — Cloudflare DO WebSocket limit is ~1 MB.
    if (payloadJson.length > 900_000) {
      console.warn(`[RelayClient] Snapshot payload is ${(payloadJson.length / 1024).toFixed(0)} KB — approaching Cloudflare WebSocket 1 MB limit. Consider sending threads in batches.`);
    }

    this.sendFrame({
      type: 'snapshot',
      threads,
      activeThreadId: this.activeThreadIdForDesktop,
    });
  }

  private subscribeToThreadManager(): void {
    if (!this.threadManager) return;
    this.threadManagerUnsub?.();

    this.threadManagerUnsub = this.threadManager.subscribe((threadId, event) => {
      const thread = this.threadManager!.getThread(threadId);

      switch (event.type) {
        case 'streaming_start': {
          // Before announcing that streaming has started, send the user message
          // that was just pushed to thread.messages so mobile can display it.
          // Without this the user's own message never appears in the mobile chat —
          // only the assistant's final reply does (via the 'message' frame below).
          const lastMsg = thread?.messages.at(-1);
          if (lastMsg?.role === 'user') {
            this.sendFrame({ type: 'message', threadId, message: serializeMessage(lastMsg) });
          }
          this.sendFrame({ type: 'streaming_start', threadId });
          break;
        }

        case 'token':
          this.sendFrame({ type: 'token', threadId, text: event.text });
          break;

        case 'tool_use':
          this.sendFrame({ type: 'tool_use', threadId, name: event.record.name, summary: event.record.summary });
          break;

        case 'message':
          this.sendFrame({ type: 'message', threadId, message: serializeMessage(event.message) });
          break;

        case 'done':
          this.sendFrame({ type: 'done', threadId });
          break;

        case 'error':
          this.sendFrame({ type: 'error', threadId, error: event.error.message });
          break;

        case 'thread_created':
          if (thread) {
            this.sendFrame({ type: 'thread_created', thread: serializeThread(thread) });
          }
          break;

        case 'thread_deleted':
          this.sendFrame({ type: 'thread_deleted', threadId });
          break;

        case 'thread_renamed':
          this.sendFrame({ type: 'thread_renamed', threadId, title: event.title });
          break;

        case 'status':
          this.sendFrame({ type: 'status', threadId, status: event.status });
          break;

        case 'permission_request': {
          // Generate a stable requestId for this permission so mobile can reference it.
          // Register a resolver in ThreadManager so resolve_permission commands work.
          const requestId = crypto.randomUUID();
          // Always Allow is never remembered for a remote thread (the tool name is the daemon's word).
          if (!this.threadManager!.isRemoteThread(threadId)) this.permissionToolNames.set(requestId, event.toolName);
          this.threadManager!.registerRemotePermissionResolver(requestId, (allow) => {
            this.permissionToolNames.delete(requestId);
            this.threadManager!.resolvePermission(threadId, allow);
          });
          this.sendFrame({
            type: 'permission_request',
            threadId,
            toolName: event.toolName,
            detail: event.detail,
            requestId,
          });
          break;
        }

        case 'permission_resolved':
          // Emit to mobile so it can remove the permission card
          // We don't have a requestId here so we emit a generic resolved signal
          // keyed by threadId; mobile clears the first pending permission for the thread.
          this.sendFrame({ type: 'permission_resolved', threadId, requestId: '' });
          break;

        case 'question_ready': {
          // Generate a stable requestId for this question set so mobile can reference it.
          // Register a resolver in ThreadManager so resolve_question commands work.
          const requestId = crypto.randomUUID();
          this.threadManager!.registerRemoteQuestionResolver(requestId, (answers) => {
            this.threadManager!.resolveQuestion(threadId, answers);
          });
          this.sendFrame({
            type: 'question_request',
            threadId,
            questions: event.questions,
            requestId,
          });
          break;
        }

        case 'pending_question_changed':
          // Only forward the "resolved" side — question_ready already covers the
          // "arrived" side, so forwarding both here would double-fire the card.
          if (event.questions === undefined) {
            // No requestId here (mirrors permission_resolved); mobile clears the
            // first pending question for the thread as a fallback.
            this.sendFrame({ type: 'question_resolved', threadId, requestId: '' });
          }
          break;

        case 'active_thread_changed':
          this.activeThreadIdForDesktop = threadId;
          break;

        case 'queued':
          this.sendFrame({ type: 'queued', threadId, text: event.text, count: this.threadManager!.getQueuedCount(threadId) });
          break;

        case 'dequeued':
          this.sendFrame({ type: 'dequeued', threadId });
          break;

        // Events not forwarded to mobile (desktop-only)
        case 'recap':
        case 'escalated':
        case 'compact':
        case 'task_started':
        case 'task_progress':
        case 'task_notification':
        case 'notification':
        case 'api_retry':
        case 'permission_denied':
        case 'rate_limit':
        case 'interrupted':
          break;

        default:
          // Exhaustive check
          break;
      }
    });
  }

  // ── Private: Reconnect ─────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    const delay = BACKOFF[Math.min(this.reconnectAttempt, BACKOFF.length - 1)];
    this.reconnectAttempt++;
    debugLog(`[RelayClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openWebSocket();
    }, delay);
  }

  private stopReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Private: Ping/pong (mobile mode) ────────────────────────────────────

  private startPingPong(): void {
    this.stopPingPong();
    this.pingTimer = setInterval(() => {
      if (!this.isConnected()) return;
      this.sendCommand({ type: 'ping' });
      // Start pong timeout
      this.pongTimeoutTimer = setTimeout(() => {
        console.warn('[RelayClient] Pong timeout — assuming disconnected');
        this.ws?.close();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private clearPongTimeout(): void {
    if (this.pongTimeoutTimer !== null) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }
  }

  private stopPingPong(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongTimeout();
  }

  // ── Private: Command queue (mobile mode) ────────────────────────────────

  private flushCommandQueue(): void {
    const queue = this.commandQueue.splice(0);
    for (const cmd of queue) {
      this.sendCommand(cmd);
    }
  }

  // ── Private: Connection state (mobile mode) ──────────────────────────────

  private setConnectionState(state: ConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    for (const listener of this.connectionListeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('[RelayClient] Connection state listener error:', err);
      }
    }
  }
}

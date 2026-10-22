/**
 * HostToolBroker: the daemon's half of host-tool proxying (design 3.3 / 3.6).
 *
 * Claude on the daemon calls an in-process MCP tool (daemon/hostMcpServer.ts); the handler asks this broker to
 * run it in the user's Geode. The broker journals a `tool.call` (an open request, so a client that reattaches
 * is shown it again), waits for the thread's controlling client to answer with `tool.result`, and returns the
 * outcome to the handler. It owns every rule that keeps that round trip safe:
 *
 *   - only tools in the manifest the client sent can be called, with bounded input;
 *   - a `callId` is a daemon-made UUID bound to ONE thread: `resolve` ignores a call id from another thread
 *     (the connection layer additionally requires the sender to hold that thread's seat);
 *   - never hangs: with no client attached a call waits at most `graceMs` for one, then fails with a
 *     model-readable error; once issued it waits at most `timeoutMs` for the answer, and `graceMs` again after
 *     the client detaches;
 *   - bounded fan-out: at most `HOST_TOOL_LIMITS.maxConcurrentCallsPerThread` open calls per thread.
 *
 * It holds no secrets and logs no payloads: audit records carry the server, tool name and sizes only.
 */
import { randomUUID } from 'node:crypto';
import {
  HOST_TOOL_LIMITS,
  checkCallInput,
  clampResultText,
  findManifestTool,
  hostUnavailableText,
  isHostResourceTool,
  manifestSignature,
  sanitizeResultContent,
  asStructuredContent,
  type RemoteHostToolSpec,
  type ResultBlock,
  type WireEvent,
} from '../src/protocol';

export interface HostToolOutcome {
  success: boolean;
  text: string;
  content?: ResultBlock[];
  /** MCP `structuredContent` from the host tool: a bounded plain JSON object, or absent. Never journaled or audited. */
  structuredContent?: Record<string, unknown>;
}

export interface HostToolBrokerOptions {
  /** Wait for a client to (re)attach before failing a call (ms). */
  graceMs: number;
  /** Wait for an attached client to answer an issued call (ms). */
  timeoutMs: number;
  /** Append an event to the thread's journal (and so to every attached client). */
  emit(threadId: string, event: WireEvent): void;
  audit?(record: Record<string, unknown>): void;
  newId?: () => string;
}

interface Pending {
  threadId: string;
  server: string;
  tool: string;
  input: Record<string, unknown>;
  issued: boolean;
  done: boolean;
  resolve(outcome: HostToolOutcome): void;
  graceTimer?: ReturnType<typeof setTimeout>;
  answerTimer?: ReturnType<typeof setTimeout>;
  abort?: { signal: AbortSignal; listener: () => void };
}

export type Manifest = Record<string, RemoteHostToolSpec[]>;

const failure = (text: string): HostToolOutcome => ({ success: false, text });

export class HostToolBroker {
  private readonly manifests = new Map<string, Manifest>();
  private readonly signatures = new Map<string, string>();
  private readonly attachedThreads = new Set<string>();
  /** Connection currently holding each thread's read-write seat. */
  private readonly seatHolders = new Map<string, number>();
  /** Connection that sent each thread's current manifest (the only one that can serve its calls). */
  private readonly manifestOwners = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();
  private readonly changeListeners = new Map<string, Set<() => void>>();
  private readonly newId: () => string;

  constructor(private readonly opts: HostToolBrokerOptions) {
    this.newId = opts.newId ?? randomUUID;
  }

  get graceSec(): number { return Math.round(this.opts.graceMs / 1000); }

  // ── attach state ─────────────────────────────────────────────────────────

  isAttached(threadId: string): boolean { return this.attachedThreads.has(threadId); }

  /** The thread gained or lost its controlling client. */
  setAttached(threadId: string, attached: boolean): void {
    if (attached === this.attachedThreads.has(threadId)) return;
    if (attached) this.attachedThreads.add(threadId); else this.attachedThreads.delete(threadId);
    for (const [callId, p] of this.pending) {
      if (p.threadId !== threadId || p.done) continue;
      if (attached) {
        if (p.graceTimer) { clearTimeout(p.graceTimer); p.graceTimer = undefined; }
        if (!p.issued) this.issue(callId, p);
      } else if (p.issued && !p.graceTimer) {
        // Issued, and its client went away: give it the grace period to come back and answer.
        p.graceTimer = this.timer(() => this.fail(callId, p, 'detached'), this.opts.graceMs);
      }
    }
    this.notify(threadId);
  }

  /**
   * The seat holder changed (`undefined` = nobody). A thread counts as host-tool-attached only while the seat is
   * held by the SAME connection that sent the current manifest: a terminal that claims the seat (attach --claim,
   * run --thread) cannot answer a call for tools it never offered, so calls fail fast after the grace instead
   * of waiting out the answer timeout.
   */
  setSeatHolder(threadId: string, connectionId: number | undefined): void {
    if (connectionId === undefined) this.seatHolders.delete(threadId); else this.seatHolders.set(threadId, connectionId);
    this.reconcile(threadId);
  }

  private reconcile(threadId: string): void {
    const seat = this.seatHolders.get(threadId);
    this.setAttached(threadId, seat !== undefined && seat === this.manifestOwners.get(threadId));
  }

  // ── manifest ─────────────────────────────────────────────────────────────

  /**
   * Replace a thread's manifest. `owner` is the connection that sent it (omit only for a recipe restored from disk,
   * which no connection stands behind yet). @returns whether it differs from the previous one.
   */
  setManifest(threadId: string, servers: Manifest, owner?: number): boolean {
    const sig = manifestSignature(servers);
    const changed = this.signatures.get(threadId) !== sig;
    this.manifests.set(threadId, servers);
    this.signatures.set(threadId, sig);
    if (owner !== undefined) { this.manifestOwners.set(threadId, owner); this.reconcile(threadId); }
    if (changed) this.notify(threadId);
    return changed;
  }

  manifest(threadId: string): Manifest { return this.manifests.get(threadId) ?? {}; }

  /** Attach state or manifest changed for this thread. */
  onChange(threadId: string, cb: () => void): () => void {
    let set = this.changeListeners.get(threadId);
    if (!set) { set = new Set(); this.changeListeners.set(threadId, set); }
    set.add(cb);
    return () => { set!.delete(cb); };
  }

  private notify(threadId: string): void {
    for (const cb of [...(this.changeListeners.get(threadId) ?? [])]) {
      try { cb(); } catch (err) { console.error('[daemon] host tool listener failed:', err); }
    }
  }

  // ── calls ────────────────────────────────────────────────────────────────

  openCalls(threadId: string): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.threadId === threadId && !p.done) n++;
    return n;
  }

  /** Run one host tool. Never rejects: every failure is a model-readable outcome. */
  call(threadId: string, server: string, tool: string, input: unknown, signal?: AbortSignal): Promise<HostToolOutcome> {
    const manifest = this.manifests.get(threadId);
    // Resource requests name a server the client offered (any tool of it), not a manifest tool.
    const offered = isHostResourceTool(tool)
      ? Boolean(manifest && Object.prototype.hasOwnProperty.call(manifest, server) && server !== 'claude_threads')
      : findManifestTool(manifest, server, tool) !== undefined;
    if (!offered) return Promise.resolve(failure(`The host tool "${server}/${tool}" is not available in this session.`));
    const bad = checkCallInput(input ?? {});
    if (bad) return Promise.resolve(failure(`The host tool "${tool}" was not run: ${bad}.`));
    if (this.openCalls(threadId) >= HOST_TOOL_LIMITS.maxConcurrentCallsPerThread) {
      return Promise.resolve(failure(`Too many host tool calls are in flight (limit ${HOST_TOOL_LIMITS.maxConcurrentCallsPerThread}); wait for some to finish and retry.`));
    }
    if (signal?.aborted) return Promise.resolve(failure(hostUnavailableText(tool, this.graceSec, 'canceled')));

    return new Promise<HostToolOutcome>((resolve) => {
      const callId = this.newId();
      const p: Pending = { threadId, server, tool, input: (input ?? {}) as Record<string, unknown>, issued: false, done: false, resolve };
      this.pending.set(callId, p);
      if (signal) {
        const listener = () => this.cancel(callId, p, 'canceled');
        signal.addEventListener('abort', listener, { once: true });
        p.abort = { signal, listener };
      }
      if (this.attachedThreads.has(threadId)) this.issue(callId, p);
      else p.graceTimer = this.timer(() => this.fail(callId, p, 'detached'), this.opts.graceMs);
    });
  }

  /**
   * The client answered. Only a call that is open, issued, and bound to THIS thread resolves; anything else
   * (unknown id, another thread's id, a repeat) is refused.
   */
  resolve(threadId: string, callId: string, result: { success: boolean; text: string; content?: unknown[]; structuredContent?: unknown }, by: string): boolean {
    const p = this.pending.get(callId);
    if (!p || p.threadId !== threadId || !p.issued || p.done) return false;
    const { text, truncated } = clampResultText(result.text);
    const content = sanitizeResultContent(result.content);
    // Passed through unchanged; the frame limit already bounded it. Only a non-object is treated as absent.
    const structuredContent = asStructuredContent(result.structuredContent);
    this.finish(callId, p, { success: result.success === true, text, ...(content.length ? { content } : {}), ...(structuredContent ? { structuredContent } : {}) });
    this.opts.emit(threadId, { name: 'request_resolved', args: { requestId: callId, by, outcome: 'resolved' } });
    this.opts.audit?.({ event: 'host_tool_result', threadId, server: p.server, tool: p.tool, ok: result.success === true, chars: result.text.length, truncated, blocks: content.length, ...(structuredContent ? { structured: true } : {}) });
    return true;
  }

  /** The session is ending: every open call fails with a canceled outcome. */
  cancelThread(threadId: string): void {
    for (const [callId, p] of [...this.pending]) if (p.threadId === threadId && !p.done) this.cancel(callId, p, 'canceled');
  }

  /** Drop all state (graceful shutdown). */
  shutdown(): void {
    for (const [callId, p] of [...this.pending]) if (!p.done) this.cancel(callId, p, 'canceled');
    this.changeListeners.clear();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private timer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  }

  private issue(callId: string, p: Pending): void {
    p.issued = true;
    this.opts.emit(p.threadId, { name: 'tool.call', args: { callId, threadId: p.threadId, server: p.server, tool: p.tool, input: p.input } });
    p.answerTimer = this.timer(() => this.fail(callId, p, 'timeout'), this.opts.timeoutMs);
    this.opts.audit?.({ event: 'host_tool_call', threadId: p.threadId, server: p.server, tool: p.tool });
  }

  private finish(callId: string, p: Pending, outcome: HostToolOutcome): void {
    if (p.done) return;
    p.done = true;
    if (p.graceTimer) clearTimeout(p.graceTimer);
    if (p.answerTimer) clearTimeout(p.answerTimer);
    if (p.abort) p.abort.signal.removeEventListener('abort', p.abort.listener);
    this.pending.delete(callId);
    p.resolve(outcome);
  }

  /** Failed because no host could serve it: tell the model, and journal it so the user hears about it later. */
  private fail(callId: string, p: Pending, why: 'detached' | 'timeout'): void {
    if (p.done) return;
    const wasIssued = p.issued;
    this.finish(callId, p, failure(hostUnavailableText(p.tool, this.graceSec, why)));
    if (wasIssued) this.opts.emit(p.threadId, { name: 'tool.cancel', args: { callId } });
    this.opts.emit(p.threadId, { name: 'tool.unavailable', args: { callId, server: p.server, tool: p.tool, reason: why } });
    this.opts.audit?.({ event: 'host_tool_unavailable', threadId: p.threadId, server: p.server, tool: p.tool, reason: why });
  }

  /** Canceled by the harness (interrupt) or the session ending. */
  private cancel(callId: string, p: Pending, _why: 'canceled'): void {
    if (p.done) return;
    const wasIssued = p.issued;
    this.finish(callId, p, failure(hostUnavailableText(p.tool, this.graceSec, 'canceled')));
    if (wasIssued) this.opts.emit(p.threadId, { name: 'tool.cancel', args: { callId } });
  }
}

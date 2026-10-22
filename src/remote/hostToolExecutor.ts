/**
 * HostToolExecutor: the plugin's gate in front of every `tool.call` a daemon makes (design 3.6, security).
 *
 * `tool.call` is a remote-control surface: a daemon that is compromised, or simply buggy, could ask this
 * computer to run any tool. So nothing the daemon says is trusted:
 *
 *   - only a tool in the manifest THIS plugin sent for this thread can run (name AND server, exact match);
 *   - the frame is shape-checked and size-capped before anything is read from it;
 *   - concurrent calls (per thread and in total) and calls per minute are capped;
 *   - a tool that requires approval is gated here, by the same permission path a local agent uses, whatever the
 *     daemon says happened on its side. The card this plugin builds (showing the real input) is the ONLY
 *     authority: an allow on a card the daemon wrote is never carried over, and an input too long to show in
 *     full is refused rather than run unseen;
 *   - results are clamped and structured content is limited to what the daemon will pass on.
 *
 * A call id already seen is never run twice: a reopened call that finished gets its stored result re-sent, one
 * still running is left alone.
 */
import { HOST_TOOL_LIMITS, checkCallInput, clampResultText, findManifestTool, isHostResourceTool, sanitizeResultContent, asStructuredContent, fitStructuredContent, type RemoteHostToolSpec } from '../protocol';
import type { HostToolOutput } from './hostTools';

/** Calls in flight across all threads; one instance per plugin. */
export class HostToolSlots {
  private active = 0;
  constructor(private readonly max: number = HOST_TOOL_LIMITS.maxConcurrentCallsTotal) {}
  acquire(): (() => void) | null {
    if (this.active >= this.max) return null;
    this.active++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }
  get inFlight(): number { return this.active; }
}

export interface HostToolExecutorDeps {
  /** The manifest this plugin sent for the thread (what is allowed to run). */
  manifest(): Record<string, readonly RemoteHostToolSpec[]> | null;
  invoke(server: string, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<HostToolOutput>;
  /** The thread's normal permission prompt (pre-approvals, permission mode and the card all live behind it). */
  requestPermission(toolName: string, detail: string): Promise<boolean>;
  /**
   * A standing approval the USER granted for this exact call (today only a saved host_exec command prefix). When
   * true no card is shown, so the input-too-long-for-the-card refusal does not apply: the user already trusted the
   * tool. Nothing the daemon sends can make it true; it throws or returns false to fall back to the card.
   */
  isPreApproved?(server: string, tool: string, input: Record<string, unknown>): boolean;
  sendResult(callId: string, result: { success: boolean; text: string; content?: unknown[]; structuredContent?: Record<string, unknown> }): Promise<void>;
  slots: HostToolSlots;
  now?: () => number;
  log?: (message: string) => void;
}

type CallState = { state: 'running'; abort: AbortController } | { state: 'done'; result: { success: boolean; text: string; content?: unknown[]; structuredContent?: Record<string, unknown> } };

const REMEMBERED_CALLS = 64;
/**
 * How much of a call's input the approval card shows. A call that needs a card and exceeds this is never executed
 * unseen. 64 KB holds a large document write; the card scrolls (see `.ct-permission-field-value`).
 */
export const APPROVAL_DETAIL_LIMIT = 64 * 1024;

/**
 * What the approval card shows for a call. `unseenBytes` > 0 means the serialized input is longer than the card
 * can display (the detail then ends with an explicit marker); the executor refuses such a call.
 */
export function describeCallForApproval(toolName: string, input: Record<string, unknown>): { detail: string; unseenBytes: number } {
  const full = JSON.stringify(input);
  const shown = full.slice(0, APPROVAL_DETAIL_LIMIT);
  const unseenBytes = new TextEncoder().encode(full.slice(APPROVAL_DETAIL_LIMIT)).length;
  const marker = unseenBytes > 0 ? ` ... (${unseenBytes} more bytes not shown)` : '';
  return { detail: `Run ${toolName} for a remote thread: ${shown}${marker}`, unseenBytes };
}

export const mcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`;

const refusal = (text: string): { success: false; text: string } => ({ success: false, text });

export class HostToolExecutor {
  private readonly calls = new Map<string, CallState>();
  private recent: number[] = [];
  private active = 0;
  private readonly now: () => number;

  constructor(private readonly deps: HostToolExecutorDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** A `tool.call` event arrived (live, replayed, or reopened). */
  handleCall(raw: unknown, reopened = false): void {
    const a = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const { callId, server, tool, input } = a;
    // Without a usable call id there is nothing to answer.
    if (typeof callId !== 'string' || callId.length === 0 || callId.length > 128) { this.deps.log?.('ignoring tool.call without a usable callId'); return; }

    const known = this.calls.get(callId);
    if (known) {
      // Reopened after a reconnect: a finished call gets its answer again; a running one will answer itself.
      if (known.state === 'done' && reopened) void this.send(callId, known.result);
      return;
    }
    if (typeof server !== 'string' || typeof tool !== 'string') { this.answer(callId, refusal('Malformed host tool call.')); return; }

    const spec = isHostResourceTool(tool) ? this.resourceSpec(server, tool) : findManifestTool(this.deps.manifest() ?? undefined, server, tool);
    if (!spec) {
      this.deps.log?.(`REFUSED tool.call for ${server}/${tool.slice(0, 60)}: not in the manifest this client sent`);
      this.answer(callId, refusal(`The host tool "${server}/${tool}" is not offered in this session.`));
      return;
    }
    const badInput = checkCallInput(input);
    if (badInput) { this.answer(callId, refusal(`The host tool "${tool}" was not run: ${badInput}.`)); return; }

    const t = this.now();
    this.recent = this.recent.filter((x) => x > t - 60_000);
    if (this.recent.length >= HOST_TOOL_LIMITS.maxCallsPerMinute) {
      this.deps.log?.(`REFUSED tool.call ${server}/${tool}: more than ${HOST_TOOL_LIMITS.maxCallsPerMinute} calls in a minute`);
      this.answer(callId, refusal('Too many host tool calls in the last minute; slow down.'));
      return;
    }
    if (this.active >= HOST_TOOL_LIMITS.maxConcurrentCallsPerThread) { this.answer(callId, refusal('Too many host tool calls are running at once for this thread.')); return; }
    const release = this.deps.slots.acquire();
    if (!release) { this.answer(callId, refusal('Too many host tool calls are running at once; retry shortly.')); return; }
    this.recent.push(t);
    this.active++;

    const abort = new AbortController();
    this.calls.set(callId, { state: 'running', abort });
    void this.run(callId, spec, input as Record<string, unknown>, abort).finally(() => { this.active--; release(); });
  }

  /**
   * A resource request (`resources/list`, `resources/read`) is read-only and needs no card, but it may only name a
   * server this client offered in its manifest, so the daemon cannot reach one the user did not switch on.
   */
  private resourceSpec(server: string, tool: string): RemoteHostToolSpec | undefined {
    const manifest = this.deps.manifest();
    if (!manifest || !Object.prototype.hasOwnProperty.call(manifest, server)) return undefined;
    return { name: tool, description: '', inputSchema: {}, requiresApproval: false, server };
  }

  /** `tool.cancel`: the daemon gave up on the call (interrupt, timeout). */
  handleCancel(callId: unknown): void {
    if (typeof callId !== 'string') return;
    const c = this.calls.get(callId);
    if (c?.state === 'running') c.abort.abort();
  }

  /** The session is going away: stop everything that is running. */
  abortAll(): void {
    for (const c of this.calls.values()) if (c.state === 'running') c.abort.abort();
  }

  private async run(callId: string, spec: RemoteHostToolSpec, input: Record<string, unknown>, abort: AbortController): Promise<void> {
    const name = mcpToolName(spec.server, spec.name);
    let result: { success: boolean; text: string; content?: unknown[]; structuredContent?: Record<string, unknown> };
    try {
      if (spec.requiresApproval) {
        let preApproved = false;
        try { preApproved = this.deps.isPreApproved?.(spec.server, spec.name, input) === true; } catch { preApproved = false; }
        let detail = '';
        if (!preApproved) {
          const card = describeCallForApproval(spec.name, input);
          if (card.unseenBytes > 0) {
            this.deps.log?.(`REFUSED ${spec.server}/${spec.name}: ${card.unseenBytes} bytes of input would not be shown on the approval card`);
            this.finish(callId, refusal(`The host tool "${spec.name}" was not run: its input is too long to show the user in full for approval (${card.unseenBytes} more bytes than the card can display). Call it again with a shorter input.`));
            return;
          }
          detail = card.detail;
        }
        const allowed = preApproved || await this.deps.requestPermission(name, detail).catch(() => false);
        if (!allowed) { this.finish(callId, refusal('The user denied this tool call.')); return; }
      }
      if (abort.signal.aborted) { this.finish(callId, refusal(`The host tool "${spec.name}" was canceled before it finished.`)); return; }
      const out = await this.deps.invoke(spec.server, spec.name, input, abort.signal);
      const clamped = clampResultText(out.text);
      // Same filter the daemon applies: images only, bounded in count and total size, so one large screenshot
      // cannot push the frame past the transport limit and loop on re-send.
      const sanitized = sanitizeResultContent(out.content);
      // Structured content is the one unbounded part of the frame: it must fit the budget or the daemon would drop
      // the connection on an oversized frame. Over budget it is left out and the text says so.
      const fitted = fitStructuredContent(asStructuredContent(out.structuredContent), clamped.text);
      result = { success: out.success, text: fitted.text, ...(sanitized.length ? { content: sanitized } : {}), ...(fitted.structuredContent ? { structuredContent: fitted.structuredContent } : {}) };
    } catch (err) {
      this.deps.log?.(`host tool ${spec.server}/${spec.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      result = refusal(`The host tool "${spec.name}" failed.`);
    }
    this.finish(callId, result);
  }

  private finish(callId: string, result: { success: boolean; text: string; content?: unknown[]; structuredContent?: Record<string, unknown> }): void {
    this.calls.set(callId, { state: 'done', result });
    // Forget only finished calls: dropping a running entry would let a reopened call run a second time.
    if (this.calls.size > REMEMBERED_CALLS) {
      for (const [id, c] of this.calls) {
        if (this.calls.size <= REMEMBERED_CALLS) break;
        if (c.state === 'done') this.calls.delete(id);
      }
    }
    void this.send(callId, result);
  }

  /** Answer a call that was refused before it ran (remembered, so a reopen gets the same answer). */
  private answer(callId: string, result: { success: boolean; text: string }): void { this.finish(callId, result); }

  private async send(callId: string, result: { success: boolean; text: string; content?: unknown[]; structuredContent?: Record<string, unknown> }): Promise<void> {
    try { await this.deps.sendResult(callId, result); } catch (err) { this.deps.log?.(`could not send tool.result for ${callId}: ${err instanceof Error ? err.message : String(err)}`); }
  }
}

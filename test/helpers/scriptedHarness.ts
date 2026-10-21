/**
 * A `HarnessSession` the test drives by hand, standing in for `ThreadSession`
 * behind the REAL `ClaudeSessionDriver`. It reproduces the contract that
 * matters to the driver: callbacks come from `start()` options, `onDone` fires
 * before `turnInFlight` clears, and blocking callbacks (permission, question,
 * elicitation) return promises the harness awaits.
 */
import { randomUUID } from 'node:crypto';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { HarnessContextUsage, HarnessSession, HarnessSessionOptions } from '../../src/HarnessSession';
import type { ImageAttachment } from '../../src/types';

export class ScriptedHarness implements HarnessSession {
  options: HarnessSessionOptions | undefined;
  sessionId: string;
  sent: Array<{ text: string; images?: ImageAttachment[]; uuid?: string }> = [];
  models: Array<string | undefined> = [];
  modes: string[] = [];
  interrupts = 0;
  closed = false;
  startError: Error | undefined;
  private turn = false;
  private pendingCallbacks = 0;

  constructor(sessionId = `native-${randomUUID().slice(0, 8)}`) {
    this.sessionId = sessionId;
  }

  get cb(): SessionCallbacks {
    if (!this.options) throw new Error('harness not started');
    return this.options.callbacks;
  }

  get turnInFlight(): boolean { return this.turn; }
  get cwd(): string | undefined { return this.options?.cwd; }
  get hasPendingPermission(): boolean { return this.pendingCallbacks > 0; }
  canIdleReap(): boolean { return !this.turn && this.pendingCallbacks === 0; }

  async start(options: HarnessSessionOptions): Promise<void> {
    if (this.startError) throw this.startError;
    this.options = options;
    // Like the SDK, every raw event carries the session id (the init message first).
    options.callbacks.onRawEvent?.({ type: 'system', subtype: 'init', session_id: options.resume ?? this.sessionId });
  }

  send(text: string, images?: ImageAttachment[], uuid?: string): void {
    this.sent.push({ text, images, uuid });
    this.turn = true;
  }

  async interrupt(): Promise<void> {
    this.interrupts++;
    if (!this.turn) return;
    this.cb.onInterrupted(this.sessionId);
    this.turn = false;
  }

  close(): void { this.closed = true; this.turn = false; }
  async setModel(model: string | undefined): Promise<void> { this.models.push(model); }
  async setPermissionMode(mode: string): Promise<void> { this.modes.push(mode); }
  async getContextUsage(): Promise<HarnessContextUsage | null> {
    return { categories: [], totalTokens: 10, maxTokens: 200, percentage: 5, model: 'haiku' };
  }
  /** What `mcpServerStatus()` reports; a test flips an entry to simulate a server dying mid-session. */
  mcpStatus: Array<{ name: string; status: string }> = [{ name: 'm', status: 'connected' }];
  async mcpServerStatus(): Promise<Array<{ name: string; status: string }>> { return this.mcpStatus.map((s) => ({ ...s })); }
  async getUsageSnapshot(): Promise<null> { return null; }
  prepared: string[] = [];
  async prepareForSend(text: string): Promise<void> { this.prepared.push(text); }
  agentMessages: Array<[string, string]> = [];
  async sendAgentMessage(id: string, text: string): Promise<void> { this.agentMessages.push([id, text]); }

  // ── script ───────────────────────────────────────────────────────────────

  token(text: string): void { this.cb.onToken(text); }

  finish(content: string): void {
    this.cb.onMessage(content, []);
    this.cb.onDone(this.sessionId, 0, 1);
    this.turn = false; // ThreadSession clears this right AFTER onDone
  }

  async permission(toolName: string, detail: string): Promise<boolean> {
    this.pendingCallbacks++;
    try { return await this.cb.onPermissionRequest(toolName, detail); } finally { this.pendingCallbacks--; }
  }
}

export function scriptedFactory(made: ScriptedHarness[], sessionId?: string): () => ScriptedHarness {
  return () => {
    const h = new ScriptedHarness(sessionId);
    made.push(h);
    return h;
  };
}

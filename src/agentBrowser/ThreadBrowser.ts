/**
 * One thread's view of the agent browser.
 *
 * Sits between the MCP tools and the pool: the tools describe *what* an agent
 * can ask for, the pool decides *whether* a guest may exist, and this class owns
 * the bookkeeping that makes a sequence of stateless tool calls behave like a
 * coherent session — which ref table belongs to which page, and which snapshot a
 * given ref came from.
 *
 * That bookkeeping is the reason it exists rather than the tools calling the
 * pool directly. Element refs only mean anything relative to the snapshot that
 * produced them, and a guest that is replaced after a crash must not inherit the
 * previous guest's refs.
 */

import type { AgentBrowserPool } from './AgentBrowserPool';
import type { AgentBrowserGuest } from './AgentBrowserGuest';
import { AgentBrowserError, REFS_INVALIDATED_HINT } from './agentBrowserErrors';
import {
  buildActScript,
  buildReadTextScript,
  buildSnapshotScript,
  makeRefTableKey,
  type ActKind,
  type RawActResult,
  type RawPageText,
  type RawSnapshot,
} from './agentBrowserScript';
import { frameUntrusted, matchesKnownSecret, stripInvisible } from './agentBrowserSanitize';
import { MAX_SNAPSHOT_CHARS } from './agentBrowserPolicy';

export interface SnapshotResult {
  url: string;
  title: string;
  origin: string;
  /** Present this with any act call. Refs are only valid for their own epoch. */
  epoch: number;
  count: number;
  truncated: boolean;
  snapshot: string;
}

export interface ActResult {
  url: string;
  title: string;
}

export interface ThreadBrowserOptions {
  threadId: string;
  pool: AgentBrowserPool;
  /** Known secret values, used to refuse typing credentials into a page. */
  getSecrets?: () => readonly string[];
  /** Injected so framed output is deterministic in tests. */
  nowIso?: () => string;
}

export class ThreadBrowser {
  readonly threadId: string;
  private readonly pool: AgentBrowserPool;
  private readonly getSecrets: () => readonly string[];
  private readonly nowIso: () => string;

  /** The guest these refs belong to. A new guest invalidates everything. */
  private boundGuest: AgentBrowserGuest | null = null;
  private refTableKey = makeRefTableKey();
  private lastEpoch = 0;

  constructor(options: ThreadBrowserOptions) {
    this.threadId = options.threadId;
    this.pool = options.pool;
    this.getSecrets = options.getSecrets ?? (() => []);
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  /**
   * Get this thread's guest, resetting ref state if the pool handed back a new
   * one (after a crash, a reap, or a budget recycle).
   */
  private async guest(): Promise<AgentBrowserGuest> {
    const guest = await this.pool.acquire(this.threadId);
    if (guest !== this.boundGuest) {
      this.boundGuest = guest;
      this.refTableKey = makeRefTableKey();
      this.lastEpoch = 0;
    }
    return guest;
  }

  async navigate(url: string): Promise<SnapshotResult> {
    const guest = await this.guest();
    await guest.navigate(url);
    return this.snapshotWith(guest);
  }

  /**
   * Resize the viewport and return a fresh snapshot.
   *
   * A resize can reflow a responsive page and change every ref, so — exactly
   * like `navigate()` — this re-snapshots rather than returning just the new
   * dimensions, bumping the epoch so stale pre-resize refs are implicitly
   * invalidated the same way they are after a navigation.
   */
  async resize(width: number, height: number): Promise<SnapshotResult> {
    const guest = await this.guest();
    await guest.resize(width, height);
    return this.snapshotWith(guest);
  }

  async snapshot(): Promise<SnapshotResult> {
    return this.snapshotWith(await this.guest());
  }

  private async snapshotWith(guest: AgentBrowserGuest): Promise<SnapshotResult> {
    const raw = (await guest.runScript(buildSnapshotScript(this.refTableKey))) as RawSnapshot | null;
    if (!raw || typeof raw !== 'object') {
      throw new AgentBrowserError({
        code: 'script_timeout',
        message: 'The page did not return a usable snapshot.',
        retryable: true,
      });
    }
    this.lastEpoch = raw.epoch;
    // The snapshot is structured data the agent acts on rather than prose to
    // reason about, so it is cleaned but not wrapped in the untrusted-content
    // frame — element names are already capped and stripped in the guest.
    const cleaned = stripInvisible(raw.snapshot).slice(0, MAX_SNAPSHOT_CHARS);
    return {
      url: raw.url,
      title: stripInvisible(raw.title),
      origin: raw.origin,
      epoch: raw.epoch,
      count: raw.count,
      truncated: raw.truncated,
      snapshot: cleaned,
    };
  }

  /** Page prose, framed as untrusted retrieved data. */
  async readText(): Promise<{ url: string; title: string; content: string }> {
    const guest = await this.guest();
    const raw = (await guest.runScript(buildReadTextScript())) as RawPageText | null;
    if (!raw || typeof raw !== 'object') {
      throw new AgentBrowserError({
        code: 'script_timeout',
        message: 'The page did not return readable text.',
        retryable: true,
      });
    }
    return {
      url: raw.url,
      title: stripInvisible(raw.title),
      content: frameUntrusted(raw.text, {
        origin: raw.origin,
        url: raw.url,
        retrievedAt: this.nowIso(),
        truncated: raw.truncated,
      }),
    };
  }

  async click(ref: string, epoch: number): Promise<ActResult> {
    return this.act({ kind: 'click', ref, epoch });
  }

  async type(ref: string, epoch: number, text: string, submit = false): Promise<ActResult> {
    // Refuse to type a stored credential. An injected "sign in with your API
    // key" has to fail closed, not merely be discouraged.
    if (matchesKnownSecret(text, this.getSecrets())) {
      throw new AgentBrowserError({
        code: 'not_actionable',
        message: 'Refusing to type a stored secret into a web page.',
        retryable: false,
        hint: 'If this is genuinely required, enter the value manually in the browser.',
      });
    }
    return this.act({ kind: 'type', ref, epoch, text, submit });
  }

  private async act(request: { kind: ActKind; ref: string; epoch: number; text?: string; submit?: boolean }): Promise<ActResult> {
    const guest = await this.guest();
    if (this.lastEpoch === 0) {
      throw new AgentBrowserError({
        code: 'stale_snapshot',
        message: 'No snapshot has been taken for this page yet.',
        retryable: true,
        hint: 'Call browser_snapshot first and act on the refs it returns.',
      });
    }
    const raw = (await guest.runScript(buildActScript(this.refTableKey, request))) as RawActResult | null;
    if (!raw || typeof raw !== 'object') {
      throw new AgentBrowserError({
        code: 'script_timeout',
        message: 'The page did not confirm the action.',
        retryable: true,
      });
    }
    if (!raw.ok) {
      throw new AgentBrowserError({
        code: raw.code,
        message: raw.reason,
        retryable: true,
        hint:
          raw.code === 'stale_snapshot'
            ? REFS_INVALIDATED_HINT
            : 'Take a fresh snapshot; the page has changed since these refs were produced.',
      });
    }
    return { url: raw.url, title: stripInvisible(raw.title) };
  }

  /** PNG bytes of the guest viewport. */
  async screenshot(maxWidth?: number): Promise<Uint8Array> {
    const guest = await this.guest();
    return guest.capture(maxWidth);
  }

  /** Close this thread's guest. Safe when none exists. */
  close(): void {
    this.pool.destroyForThread(this.threadId, 'tool');
    this.boundGuest = null;
    this.lastEpoch = 0;
  }

  /** Pool-wide footprint, so the agent can see and correct its own usage. */
  status(): ReturnType<AgentBrowserPool['status']> & { threadHasSession: boolean } {
    return {
      ...this.pool.status(),
      threadHasSession: this.pool.peek(this.threadId) !== null,
    };
  }
}

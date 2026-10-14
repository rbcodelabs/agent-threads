/**
 * Owns every thread's journal and (when open) its session driver.
 *
 * Journals outlive sessions: after a daemon restart the history is still
 * attachable from disk, and the client re-opens the session (idempotent by
 * threadId) when it wants to talk to it again.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyWireEvent,
  wireJournalPolicy,
  type RemoteSessionSpec,
  type WireEvent,
} from '../src/protocol';
import { DiskJournal, type DiskJournalOptions } from './diskJournal';
import { ensureDir, isSafeThreadId } from './fsutil';
import type { DriverFactory, RequestKind, SessionDriver } from './sessionDriver';

export type ThreadJournal = DiskJournal<WireEvent>;

export class HostError extends Error {
  constructor(readonly code: 'not_found' | 'conflict' | 'bad_frame', message: string) {
    super(message);
    this.name = 'HostError';
  }
}

export interface ThreadHostOptions {
  dataDir: string;
  epoch: string;
  driverFactory: DriverFactory;
  flushMs?: number;
  journalOptions?: Omit<DiskJournalOptions<WireEvent>, 'epoch' | 'flushMs' | 'isBoundary' | 'isTurnInFlight'>;
  now?: () => number;
}

interface Runtime {
  journal: ThreadJournal;
  driver: SessionDriver | null;
  spec: RemoteSessionSpec | null;
}

/**
 * Design 3.4 lists done/error/permission_request/idle-state. We also fsync the
 * turn START (state with turnInFlight=true) so that once `session.send` has
 * been acked the turn is known to the journal after a crash, which is what lets
 * recovery close it out as daemon_restarted.
 */
const isBoundary = (e: WireEvent): boolean => {
  const role = classifyWireEvent(e).role;
  return role === 'turn_end' || role === 'request_open' || role === 'request_close'
    || e.name === 'session.state';
};

export class ThreadHost {
  private readonly threads = new Map<string, Runtime>();
  private readonly journalDir: string;
  private readonly now: () => number;
  private compactTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly opts: ThreadHostOptions) {
    this.journalDir = join(opts.dataDir, 'journal');
    this.now = opts.now ?? (() => Date.now());
    ensureDir(this.journalDir);
  }

  // ── startup ──────────────────────────────────────────────────────────────

  /**
   * Load every journal and close out turns the previous process left running:
   * a synthetic `error{daemon_restarted}` + `interrupted` + idle state, and
   * `expired` for blocking requests nobody can answer any more.
   * @returns thread ids that needed closing out.
   */
  recover(): string[] {
    const interrupted: string[] = [];
    for (const id of DiskJournal.listIds(this.journalDir, readdirSync)) {
      if (!isSafeThreadId(id)) continue;
      const rt = this.runtime(id);
      const cp = rt.journal.checkpoint();
      const state = cp.state?.event.name === 'session.state' ? cp.state.event.args : null;
      const inFlight = state?.turnInFlight === true || cp.inFlightText !== '';
      if (!inFlight && cp.openRequests.length === 0) continue;
      for (const req of cp.openRequests) {
        const requestId = (req.event.args as { requestId?: string; callId?: string }).requestId
          ?? (req.event.args as { callId?: string }).callId;
        if (requestId) rt.journal.append({ name: 'request_resolved', args: { requestId, outcome: 'expired' } }, this.now());
      }
      if (inFlight) {
        rt.journal.append({ name: 'onError', args: [{ name: 'daemon_restarted', message: 'The daemon restarted while this turn was running' }] }, this.now());
        rt.journal.append({ name: 'onInterrupted', args: [`restart-${id}`] }, this.now());
        rt.journal.append({
          name: 'session.state',
          args: { turnInFlight: false, hasPendingPermission: false, hostAttached: false, ...(state?.cwd ? { cwd: state.cwd } : {}) },
        }, this.now());
        interrupted.push(id);
      }
      rt.journal.flush(true);
    }
    return interrupted;
  }

  // ── lookup ───────────────────────────────────────────────────────────────

  has(threadId: string): boolean {
    return this.threads.has(threadId);
  }

  journalFor(threadId: string): ThreadJournal | null {
    return this.threads.get(threadId)?.journal ?? null;
  }

  list(): Array<{ threadId: string; lastSeq: number; open: boolean; turnInFlight: boolean }> {
    return [...this.threads.entries()].map(([threadId, rt]) => ({
      threadId,
      lastSeq: rt.journal.lastSeq,
      open: rt.driver !== null,
      turnInFlight: rt.driver?.turnInFlight ?? false,
    }));
  }

  // ── commands ─────────────────────────────────────────────────────────────

  /** Open-or-adopt: idempotent by threadId. */
  open(threadId: string, spec: RemoteSessionSpec): { created: boolean; lastSeq: number } {
    if (!isSafeThreadId(threadId)) throw new HostError('bad_frame', `invalid threadId "${threadId}"`);
    const rt = this.runtime(threadId);
    if (rt.driver) return { created: false, lastSeq: rt.journal.lastSeq };
    rt.spec = spec;
    rt.driver = this.opts.driverFactory({ threadId, spec, emit: (e) => { rt.journal.append(e, this.now()); } });
    rt.journal.append({
      name: 'session.state',
      args: { turnInFlight: false, hasPendingPermission: false, hostAttached: false, cwd: spec.cwd },
    }, this.now());
    return { created: true, lastSeq: rt.journal.lastSeq };
  }

  send(threadId: string, text: string, userMessageUuid: string): void {
    const driver = this.driverFor(threadId);
    if (driver.turnInFlight) throw new HostError('conflict', 'a turn is already in flight');
    driver.send(text, userMessageUuid);
  }

  interrupt(threadId: string): void {
    this.driverFor(threadId).interrupt();
  }

  resolve(threadId: string, kind: RequestKind, requestId: string, payload: Record<string, unknown>, by: string): void {
    const rt = this.threads.get(threadId);
    if (!rt?.driver) throw new HostError('not_found', `session ${threadId} is not open`);
    if (!rt.driver.resolve(kind, requestId, payload)) {
      throw new HostError('not_found', `no pending ${kind} request ${requestId}`);
    }
    rt.journal.append({ name: 'request_resolved', args: { requestId, by, outcome: 'resolved' } }, this.now());
  }

  /** Detach/close: stop the driver; the journal (history) stays attachable. */
  closeSession(threadId: string): void {
    const rt = this.threads.get(threadId);
    if (!rt) throw new HostError('not_found', `unknown thread ${threadId}`);
    if (rt.driver) {
      rt.driver.close();
      rt.driver = null;
    }
  }

  /** Retention: the owner acknowledged everything up to `seq`. */
  ack(threadId: string, seq: number): void {
    const rt = this.threads.get(threadId);
    if (!rt) throw new HostError('not_found', `unknown thread ${threadId}`);
    rt.journal.ack(seq);
    if (this.compactTimers.has(threadId)) return;
    // Coalesce: clients ack per event, compaction is O(n) and may rewrite the file.
    const t = setTimeout(() => {
      this.compactTimers.delete(threadId);
      try { rt.journal.compact(); } catch (err) { console.error(`compact ${threadId}:`, err); }
    }, 250);
    t.unref?.();
    this.compactTimers.set(threadId, t);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Graceful stop: close drivers, flush + fsync every journal. */
  shutdown(): void {
    for (const t of this.compactTimers.values()) clearTimeout(t);
    this.compactTimers.clear();
    for (const rt of this.threads.values()) {
      rt.driver?.close();
      rt.driver = null;
      rt.journal.close();
    }
  }

  /** Test hook: behave like SIGKILL (unflushed data is lost, nothing is finalized). */
  crash(): void {
    for (const t of this.compactTimers.values()) clearTimeout(t);
    this.compactTimers.clear();
    for (const rt of this.threads.values()) {
      rt.driver?.close();
      rt.journal.abandon();
    }
    this.threads.clear();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private driverFor(threadId: string): SessionDriver {
    const driver = this.threads.get(threadId)?.driver;
    if (!driver) throw new HostError('not_found', `session ${threadId} is not open; send session.open first`);
    return driver;
  }

  private runtime(threadId: string): Runtime {
    let rt = this.threads.get(threadId);
    if (!rt) {
      const journal = DiskJournal.open<WireEvent>(this.journalDir, threadId, wireJournalPolicy, {
        ...this.opts.journalOptions,
        epoch: this.opts.epoch,
        flushMs: this.opts.flushMs,
        isBoundary,
        isTurnInFlight: (cp) => cp.state?.event.name === 'session.state' && cp.state.event.args.turnInFlight === true,
      });
      rt = { journal, driver: null, spec: null };
      this.threads.set(threadId, rt);
    }
    return rt;
  }
}

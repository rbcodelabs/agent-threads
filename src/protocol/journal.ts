/**
 * journal.ts
 *
 * The resumable event stream (design section 3.4), as a pure interface plus an
 * in-memory implementation. A disk-backed implementation (NDJSON + sidecar
 * index) lands in a later PR behind the same `Journal` interface.
 *
 * Semantics:
 * - One journal per channel. `seq` is assigned at append time, is strictly
 *   increasing, starts at 1 and is NEVER reused, even after entries are removed.
 * - `replay(afterSeq)` returns every retained entry with `seq > afterSeq`, in
 *   order, or a `resync` carrying a checkpoint when the cursor is older than
 *   `lowWater` (entries the journal evicted wholesale and can no longer serve).
 * - `lowWater` is the highest seq removed by size/age EVICTION (oldest first).
 *   Token compaction does NOT raise it: tokens of a finished, acked turn are
 *   redundant with the `message` that followed them, so a client that was away
 *   across that turn boundary simply receives the message, not the tokens.
 * - `compact()` drops only `token` events that precede a turn-finishing event
 *   (`message` / `turn_end`) which itself is at or below the acked seq.
 *   Everything else (messages, requests, state, unfinished turns) is kept.
 * - The journal is generic over the event type; a `JournalPolicy` tells it how
 *   to classify an event, which keeps this file free of any session vocabulary.
 */

export interface JournalEntry<E> {
  seq: number;
  ts: number;
  event: E;
}

/** What an event means to the journal. */
export type EventRole =
  | { role: 'token'; text: string }
  /** Finalizes assistant output; the preceding tokens become redundant. */
  | { role: 'message' }
  /** done / interrupted / error: the turn is over. */
  | { role: 'turn_end' }
  /** Opens a blocking request that must survive disconnects until closed. */
  | { role: 'request_open'; requestId: string }
  | { role: 'request_close'; requestId: string }
  /** Latest value wins (session.state). */
  | { role: 'state' }
  | { role: 'other' };

export interface JournalPolicy<E> {
  classify(event: E): EventRole;
}

/**
 * Folded state a client needs to rebuild after a gap. The client treats a
 * resync as "discard the in-flight streaming buffer, keep the finalized
 * transcript", then continues live from `seq`.
 */
export interface Checkpoint<E> {
  /** Last seq folded into this checkpoint; live delivery continues after it. */
  seq: number;
  ts: number;
  /** Assistant text streamed since the last finished turn. */
  inFlightText: string;
  /** Requests opened and not yet closed, oldest first. */
  openRequests: Array<JournalEntry<E>>;
  /** Latest `state` event, if any. */
  state: JournalEntry<E> | null;
  /** The last K `message` events, oldest first. */
  recentMessages: Array<JournalEntry<E>>;
}

export type ReplayResult<E> =
  | { kind: 'entries'; entries: Array<JournalEntry<E>>; lastSeq: number }
  | { kind: 'resync'; checkpoint: Checkpoint<E>; lastSeq: number };

export interface CompactionResult {
  /** Token events removed by this call. */
  removed: number;
}

export interface Journal<E> {
  /** Highest seq ever assigned (0 when empty). */
  readonly lastSeq: number;
  /** Highest seq removed by eviction; cursors below it need a resync. */
  readonly lowWater: number;
  /** Highest seq the retention owner has acknowledged. */
  readonly ackedSeq: number;
  /** Number of retained entries. */
  readonly size: number;
  append(event: E, ts?: number): JournalEntry<E>;
  replay(afterSeq: number): ReplayResult<E>;
  /** Monotonic: a lower seq than already acked is ignored. Clamped to lastSeq. */
  ack(seq: number): void;
  compact(): CompactionResult;
  checkpoint(): Checkpoint<E>;
}

export interface InMemoryJournalOptions {
  /** Hard cap on retained entries. Oldest are evicted (raising lowWater). */
  maxEntries?: number;
  /** Hard cap on retained approximate bytes (JSON length). Oldest evicted. */
  maxBytes?: number;
  /** Entries older than this are evicted by compact(). */
  maxAgeMs?: number;
  /** How many recent `message` events a checkpoint carries. Default 20. */
  checkpointMessages?: number;
  now?: () => number;
}

export const DEFAULT_CHECKPOINT_MESSAGES = 20;

interface Stored<E> extends JournalEntry<E> {
  bytes: number;
  role: EventRole;
}

export class InMemoryJournal<E> implements Journal<E> {
  private entries: Array<Stored<E>> = [];
  private bytes = 0;
  private _lastSeq: number;
  private _lowWater = 0;
  private _ackedSeq = 0;
  // Folded incrementally at append time so a checkpoint is O(1) and survives
  // eviction of the entries it was folded from (an open request must outlive
  // its own journal record).
  private inFlight = '';
  private open = new Map<string, JournalEntry<E>>();
  private latestState: JournalEntry<E> | null = null;
  private recent: Array<JournalEntry<E>> = [];
  private readonly now: () => number;

  /**
   * @param startSeq resume numbering after this seq (a disk journal reopening
   *   with lastSeq N passes N so seq is never reused).
   */
  constructor(
    private readonly policy: JournalPolicy<E>,
    private readonly options: InMemoryJournalOptions = {},
    startSeq = 0,
  ) {
    this._lastSeq = startSeq;
    this._lowWater = startSeq;
    this._ackedSeq = 0;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Rebuild state from entries read back from durable storage. Only valid on
   * a fresh journal. Entries at or below `lowWater` are dropped (they were
   * evicted but may still be on disk), and the checkpoint fold is replayed
   * from the retained entries. `seq` numbering continues after `lastSeq`.
   */
  restore(
    entries: ReadonlyArray<JournalEntry<E>>,
    state: { lastSeq: number; lowWater: number; ackedSeq?: number },
  ): void {
    if (this.entries.length > 0 || this._lastSeq > 0) {
      throw new Error('InMemoryJournal.restore requires an empty journal');
    }
    const retained = entries.filter((e) => e.seq > state.lowWater);
    for (const e of retained) {
      const role = this.policy.classify(e.event);
      const bytes = approxBytes(e.event);
      this.entries.push({ seq: e.seq, ts: e.ts, event: e.event, bytes, role });
      this.bytes += bytes;
      this.fold({ seq: e.seq, ts: e.ts, event: e.event }, role);
    }
    const tail = retained.length ? retained[retained.length - 1].seq : 0;
    this._lastSeq = Math.max(state.lastSeq, tail, state.lowWater);
    this._lowWater = state.lowWater;
    this._ackedSeq = Math.min(Math.max(state.ackedSeq ?? 0, 0), this._lastSeq);
  }

  get lastSeq(): number { return this._lastSeq; }
  get lowWater(): number { return this._lowWater; }
  get ackedSeq(): number { return this._ackedSeq; }
  get size(): number { return this.entries.length; }

  append(event: E, ts: number = this.now()): JournalEntry<E> {
    const seq = ++this._lastSeq;
    const bytes = approxBytes(event);
    const role = this.policy.classify(event);
    this.entries.push({ seq, ts, event, bytes, role });
    this.bytes += bytes;
    this.fold({ seq, ts, event }, role);
    this.enforceBounds();
    return { seq, ts, event };
  }

  replay(afterSeq: number): ReplayResult<E> {
    if (afterSeq < this._lowWater) {
      return { kind: 'resync', checkpoint: this.checkpoint(), lastSeq: this._lastSeq };
    }
    const entries = this.entries
      .filter((e) => e.seq > afterSeq)
      .map(({ seq, ts, event }) => ({ seq, ts, event }));
    return { kind: 'entries', entries, lastSeq: this._lastSeq };
  }

  ack(seq: number): void {
    if (!Number.isFinite(seq)) return;
    this._ackedSeq = Math.max(this._ackedSeq, Math.min(Math.floor(seq), this._lastSeq));
  }

  compact(): CompactionResult {
    this.evictExpired();
    const before = this.entries.length;
    this.dropFinishedAckedTokens();
    this.enforceBounds(false);
    return { removed: before - this.entries.length };
  }

  checkpoint(): Checkpoint<E> {
    return {
      seq: this._lastSeq,
      ts: this.now(),
      inFlightText: this.inFlight,
      openRequests: [...this.open.values()],
      state: this.latestState,
      recentMessages: [...this.recent],
    };
  }

  private fold(entry: JournalEntry<E>, role: EventRole): void {
    switch (role.role) {
      case 'token': this.inFlight += role.text; break;
      case 'message': {
        this.inFlight = '';
        this.recent.push(entry);
        const keep = this.options.checkpointMessages ?? DEFAULT_CHECKPOINT_MESSAGES;
        if (this.recent.length > keep) this.recent.splice(0, this.recent.length - Math.max(keep, 0));
        break;
      }
      case 'turn_end': this.inFlight = ''; break;
      case 'request_open': this.open.set(role.requestId, entry); break;
      case 'request_close': this.open.delete(role.requestId); break;
      case 'state': this.latestState = entry; break;
      default: break;
    }
  }

  private dropFinishedAckedTokens(): void {
    // The newest finisher at or below the ack floor bounds what is droppable:
    // a token is redundant once a later finisher is acked.
    let floor = 0;
    for (const e of this.entries) {
      if (e.seq > this._ackedSeq) break;
      if (e.role.role === 'message' || e.role.role === 'turn_end') floor = e.seq;
    }
    if (floor === 0) return;
    this.entries = this.entries.filter((e) => {
      const drop = e.role.role === 'token' && e.seq < floor;
      if (drop) this.bytes -= e.bytes;
      return !drop;
    });
  }

  private evictExpired(): void {
    const { maxAgeMs } = this.options;
    if (maxAgeMs === undefined) return;
    const cutoff = this.now() - maxAgeMs;
    // Eviction is always a prefix so that lowWater stays meaningful.
    let n = 0;
    while (n < this.entries.length && this.entries[n].ts < cutoff) n++;
    this.evictPrefix(n);
  }

  /** @param compactFirst try cheap token compaction before dropping history. */
  private enforceBounds(compactFirst = true): void {
    const { maxEntries, maxBytes } = this.options;
    const over = () =>
      (maxEntries !== undefined && this.entries.length > maxEntries)
      || (maxBytes !== undefined && this.bytes > maxBytes && this.entries.length > 1);
    if (!over()) return;
    if (compactFirst) this.dropFinishedAckedTokens();
    let n = 0;
    let count = this.entries.length;
    let bytes = this.bytes;
    while (n < this.entries.length) {
      const tooMany = maxEntries !== undefined && count > maxEntries;
      const tooBig = maxBytes !== undefined && bytes > maxBytes && count > 1;
      if (!tooMany && !tooBig) break;
      bytes -= this.entries[n].bytes;
      count--;
      n++;
    }
    this.evictPrefix(n);
  }

  private evictPrefix(n: number): void {
    if (n <= 0) return;
    const removed = this.entries.splice(0, n);
    for (const r of removed) this.bytes -= r.bytes;
    this._lowWater = Math.max(this._lowWater, removed[removed.length - 1].seq);
  }
}

function approxBytes(event: unknown): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 0;
  }
}

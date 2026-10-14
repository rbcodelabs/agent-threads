/**
 * Disk-backed `Journal` (design sections 3.4 and 5.1).
 *
 *   <dir>/<id>.ndjson   one `{seq,ts,event}` JSON object per line, append-only
 *   <dir>/<id>.idx      sidecar `{lowWater,lastSeq,ackedSeq,epoch,openRequests,...}`
 *
 * The ndjson file is authoritative for entries; the sidecar carries what cannot
 * be derived from it (lowWater, ackedSeq). Serving reads come from the wrapped
 * `InMemoryJournal`, so replay/compaction/checkpoint semantics are exactly the
 * ones PR 2 tested; this class adds durability and live subscription.
 *
 * Durability rules:
 * - appends are buffered and flushed every `flushMs` (default 50 ms);
 * - boundary events (done/error/permission_request/session.state idle) flush
 *   immediately and fsync, so a turn's outcome survives a crash;
 * - on open, a torn final line (crash mid-write) is discarded and the file is
 *   truncated to the last whole record.
 *
 * All file I/O is synchronous on purpose: ordering is trivially correct and the
 * volumes (one small line per event) make it cheaper than the bookkeeping that
 * async writes would need.
 */
import { closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  InMemoryJournal,
  type Checkpoint,
  type CompactionResult,
  type InMemoryJournalOptions,
  type Journal,
  type JournalEntry,
  type JournalPolicy,
  type ReplayResult,
} from '../src/protocol';
import { ensureDir, writeFileAtomic } from './fsutil';

export const DEFAULT_FLUSH_MS = 50;

export interface JournalIndex {
  lowWater: number;
  lastSeq: number;
  ackedSeq: number;
  epoch: string;
  openRequests: string[];
  /**
   * Process epochs that have written to this journal, oldest first, each with the seq the journal held
   * when that process opened it (what survived the previous one's exit). Lets `rewindFor` tell a client
   * that applied events a crashed process never flushed where history really resumed.
   */
  epochs?: Array<{ epoch: string; startSeq: number }>;
  /** Advisory: lets tooling see in-flight turns without parsing the log. */
  turnInFlight: boolean;
  updatedAt: number;
}

export interface DiskJournalOptions<E> extends InMemoryJournalOptions {
  epoch: string;
  flushMs?: number;
  /** Events that must be on stable storage before the daemon moves on. */
  isBoundary?: (event: E) => boolean;
  /** Reported in the sidecar. */
  isTurnInFlight?: (checkpoint: Checkpoint<E>) => boolean;
}

export type JournalListener<E> = (entry: JournalEntry<E>) => void;

export class DiskJournal<E> implements Journal<E> {
  private readonly inner: InMemoryJournal<E>;
  private readonly ndjsonPath: string;
  private readonly idxPath: string;
  private fd: number | null = null;
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private needsRewrite = false;
  /** Eviction watermark the on-disk log already reflects. */
  private fileLowWater = 0;
  private lastIdxLowWater = -1;
  private listeners = new Set<JournalListener<E>>();
  private closed = false;
  private epochChain: Array<{ epoch: string; startSeq: number }> = [];

  private constructor(
    dir: string,
    readonly id: string,
    private readonly policy: JournalPolicy<E>,
    private readonly opts: DiskJournalOptions<E>,
  ) {
    this.ndjsonPath = join(dir, `${id}.ndjson`);
    this.idxPath = join(dir, `${id}.idx`);
    this.inner = new InMemoryJournal<E>(policy, opts);
  }

  /** Open (creating if needed) and recover the journal for `id`. */
  static open<E>(dir: string, id: string, policy: JournalPolicy<E>, opts: DiskJournalOptions<E>): DiskJournal<E> {
    ensureDir(dir);
    const j = new DiskJournal<E>(dir, id, policy, opts);
    j.recover();
    return j;
  }

  /**
   * Where history really resumed after a daemon restart that the client did not see. `null` = nothing to
   * correct. A client that applied events past the restart's recovery point (they were never flushed, and
   * their seqs were reused by the events that followed) must rewind to it and replay from there.
   * An epoch this journal never recorded is left alone (a client from before epochs, or a reset data dir).
   */
  rewindFor(clientEpoch: string | undefined, afterSeq: number): number | null {
    if (!clientEpoch || clientEpoch === this.opts.epoch) return null;
    const i = this.epochChain.findIndex((e) => e.epoch === clientEpoch);
    if (i === -1 || i + 1 >= this.epochChain.length) return null;
    const resumedAt = this.epochChain[i + 1].startSeq;
    return afterSeq > resumedAt ? resumedAt : null;
  }

  /** Thread ids that have a journal in `dir`. */
  static listIds(dir: string, readdir: (d: string) => string[]): string[] {
    return readdir(dir).filter((f) => f.endsWith('.ndjson')).map((f) => f.slice(0, -'.ndjson'.length));
  }

  // ── Journal interface ────────────────────────────────────────────────────

  get lastSeq(): number { return this.inner.lastSeq; }
  get lowWater(): number { return this.inner.lowWater; }
  get ackedSeq(): number { return this.inner.ackedSeq; }
  get size(): number { return this.inner.size; }
  get path(): string { return this.ndjsonPath; }

  append(event: E, ts?: number): JournalEntry<E> {
    if (this.closed) throw new Error(`journal ${this.id} is closed`);
    const entry = this.inner.append(event, ts);
    this.buffer.push(`${JSON.stringify(entry)}\n`);
    // Append may have evicted from the front; the file must shed those lines too.
    if (this.inner.lowWater > this.fileLowWater) this.needsRewrite = true;
    if (this.opts.isBoundary?.(event) || this.needsRewrite) this.flush(true);
    else this.scheduleFlush();
    for (const l of [...this.listeners]) {
      try { l(entry); } catch { /* a bad subscriber must not break the journal */ }
    }
    return entry;
  }

  replay(afterSeq: number): ReplayResult<E> { return this.inner.replay(afterSeq); }

  ack(seq: number): void {
    const before = this.inner.ackedSeq;
    this.inner.ack(seq);
    if (this.inner.ackedSeq !== before) this.writeIdx();
  }

  compact(): CompactionResult {
    const result = this.inner.compact();
    if (result.removed > 0 || this.inner.lowWater > this.fileLowWater) {
      this.needsRewrite = true;
      this.flush(true);
    }
    return result;
  }

  checkpoint(): Checkpoint<E> { return this.inner.checkpoint(); }

  // ── live subscription ────────────────────────────────────────────────────

  /**
   * Called synchronously from `append`. Combined with a synchronous
   * `replay()` + `subscribe()` this gives replay-then-live with no gap and
   * no duplicate: nothing can be appended between the two calls.
   */
  subscribe(listener: JournalListener<E>): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ── durability ───────────────────────────────────────────────────────────

  /** Write buffered lines; `sync` additionally fsyncs and refreshes the sidecar. */
  flush(sync = false): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.closed) return;
    if (this.needsRewrite) {
      this.rewrite();
    } else if (this.buffer.length) {
      const fd = this.ensureFd();
      writeSync(fd, this.buffer.join(''));
      if (sync) fsyncSync(fd);
    }
    this.buffer = [];
    if (sync || this.inner.lowWater !== this.lastIdxLowWater) this.writeIdx();
  }

  /** Flush, fsync and release the file descriptor. */
  close(): void {
    if (this.closed) return;
    this.flush(true);
    this.closed = true;
    this.listeners.clear();
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; }
  }

  /** Test hook for crash simulation: drop unflushed data and release the fd. */
  abandon(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.buffer = [];
    this.closed = true;
    this.listeners.clear();
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; }
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try { this.flush(false); } catch (err) { console.error(`journal ${this.id}: flush failed:`, err); }
    }, this.opts.flushMs ?? DEFAULT_FLUSH_MS);
    this.timer.unref?.();
  }

  private ensureFd(): number {
    if (this.fd === null) this.fd = openSync(this.ndjsonPath, 'a', 0o600);
    return this.fd;
  }

  /** Replace the file with exactly the retained entries (after compaction/eviction). */
  private rewrite(): void {
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; }
    const retained = this.inner.replay(this.inner.lowWater);
    const entries = retained.kind === 'entries' ? retained.entries : [];
    const lines = entries.map((e) => `${JSON.stringify(e)}\n`).join('');
    const tmp = `${this.ndjsonPath}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try { writeSync(fd, lines); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.ndjsonPath);
    this.needsRewrite = false;
    this.fileLowWater = this.inner.lowWater;
  }

  private writeIdx(): void {
    const cp = this.inner.checkpoint();
    const idx: JournalIndex = {
      lowWater: this.inner.lowWater,
      lastSeq: this.inner.lastSeq,
      ackedSeq: this.inner.ackedSeq,
      epoch: this.opts.epoch,
      openRequests: cp.openRequests.map((r) => requestIdOf(this.policy, r.event)).filter((s): s is string => s !== null),
      epochs: this.epochChain,
      turnInFlight: this.opts.isTurnInFlight?.(cp) ?? false,
      updatedAt: Date.now(),
    };
    writeFileAtomic(this.idxPath, `${JSON.stringify(idx)}\n`);
    this.lastIdxLowWater = idx.lowWater;
  }

  // ── recovery ─────────────────────────────────────────────────────────────

  private recover(): void {
    const idx = this.readIdx();
    const { entries, validBytes } = this.readEntries();
    if (existsSync(this.ndjsonPath) && statSync(this.ndjsonPath).size !== validBytes) {
      // Torn tail from a crash mid-append: keep every whole record, drop the rest.
      const fd = openSync(this.ndjsonPath, 'r+');
      try { ftruncateSync(fd, validBytes); fsyncSync(fd); } finally { closeSync(fd); }
    }
    const tail = entries.length ? entries[entries.length - 1].seq : 0;
    const lowWater = idx?.lowWater ?? 0;
    this.inner.restore(entries, {
      lastSeq: Math.max(idx?.lastSeq ?? 0, tail),
      lowWater,
      ackedSeq: idx?.ackedSeq,
    });
    this.fileLowWater = lowWater;
    this.epochChain = recordEpoch(idx, this.opts.epoch, this.inner.lastSeq);
    // Persist the chain NOW: if this process dies before its first sync flush, the next one must still know it existed.
    if (idx?.epochs?.at(-1)?.epoch !== this.opts.epoch) this.writeIdx();
    // Entries at/below lowWater may still be on disk; shed them on next flush.
    if (entries.some((e) => e.seq <= lowWater)) { this.fileLowWater = 0; this.needsRewrite = true; }
  }

  private readIdx(): JournalIndex | null {
    if (!existsSync(this.idxPath)) return null;
    try {
      const v: unknown = JSON.parse(readFileSync(this.idxPath, 'utf8'));
      if (typeof v === 'object' && v !== null && typeof (v as JournalIndex).lowWater === 'number') return v as JournalIndex;
    } catch { /* fall through: a damaged sidecar is rebuilt from the log */ }
    return null;
  }

  private readEntries(): { entries: Array<JournalEntry<E>>; validBytes: number } {
    if (!existsSync(this.ndjsonPath)) return { entries: [], validBytes: 0 };
    const raw = readFileSync(this.ndjsonPath);
    const entries: Array<JournalEntry<E>> = [];
    let offset = 0;
    let prevSeq = 0;
    while (offset < raw.length) {
      const nl = raw.indexOf(0x0a, offset);
      if (nl === -1) break; // no terminating newline: torn
      const line = raw.subarray(offset, nl).toString('utf8');
      let parsed: JournalEntry<E> | null = null;
      try {
        const v = JSON.parse(line) as JournalEntry<E>;
        if (Number.isInteger(v.seq) && v.seq > prevSeq && typeof v.ts === 'number' && v.event !== undefined) parsed = v;
      } catch { /* torn or corrupt */ }
      if (!parsed) break;
      entries.push(parsed);
      prevSeq = parsed.seq;
      offset = nl + 1;
    }
    return { entries, validBytes: offset };
  }
}

function requestIdOf<E>(policy: JournalPolicy<E>, event: E): string | null {
  const role = policy.classify(event);
  return role.role === 'request_open' ? role.requestId : null;
}

const MAX_EPOCH_HISTORY = 16;

/** The previous chain with this process appended (once), starting at the seq it recovered. */
function recordEpoch(idx: JournalIndex | null, epoch: string, recoveredSeq: number): Array<{ epoch: string; startSeq: number }> {
  const chain = Array.isArray(idx?.epochs) ? idx!.epochs!.filter((e) => typeof e?.epoch === 'string' && Number.isInteger(e.startSeq)) : [];
  if (chain.length === 0 && idx && typeof idx.epoch === 'string') chain.push({ epoch: idx.epoch, startSeq: 0 }); // journal from before the chain existed
  if (chain.at(-1)?.epoch !== epoch) chain.push({ epoch, startSeq: recoveredSeq });
  return chain.slice(-MAX_EPOCH_HISTORY);
}

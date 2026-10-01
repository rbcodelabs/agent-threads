import { debugLog } from './logger';
import { redactDeep } from './secretRedaction';

/**
 * One line in a raw JSONL conversation log. Wraps the verbatim SDK event with a
 * uniform envelope so downstream agents can parse every line the same way:
 *
 *   { ts, threadId, sessionId, type, event }
 *
 * `type` mirrors the SDK message type (assistant, user, result, system,
 * rate_limit_event, tool_use_summary) or a synthetic marker kind
 * (session_start). `event` is the raw payload with secrets masked (see
 * secretRedaction.ts); everything else is verbatim.
 */
export interface RawLogEnvelope {
  /** ISO-8601 timestamp when the line was written. */
  ts: string;
  threadId: string;
  sessionId?: string;
  type: string;
  event: unknown;
}

export interface RawLogTraceMetadata {
  sourceId: string;
  revision: string;
  contentHash: string;
  byteLength: number;
  updatedAt: number;
}

export interface RawLogTraceChunk {
  metadata: RawLogTraceMetadata;
  entries: RawLogEnvelope[];
  nextByteOffset: number;
  nextEventIndex: number;
  eof: boolean;
  bytesRead: number;
  readCalls: number;
  startBoundaryHash: string;
  nextBoundaryHash: string;
}

/**
 * Append-only writer for per-thread raw JSONL conversation logs.
 *
 * Logs live at `<vaultRoot>/<vaultFolder>/logs/<thread_id>.jsonl`. Keying by the
 * stable thread UUID (not the title) means the log never orphans when a thread
 * is renamed and its markdown note moves.
 *
 * Writes are append-only and serialized per file via a promise chain so events
 * land in arrival order without blocking the Obsidian UI thread. Vault root and
 * folder are read lazily through getters because ThreadManager populates
 * `vaultRoot` after construction.
 */
export class RawLogWriter {
  /** Tail of the in-flight append chain, keyed by absolute file path. */
  private writeTails = new Map<string, Promise<void>>();
  /** Directories already created this session, to skip redundant mkdir calls. */
  private ensuredDirs = new Set<string>();
  /** Last observed file identity/size, used to fence cursors after truncation. */
  private traceFiles = new Map<string, { identity: string; size: number; epoch: number }>();

  constructor(
    private getVaultRoot: () => string,
    private getVaultFolder: () => string,
  ) {}

  /**
   * True for events worth persisting. Partial streaming token deltas
   * (`stream_event`) are skipped — they are reconstructed verbatim in the
   * final `assistant` message, so logging them would bloat the file ~10-50x
   * with no added signal.
   */
  static shouldLog(type: string | undefined): boolean {
    return type !== 'stream_event';
  }

  /** Vault-relative path for a thread's log (used for frontmatter linking). */
  vaultRelativePath(threadId: string): string {
    const folder = this.getVaultFolder() || 'Claude';
    return `${folder}/logs/${threadId}.jsonl`;
  }

  /** Absolute filesystem path, or null if the vault root isn't known yet. */
  private absolutePath(threadId: string): string | null {
    const root = this.getVaultRoot();
    if (!root) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    return path.join(root, this.getVaultFolder() || 'Claude', 'logs', `${threadId}.jsonl`);
  }

  /**
   * Append one event to a thread's log. No-op if the vault root is unknown.
   * Never throws — append failures are logged and swallowed so a disk hiccup
   * can't break an active session.
   */
  append(threadId: string, sessionId: string | undefined, type: string, event: unknown): void {
    const abs = this.absolutePath(threadId);
    if (!abs) return;

    const envelope: RawLogEnvelope = {
      ts: new Date().toISOString(),
      threadId,
      sessionId,
      type,
      // Mask credentials before they reach disk: the log lives in the vault,
      // which is synced and often shared.
      event: redactDeep(event),
    };
    let line: string;
    try {
      line = JSON.stringify(envelope) + '\n';
    } catch {
      // Defensive: a circular or non-serializable payload shouldn't lose the record.
      line = JSON.stringify({ ts: envelope.ts, threadId, sessionId, type, event: '[unserializable]' }) + '\n';
    }
    this.enqueue(abs, line);
  }

  /**
   * Read and parse a thread's log. Entries are filtered by `type` (if given)
   * and then tailed to the most recent `limit` (default 100, `0` = all).
   * Returns null when the vault root is unknown or no log file exists yet.
   * Malformed lines are skipped rather than throwing, so a single bad record
   * never makes the whole log unreadable.
   */
  async read(
    threadId: string,
    opts?: { limit?: number; type?: string },
  ): Promise<{ path: string; total: number; returned: number; entries: RawLogEnvelope[] } | null> {
    const abs = this.absolutePath(threadId);
    if (!abs) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    let content: string;
    try {
      content = await fs.promises.readFile(abs, 'utf8');
    } catch {
      return null; // no log file written yet
    }
    const parsed: RawLogEnvelope[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        parsed.push(JSON.parse(line) as RawLogEnvelope);
      } catch {
        // skip a malformed line rather than failing the whole read
      }
    }
    const filtered = opts?.type ? parsed.filter((e) => e.type === opts.type) : parsed;
    const limit = opts?.limit ?? 100;
    const entries = limit > 0 ? filtered.slice(-limit) : filtered;
    return { path: abs, total: filtered.length, returned: entries.length, entries };
  }

  /**
   * Return source metadata using stat only. `revision` is stable while a file is
   * appended, but changes when it is replaced or observed to shrink. The
   * content hash is a cheap version fingerprint, not a scan of the log bytes.
   */
  async getTraceMetadata(threadId: string): Promise<RawLogTraceMetadata | null> {
    const abs = this.absolutePath(threadId);
    if (!abs) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('crypto') as typeof import('crypto');
    let stat: import('fs').Stats;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    const handle = await fs.promises.open(abs, 'r');
    const prefix = Buffer.alloc(Math.min(4096, stat.size));
    try { await handle.read(prefix, 0, prefix.length, 0); } finally { await handle.close(); }
    const firstLineEnd = prefix.indexOf(0x0a);
    const immutablePrefix = prefix.subarray(0, firstLineEnd >= 0 ? firstLineEnd + 1 : prefix.length);
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${crypto.createHash('sha256').update(immutablePrefix).digest('hex')}`;
    const previous = this.traceFiles.get(abs);
    const epoch = previous && (previous.identity !== identity || stat.size < previous.size)
      ? previous.epoch + 1
      : previous?.epoch ?? 0;
    this.traceFiles.set(abs, { identity, size: stat.size, epoch });
    const revision = crypto.createHash('sha256').update(`${identity}:${epoch}`).digest('hex');
    const contentHash = crypto.createHash('sha256').update(`${revision}:${stat.size}:${stat.mtimeMs}`).digest('hex');
    return { sourceId: threadId, revision, contentHash, byteLength: stat.size, updatedAt: stat.mtimeMs };
  }

  /**
   * Stream a bounded number of JSONL entries from a known line boundary. At
   * Reads in 64 KiB blocks. A semantic line is capped at 1 MiB; longer lines
   * are skipped through their newline so a corrupt record cannot wedge paging.
   */
  async readTraceChunk(
    threadId: string,
    options: { byteOffset: number; eventIndex: number; limit: number },
  ): Promise<RawLogTraceChunk | null> {
    for (const [name, value] of Object.entries(options)) {
      const valid = name === 'limit'
        ? Number.isInteger(value) && value > 0
        : Number.isInteger(value) && value >= 0;
      if (!valid) throw new RangeError(`${name} must be a ${name === 'limit' ? 'positive' : 'non-negative'} integer.`);
    }
    const metadata = await this.getTraceMetadata(threadId);
    const abs = this.absolutePath(threadId);
    if (!metadata || !abs) return null;
    if (options.byteOffset > metadata.byteLength) throw new RangeError('byteOffset is beyond the end of the trace source.');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const handle = await fs.promises.open(abs, 'r');
    try {
    // A small byte-boundary fingerprint makes a cursor self-verifying across
    // process restarts without rereading the complete append-only source.
    const boundaryHash = async (offset: number): Promise<string> => {
      const length = Math.min(4096, offset); const bytes = Buffer.alloc(length);
      if (length) await handle.read(bytes, 0, length, offset - length);
      return crypto.createHash('sha256').update(bytes).digest('hex');
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('crypto') as typeof import('crypto');
    const startBoundaryHash = await boundaryHash(options.byteOffset);
    const blockSize = 64 * 1024; const maxLineBytes = 1024 * 1024;
    let bytesRead = 0; let readCalls = 0; let position = options.byteOffset; let pending = Buffer.alloc(0); let done = false;
    const completeLines: Buffer[] = [];
    while (!done && position < metadata.byteLength && completeLines.length < options.limit) {
        const buffer = Buffer.alloc(Math.min(blockSize, metadata.byteLength - position));
        const read = await handle.read(buffer, 0, buffer.length, position); readCalls += 1; if (!read.bytesRead) break;
        bytesRead += read.bytesRead; position += read.bytesRead; pending = Buffer.concat([pending, buffer.subarray(0, read.bytesRead)]);
        let newline: number;
        while ((newline = pending.indexOf(0x0a)) >= 0) {
          const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
          if (line.length <= maxLineBytes) completeLines.push(line);
          if (completeLines.length >= options.limit) { done = true; break; }
        }
        if (pending.length > maxLineBytes) {
          // Keep scanning without retaining an unbounded corrupt line.
          pending = Buffer.alloc(maxLineBytes + 1, 0x78);
        }
    }
    if (position >= metadata.byteLength && pending.length && pending.length <= maxLineBytes) completeLines.push(pending);
    const currentMetadata = await this.getTraceMetadata(threadId);
    if (!currentMetadata || currentMetadata.revision !== metadata.revision) {
      throw new RangeError('The trace source was replaced or truncated while it was being read.');
    }

    const entries: RawLogEnvelope[] = [];
    let consumed = bytesRead - pending.length;
    let eventIndex = options.eventIndex;
    for (const rawLine of completeLines) {
      const line = rawLine.toString('utf8');
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as RawLogEnvelope);
        eventIndex += 1;
      } catch {
        // Preserve the full-reader behavior: malformed complete lines are skipped.
      }
    }
    if (position >= currentMetadata.byteLength) consumed = bytesRead;
    const nextByteOffset = options.byteOffset + consumed;
    const nextBoundaryHash = await boundaryHash(nextByteOffset);
    return {
      metadata: currentMetadata,
      entries,
      nextByteOffset,
      nextEventIndex: eventIndex,
      eof: nextByteOffset >= currentMetadata.byteLength,
      bytesRead,
      readCalls,
      startBoundaryHash,
      nextBoundaryHash,
    };
    } finally {
      await handle.close();
    }
  }

  /**
   * Resolve once every append queued so far (across all threads) has been
   * flushed to disk. Useful on plugin unload so a final event isn't lost to a
   * still-pending write, and as a deterministic barrier in tests — awaiting the
   * real write chain instead of guessing at a fixed sleep. Awaits the tails
   * that exist at call time; appends enqueued after this call are not covered.
   */
  async flushAll(): Promise<void> {
    await Promise.all([...this.writeTails.values()]);
  }

  private enqueue(abs: string, line: string): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const dir = path.dirname(abs);

    const prev = this.writeTails.get(abs) ?? Promise.resolve();
    const next = prev
      .catch(() => {}) // a prior failure must not stall the chain
      .then(async () => {
        if (!this.ensuredDirs.has(dir)) {
          await fs.promises.mkdir(dir, { recursive: true });
          this.ensuredDirs.add(dir);
        }
        await fs.promises.appendFile(abs, line, 'utf8');
      })
      .catch((err) => {
        debugLog('[ClaudeThreads] raw log append failed:', String(err));
      });
    this.writeTails.set(abs, next);
  }
}

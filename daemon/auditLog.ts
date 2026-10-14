/**
 * Append-only audit log (`audit.ndjson`): who did what, never content.
 *
 * Records are buffered and written in one batch every `flushMs`, so a burst of
 * commands costs one write, not one synchronous write each, and the log can
 * never stall the event loop that is serving turns. When the file passes
 * `maxBytes` it is rotated (`audit.ndjson` -> `.1` -> `.2` ...), keeping
 * `keep` old files, so disk use is bounded at roughly `maxBytes * (keep + 1)`.
 * `flushSync` runs on shutdown. Any I/O failure is swallowed: auditing is
 * best effort and must not take the daemon down.
 */
import { appendFileSync, renameSync, rmSync, statSync } from 'node:fs';

export interface AuditLogOptions {
  maxBytes?: number;
  keep?: number;
  flushMs?: number;
  now?: () => number;
}

export class AuditLog {
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private size: number;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly flushMs: number;
  private readonly now: () => number;

  constructor(private readonly file: string, opts: AuditLogOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    this.keep = opts.keep ?? 3;
    this.flushMs = opts.flushMs ?? 250;
    this.now = opts.now ?? (() => Date.now());
    try { this.size = statSync(file).size; } catch { this.size = 0; }
  }

  record(entry: Record<string, unknown>): void {
    let line: string;
    try {
      line = `${JSON.stringify({ ts: this.now(), ...entry })}\n`;
    } catch {
      return; // an unserializable field loses this record, not the caller
    }
    this.buffer.push(line);
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flushSync(); }, this.flushMs);
      this.timer.unref?.();
    }
  }

  /** Write everything buffered now (shutdown, tests). */
  flushSync(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.buffer.length === 0) return;
    const text = this.buffer.join('');
    this.buffer = [];
    try {
      if (this.size > 0 && this.size + text.length > this.maxBytes) this.rotate();
      appendFileSync(this.file, text, { mode: 0o600 });
      this.size += text.length;
    } catch { /* best effort */ }
  }

  private rotate(): void {
    try {
      rmSync(`${this.file}.${this.keep}`, { force: true });
      for (let i = this.keep - 1; i >= 1; i--) {
        try { renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`); } catch { /* that generation does not exist yet */ }
      }
      renameSync(this.file, `${this.file}.1`);
    } catch { /* fall through: the append below still works, the file just stays large */ }
    this.size = 0;
  }
}

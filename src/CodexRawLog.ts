import type { SessionCallbacks } from './ClaudeSession';

type Event = { method?: string; params?: Record<string, unknown>; [key: string]: unknown };
type Pending = {
  threadId: string; turnId: string; itemId?: string; source: string;
  event?: Event; tail: string; originalBytes: number; bytes: number;
};
const TAIL_BYTES = 64 * 1024;
const DIFF_BYTES = 512 * 1024;
const PENDING_BYTES = 4 * 1024 * 1024;
const PENDING_ENTRIES = 128;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function utf8Tail(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - limit);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

/** Logging-only state: live protocol delivery never depends on this buffer. */
export class CodexRawLog {
  private pending = new Map<string, Pending>();
  private bytes = 0;

  constructor(private emit: () => SessionCallbacks['onRawEvent']) {}

  record(event: Event): void {
    if (!this.emit()) { this.pending.clear(); this.bytes = 0; return; }
    const p = event.params ?? {};
    const method = event.method;
    if (method === 'item/agentMessage/delta') return;
    const threadId = p.threadId;
    const turnId = method === 'turn/completed' ? object(p.turn).id : p.turnId;
    const item = object(p.item);
    const valid = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
    if (!valid(threadId) || !valid(turnId)) { this.write(event); return; }
    if (method === 'turn/completed') {
      this.flush(threadId, turnId);
    } else if (method === 'item/completed' && valid(item.id)) {
      for (const [key, entry] of this.pending) {
        if (entry.threadId !== threadId || entry.turnId !== turnId || entry.itemId !== item.id) continue;
        const complete = entry.source === 'item/plan/delta' ? item.text : item.aggregatedOutput;
        // Only discard a tail when the completed item demonstrably contains it.
        // A truncated aggregate may omit the very error we need to diagnose.
        if (entry.originalBytes === entry.bytes && typeof complete === 'string' && complete.includes(entry.tail)) this.remove(key);
        else this.flushEntry(key, entry, 'item-completed');
      }
    } else if (method === 'turn/diff/updated' && typeof p.diff === 'string') {
      const key = JSON.stringify([threadId, turnId, method]);
      this.remove(key);
      const originalBytes = Buffer.byteLength(p.diff);
      const tail = originalBytes > DIFF_BYTES ? utf8Tail(p.diff, DIFF_BYTES) : '';
      const bytes = tail ? Buffer.byteLength(tail) : Buffer.byteLength(JSON.stringify(event));
      this.pending.set(key, { threadId, turnId, source: method, event: tail ? undefined : event, tail, originalBytes, bytes });
      this.bytes += bytes;
      this.enforceBudget();
      return;
    } else if ((method === 'item/commandExecution/outputDelta' || method === 'item/plan/delta') && valid(p.itemId) && typeof p.delta === 'string') {
      const key = JSON.stringify([threadId, turnId, p.itemId, method]);
      const previous = this.pending.get(key);
      const originalBytes = (previous?.originalBytes ?? 0) + Buffer.byteLength(p.delta);
      const tail = utf8Tail((previous?.tail ?? '') + p.delta, TAIL_BYTES);
      const bytes = Buffer.byteLength(tail);
      this.remove(key);
      this.pending.set(key, { threadId, turnId, itemId: p.itemId, source: method, tail, bytes, originalBytes });
      this.bytes += bytes;
      this.enforceBudget();
      return;
    }
    this.write(event);
  }

  flush(threadId?: string, turnId?: string): void {
    for (const [key, entry] of this.pending) {
      if (threadId !== undefined && (entry.threadId !== threadId || entry.turnId !== turnId)) continue;
      this.flushEntry(key, entry, threadId === undefined ? 'session-ended' : 'turn-completed');
    }
  }

  private enforceBudget(): void {
    while (this.bytes > PENDING_BYTES || this.pending.size > PENDING_ENTRIES) {
      const [key, entry] = this.pending.entries().next().value!;
      this.flushEntry(key, entry, 'buffer-limit');
    }
  }

  private remove(key: string): void {
    const entry = this.pending.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.pending.delete(key);
  }

  private flushEntry(key: string, entry: Pending, reason: string): void {
    this.remove(key);
    if (entry.event) { this.write(entry.event); return; }
    this.write({ method: 'codex/log/compacted', params: {
      threadId: entry.threadId, turnId: entry.turnId, itemId: entry.itemId,
      source: entry.source, reason, tail: entry.tail,
      originalBytes: entry.originalBytes, retainedBytes: entry.bytes,
      omittedBytes: entry.originalBytes - entry.bytes,
    } });
  }

  private write(event: Event): void {
    this.emit()?.({ type: String(event.method ?? 'codex/event'), ...event });
  }
}

/**
 * Command idempotency (design section 3.4): the daemon remembers the reply to
 * each `cmdId` for 10 minutes, so a `session.send` retried after a flaky
 * disconnect returns the original ack instead of running twice.
 *
 * Keyed by token id as well as cmdId so two clients can never collide or
 * read each other's replies.
 */
import type { AckFrame, ErrFrame } from '../src/protocol';

export const CMD_CACHE_TTL_MS = 10 * 60_000;

export type CachedReply = AckFrame | ErrFrame;

export class CommandCache {
  private readonly entries = new Map<string, { at: number; reply: CachedReply }>();
  private readonly inflight = new Map<string, Promise<CachedReply>>();

  constructor(private readonly ttlMs = CMD_CACHE_TTL_MS, private readonly now: () => number = () => Date.now()) {}

  private key(tokenId: string, cmdId: string): string {
    return `${tokenId}\u0000${cmdId}`;
  }

  get(tokenId: string, cmdId: string): CachedReply | undefined {
    const k = this.key(tokenId, cmdId);
    const hit = this.entries.get(k);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.entries.delete(k);
      return undefined;
    }
    return hit.reply;
  }

  set(tokenId: string, cmdId: string, reply: CachedReply): void {
    this.entries.set(this.key(tokenId, cmdId), { at: this.now(), reply });
  }

  /** A command still running (async commands): a retry of the same cmdId joins it. */
  pending(tokenId: string, cmdId: string): Promise<CachedReply> | undefined {
    return this.inflight.get(this.key(tokenId, cmdId));
  }

  /** Remember an in-flight command's reply, then cache it once it settles. */
  track(tokenId: string, cmdId: string, reply: Promise<CachedReply>): void {
    const k = this.key(tokenId, cmdId);
    this.inflight.set(k, reply);
    void reply.then((r) => { this.inflight.delete(k); this.entries.set(k, { at: this.now(), reply: r }); });
  }

  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of this.entries) if (v.at < cutoff) this.entries.delete(k);
  }

  get size(): number {
    return this.entries.size;
  }
}

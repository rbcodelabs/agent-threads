/**
 * Who holds the single read-write seat on each thread (fixed decision: one
 * attached read-write client per thread; everyone else observes).
 *
 * Same token = same client identity, so a reconnect with that token takes the
 * seat back from its own stale connection immediately instead of waiting for
 * the dead socket's pong timeout. A different token is refused until the seat
 * is released (detach, disconnect).
 */
export interface Controller {
  /** Connection id. */
  id: number;
  tokenId: string;
}

export class ControlRegistry {
  private readonly owners = new Map<string, Controller>();

  /** @returns true if `who` now holds (or already held) the seat. */
  claim(threadId: string, who: Controller): boolean {
    const cur = this.owners.get(threadId);
    if (cur && cur.id !== who.id && cur.tokenId !== who.tokenId) return false;
    this.owners.set(threadId, who);
    return true;
  }

  isController(threadId: string, connectionId: number): boolean {
    return this.owners.get(threadId)?.id === connectionId;
  }

  ownerOf(threadId: string): Controller | undefined {
    return this.owners.get(threadId);
  }

  release(threadId: string, connectionId: number): void {
    if (this.owners.get(threadId)?.id === connectionId) this.owners.delete(threadId);
  }

  releaseAll(connectionId: number): void {
    for (const [threadId, c] of this.owners) if (c.id === connectionId) this.owners.delete(threadId);
  }
}

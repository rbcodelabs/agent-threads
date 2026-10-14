/**
 * Who holds the single read-write seat on each thread (fixed decision: one
 * attached read-write client per thread; everyone else observes).
 *
 * The seat is keyed on (token, client instance). The same instance reconnecting
 * takes the seat back from its own stale connection immediately instead of
 * waiting for the dead socket's pong timeout. A different token, or a different
 * instance sharing the token (two installs configured with one token), is
 * refused until the seat is released (detach, disconnect). A client that sends
 * no instance id (older plugin, CLI) is treated as the one instance of its
 * token, which is the previous behaviour.
 */
export interface Controller {
  /** Connection id. */
  id: number;
  tokenId: string;
  /** Stable per-install id from `hello`; absent for clients that do not send one. */
  instanceId?: string;
}

/** Same client identity? Missing instance ids on either side fall back to token-only identity. */
export function sameClient(a: Controller, b: Controller): boolean {
  if (a.tokenId !== b.tokenId) return false;
  if (a.instanceId === undefined || b.instanceId === undefined) return true;
  return a.instanceId === b.instanceId;
}

export class ControlRegistry {
  private readonly owners = new Map<string, Controller>();

  /** @returns true if `who` now holds (or already held) the seat. */
  claim(threadId: string, who: Controller): boolean {
    const cur = this.owners.get(threadId);
    if (cur && cur.id !== who.id && !sameClient(cur, who)) return false;
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

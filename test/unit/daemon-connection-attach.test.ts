/**
 * A failed `attach` must not leave the connection holding the read-write seat (the seat is claimed
 * before the replay is built and the resync frame encoded, both of which can throw).
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Connection, DEFAULT_TIMINGS, type ServerContext } from '../../daemon/connection';
import { ControlRegistry } from '../../daemon/controlRegistry';

const auth = { id: 'tok1', name: 'admin', scope: 'admin' } as never;

function fakeWs(): never {
  const ws = new EventEmitter() as EventEmitter & Record<string, unknown>;
  ws.send = () => undefined; ws.close = () => undefined; ws.terminate = () => undefined; ws.ping = () => undefined;
  ws.bufferedAmount = 0;
  return ws as never;
}

/** A journal whose checkpoint cannot be encoded (BigInt is not JSON), so a cursor ahead of it makes attach throw. */
function badJournal(unsubscribed: string[]) {
  const checkpoint = { seq: 1, ts: 1, openRequests: [], inFlightText: '', bad: BigInt(1) };
  return {
    lastSeq: 1, lowWater: 0,
    rewindFor: () => null,
    checkpoint: () => checkpoint,
    withRawOpenRequests: (cp: unknown) => cp,
    replay: () => ({ kind: 'entries', entries: [], lastSeq: 1 }),
    subscribe: () => () => { unsubscribed.push('unsub'); },
  };
}

function setup(journal: unknown) {
  const controllers = new ControlRegistry();
  const ctx = {
    host: { journalFor: () => journal },
    controllers,
    timings: { ...DEFAULT_TIMINGS, helloTimeoutMs: 60_000, pingIntervalMs: 60_000 },
    audit: () => undefined,
    epoch: 'e1',
  } as unknown as ServerContext;
  const mk = () => new Connection(fakeWs(), '127.0.0.1', ctx, null, () => undefined);
  const attach = (c: Connection, afterSeq: number, observe = false) =>
    (c as unknown as { attach: (ch: string, a: number, au: unknown, e: undefined, o: boolean) => unknown }).attach('t:th', afterSeq, auth, undefined, observe);
  return { controllers, mk, attach };
}

describe('Connection.attach failure', () => {
  it('releases a seat it newly claimed when the replay cannot be built', () => {
    const { controllers, mk, attach } = setup(badJournal([]));
    const c = mk();
    expect(() => attach(c, 99)).toThrow();
    expect(controllers.ownerOf('th')).toBeUndefined();
  });

  it('restores the previous (stale same-client) owner it displaced', () => {
    const { controllers, mk, attach } = setup(badJournal([]));
    const stale = mk();
    const fresh = mk();
    const staleId = (stale as unknown as { id: number }).id;
    controllers.claim('th', { id: staleId, tokenId: 'tok1' });
    expect(() => attach(fresh, 99)).toThrow();
    expect(controllers.ownerOf('th')?.id).toBe(staleId);
  });

  it('keeps a seat the connection already held, and its previous subscription, when a re-attach fails', () => {
    const unsubscribed: string[] = [];
    const journal = badJournal(unsubscribed);
    const { controllers, mk, attach } = setup(journal);
    const c = mk();
    expect(() => attach(c, 0)).not.toThrow(); // good attach: cursor not ahead, no resync encoding
    const id = (c as unknown as { id: number }).id;
    expect(controllers.isController('th', id)).toBe(true);
    expect(() => attach(c, 99)).toThrow();
    expect(controllers.isController('th', id)).toBe(true);
    expect(unsubscribed).toEqual([]); // the first subscription was not torn down by the failed attempt
  });

  it('an observe attach never touches the seat, success or failure', () => {
    const { controllers, mk, attach } = setup(badJournal([]));
    const c = mk();
    expect(() => attach(c, 99, true)).toThrow();
    expect(controllers.ownerOf('th')).toBeUndefined();
  });
});

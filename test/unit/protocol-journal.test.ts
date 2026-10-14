import { describe, expect, it } from 'vitest';
import {
  InMemoryJournal,
  StreamCursor,
  wireJournalPolicy,
  type EventFrame,
  type JournalEntry,
  type ResyncFrame,
  type WireEvent,
} from '../../src/protocol';

const tok = (t: string): WireEvent => ({ name: 'onToken', args: [t] });
const msg = (t = 'm'): WireEvent => ({ name: 'onMessage', args: [t, []] });
const done = (): WireEvent => ({ name: 'onDone', args: ['sid', 0, 1] });
const perm = (id: string): WireEvent => ({ name: 'permission_request', args: { requestId: id, toolName: 'Bash', detail: 'ls' } });
const resolved = (id: string): WireEvent => ({ name: 'request_resolved', args: { requestId: id } });
const state = (turnInFlight: boolean): WireEvent => ({
  name: 'session.state',
  args: { turnInFlight, hasPendingPermission: false, hostAttached: true },
});

const newJournal = (opts = {}) => new InMemoryJournal<WireEvent>(wireJournalPolicy, { now: () => 1000, ...opts });

const frameOf = (seq: number, event: WireEvent): EventFrame =>
  ({ v: 1, ch: 't:T', seq, ts: 1, type: 'event', ...event }) as EventFrame;

/** Deterministic PRNG so the property-style loops are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEvents(seed: number, n: number): WireEvent[] {
  const rnd = mulberry32(seed);
  const out: WireEvent[] = [];
  let reqs = 0;
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.55) out.push(tok(`t${i}`));
    else if (r < 0.7) out.push(msg(`m${i}`));
    else if (r < 0.78) out.push(done());
    else if (r < 0.86) out.push(perm(`r${reqs++}`));
    else if (r < 0.93 && reqs > 0) out.push(resolved(`r${Math.floor(rnd() * reqs)}`));
    else out.push(state(rnd() < 0.5));
  }
  return out;
}

describe('Journal sequencing', () => {
  it('assigns strictly increasing seq starting at 1', () => {
    const j = newJournal();
    const seqs = [tok('a'), msg(), done()].map((e) => j.append(e).seq);
    expect(seqs).toEqual([1, 2, 3]);
    expect(j.lastSeq).toBe(3);
  });

  it('never reuses a seq after compaction or eviction', () => {
    const j = newJournal({ maxEntries: 2 });
    for (let i = 0; i < 10; i++) j.append(tok(`t${i}`));
    j.ack(j.lastSeq);
    j.compact();
    expect(j.append(msg()).seq).toBe(11);
  });

  it('continues numbering from startSeq (disk journal reopen)', () => {
    const j = new InMemoryJournal<WireEvent>(wireJournalPolicy, {}, 41);
    expect(j.append(tok('x')).seq).toBe(42);
    expect(j.lowWater).toBe(41);
    expect(j.replay(10).kind).toBe('resync');
    expect(j.replay(41).kind).toBe('entries');
  });
});

describe('Journal replay', () => {
  it('replay from EVERY cursor equals the live stream after that cursor', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const j = newJournal();
      const live: Array<JournalEntry<WireEvent>> = [];
      for (const e of randomEvents(seed, 60)) live.push(j.append(e));
      for (let cursor = 0; cursor <= j.lastSeq + 2; cursor++) {
        const r = j.replay(cursor);
        expect(r.kind).toBe('entries');
        if (r.kind !== 'entries') continue;
        expect(r.entries).toEqual(live.filter((e) => e.seq > cursor));
      }
    }
  });

  it('replay then live is gapless and in order for a late attacher', () => {
    const events = randomEvents(99, 80);
    for (const attachAt of [0, 1, 17, 40, 79, 80]) {
      const j = newJournal();
      const delivered: number[] = [];
      const cursor = new StreamCursor(0);
      const deliver = (e: JournalEntry<WireEvent>) => {
        if (cursor.accept(frameOf(e.seq, e.event)) === 'apply') delivered.push(e.seq);
      };

      events.slice(0, attachAt).forEach((e) => j.append(e));
      // attach: replay what exists, then everything appended later is live
      const r = j.replay(0);
      if (r.kind === 'entries') r.entries.forEach(deliver);
      events.slice(attachAt).forEach((e) => deliver(j.append(e)));

      expect(delivered).toEqual(Array.from({ length: events.length }, (_, i) => i + 1));
    }
  });

  it('returns nothing (not an error) when the cursor is at or past lastSeq', () => {
    const j = newJournal();
    j.append(tok('a'));
    expect(j.replay(1)).toEqual({ kind: 'entries', entries: [], lastSeq: 1 });
    expect(j.replay(50)).toEqual({ kind: 'entries', entries: [], lastSeq: 1 });
  });
});

describe('Journal ack and compaction', () => {
  it('ack is monotonic and clamped to lastSeq', () => {
    const j = newJournal();
    j.append(tok('a')); j.append(tok('b'));
    j.ack(2);
    j.ack(1);
    expect(j.ackedSeq).toBe(2);
    j.ack(999);
    expect(j.ackedSeq).toBe(2);
  });

  it('compaction removes ONLY token events of finished turns that are acked', () => {
    const roleOf = (e: WireEvent) => wireJournalPolicy.classify(e).role;
    for (let seed = 1; seed <= 25; seed++) {
      const events = randomEvents(seed, 70);
      const probeFor = () => {
        const j = newJournal();
        return { j, all: events.map((e) => j.append(e)) };
      };
      const lastSeq = events.length;
      for (const ackAt of [0, 5, 20, 45, lastSeq]) {
        const { j, all } = probeFor();
        j.ack(ackAt);
        const finisher = Math.max(
          0,
          ...all.filter((e) => e.seq <= ackAt && ['message', 'turn_end'].includes(roleOf(e.event))).map((e) => e.seq),
        );
        const expectedRemoved = all.filter((e) => roleOf(e.event) === 'token' && e.seq < finisher);
        expect(j.compact().removed).toBe(expectedRemoved.length);

        const kept = j.replay(0);
        if (kept.kind !== 'entries') throw new Error('unexpected resync');
        const keptBySeq = new Map(kept.entries.map((k) => [k.seq, k]));
        for (const e of all) {
          if (expectedRemoved.includes(e)) expect(keptBySeq.has(e.seq)).toBe(false);
          else expect(keptBySeq.get(e.seq)).toEqual(e); // survives byte for byte
        }
        // compaction is not eviction: lowWater is untouched, cursors stay valid
        expect(j.lowWater).toBe(0);
      }
    }
  });

  it('keeps tokens of the unfinished turn and of finished-but-unacked turns', () => {
    const j = newJournal();
    j.append(tok('a'));      // 1
    j.append(msg('A'));      // 2
    j.append(tok('b'));      // 3
    j.append(msg('B'));      // 4
    j.append(tok('c'));      // 5 (turn in flight)
    j.ack(2);                // only the first message is acked
    expect(j.compact().removed).toBe(1);   // token 1
    j.ack(5);
    expect(j.compact().removed).toBe(1);   // token 3; token 5 has no finisher after it
    const r = j.replay(0);
    if (r.kind !== 'entries') throw new Error('unexpected resync');
    expect(r.entries.map((e) => e.seq)).toEqual([2, 4, 5]);
  });

  it('is idempotent', () => {
    const j = newJournal();
    [tok('a'), msg(), done()].forEach((e) => j.append(e));
    j.ack(3);
    expect(j.compact().removed).toBe(1);
    expect(j.compact().removed).toBe(0);
  });

  it('prefers compaction over eviction when a size bound is hit', () => {
    const j = newJournal({ maxEntries: 4 });
    j.append(tok('a')); j.append(msg()); // 1,2
    j.ack(2);
    j.append(tok('b')); j.append(msg()); // 3,4  (at the bound)
    j.append(done());                    // 5: over bound -> drop acked finished token 1, no eviction
    expect(j.size).toBe(4);
    expect(j.lowWater).toBe(0);
  });
});

describe('Journal resync and bounds', () => {
  it('sends a resync checkpoint when the cursor is below lowWater', () => {
    const j = newJournal({ maxEntries: 5 });
    j.append(perm('R1'));            // 1: stays open across eviction
    j.append(state(true));           // 2
    j.append(msg('first'));          // 3
    for (let i = 0; i < 6; i++) j.append(tok(`t${i}`));   // 4..9, all unacked
    expect(j.lowWater).toBeGreaterThan(3);

    const r = j.replay(0);
    expect(r.kind).toBe('resync');
    if (r.kind !== 'resync') return;
    expect(r.checkpoint.seq).toBe(j.lastSeq);
    expect(r.checkpoint.inFlightText).toBe('t0t1t2t3t4t5');
    expect(r.checkpoint.openRequests.map((e) => e.seq)).toEqual([1]);   // survives its own eviction
    expect(r.checkpoint.state?.event).toEqual(state(true));
    expect(r.checkpoint.recentMessages.map((e) => e.event)).toEqual([msg('first')]);

    // a cursor at lowWater is still servable from the journal
    expect(j.replay(j.lowWater).kind).toBe('entries');
  });

  it('checkpoint folds request open/close, finished-turn text and the recent-message limit', () => {
    const j = newJournal({ checkpointMessages: 2 });
    j.append(perm('A')); j.append(perm('B')); j.append(resolved('A'));
    j.append(tok('x')); j.append(msg('1')); j.append(msg('2')); j.append(msg('3'));
    j.append(tok('y'));
    const cp = j.checkpoint();
    expect(cp.openRequests.map((e) => (e.event.args as { requestId: string }).requestId)).toEqual(['B']);
    expect(cp.inFlightText).toBe('y');
    expect(cp.recentMessages.map((e) => (e.event.args as unknown as [string])[0])).toEqual(['2', '3']);
  });

  it('bounds size by bytes, evicting oldest first', () => {
    const j = newJournal({ maxBytes: 400 });
    for (let i = 0; i < 50; i++) j.append(tok('x'.repeat(40)));
    expect(j.size).toBeLessThan(50);
    expect(j.size).toBeGreaterThan(0);
    expect(j.lowWater).toBe(j.lastSeq - j.size);
  });

  it('evicts by age on compact()', () => {
    let now = 0;
    const j = new InMemoryJournal<WireEvent>(wireJournalPolicy, { maxAgeMs: 100, now: () => now });
    j.append(tok('old')); now = 150; j.append(tok('new'));
    j.compact();
    expect(j.size).toBe(1);
    expect(j.lowWater).toBe(1);
    expect(j.replay(0).kind).toBe('resync');
  });

  it('resync resets the client cursor and live events continue idempotently', () => {
    const j = newJournal({ maxEntries: 3 });
    for (let i = 0; i < 8; i++) j.append(tok(`t${i}`));
    const r = j.replay(0);
    if (r.kind !== 'resync') throw new Error('expected resync');
    const cursor = new StreamCursor(0);
    const rf: ResyncFrame = { v: 1, ch: 't:T', seq: r.checkpoint.seq, ts: 1, type: 'resync', checkpoint: r.checkpoint };
    expect(cursor.accept(rf)).toBe('resync');
    expect(cursor.lastSeq).toBe(8);
    const next = j.append(tok('live'));
    expect(cursor.accept(frameOf(next.seq, next.event))).toBe('apply');
  });
});

describe('StreamCursor idempotent apply', () => {
  it('drops events with seq <= lastSeq and accepts gaps', () => {
    const c = new StreamCursor(5);
    expect(c.accept(frameOf(5, tok('x')))).toBe('duplicate');
    expect(c.accept(frameOf(3, tok('x')))).toBe('duplicate');
    expect(c.accept(frameOf(6, tok('x')))).toBe('apply');
    expect(c.accept(frameOf(6, tok('x')))).toBe('duplicate');
    expect(c.accept(frameOf(9, tok('x')))).toBe('apply');   // compaction gap is legal
    expect(c.lastSeq).toBe(9);
  });

  it('applying a replayed stream twice changes nothing', () => {
    const j = newJournal();
    randomEvents(7, 40).forEach((e) => j.append(e));
    const r = j.replay(0);
    if (r.kind !== 'entries') throw new Error('unexpected resync');
    const c = new StreamCursor(0);
    const frames = r.entries.map((e) => frameOf(e.seq, e.event));
    const first = frames.map((f) => c.accept(f)).filter((o) => o === 'apply').length;
    const second = frames.map((f) => c.accept(f)).filter((o) => o === 'apply').length;
    expect(first).toBe(frames.length);
    expect(second).toBe(0);
  });
});

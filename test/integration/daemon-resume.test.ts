/**
 * The central requirement (design 3.4): a client that loses its socket at ANY
 * point can reconnect with `attach{afterSeq}` and see every event exactly once,
 * in order. 100 randomized runs against a real server over real sockets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeTokenText } from '../../daemon/fakeHarness';
import { SPEC, TestClient, mulberry32, startTestDaemon, type Frame, type TestDaemon } from '../helpers/daemonTestClient';

const RUNS = 100;
const TOKENS = 500;
const SEED = 20261014;

let td: TestDaemon;
beforeAll(async () => { td = await startTestDaemon(); });
afterAll(async () => { await td.cleanup(); });

interface Outcome { events: Frame[]; reconnects: number; duplicates: number }

/** A consumer that reconnects with its cursor until it has seen the turn finish. */
async function consume(url: string, token: string, threadId: string, rand: () => number): Promise<Outcome> {
  const events: Frame[] = [];
  let lastSeq = 0;
  let reconnects = 0;
  let duplicates = 0;
  let sawDone = false;
  let finished = false;
  while (!finished) {
    const c = await TestClient.connect(url, token);
    expect((await c.cmd('attach', { ch: `t:${threadId}`, afterSeq: lastSeq })).type).toBe('ack');
    // Drop after a random number of frames (sometimes never) to hit replay, live and the seam between.
    const budget = rand() < 0.15 ? Infinity : 1 + Math.floor(rand() * 160);
    for (let seen = 0; !finished && seen < budget; ) {
      const ev = await c.nextEvent();
      if (ev.type !== 'event') throw new Error(`unexpected ${ev.type}`);
      if (ev.seq <= lastSeq) { duplicates++; continue; }
      events.push(ev);
      lastSeq = ev.seq;
      seen++;
      if (ev.name === 'onDone') sawDone = true;
      // The turn is over once the idle state that follows onDone has arrived.
      if (sawDone && ev.name === 'session.state') finished = true;
    }
    if (finished) { await c.close(); break; }
    c.kill();
    await c.closed;
    reconnects++;
  }
  return { events, reconnects, duplicates };
}

describe('resumable stream', () => {
  it(`delivers ${TOKENS} tokens with no gap and no duplicate across ${RUNS} randomized socket kills`, async () => {
    const rand = mulberry32(SEED);
    const url = td.daemon.url;
    const ctl = await TestClient.connect(url, td.adminToken);
    let totalReconnects = 0;

    for (let run = 0; run < RUNS; run++) {
      const threadId = `resume-${run}`;
      expect((await ctl.cmd('session.open', { threadId, spec: SPEC })).type).toBe('ack');
      // Half the runs attach before the turn starts (live path), half after it is
      // already underway (replay path + the replay/live seam).
      const attachFirst = rand() < 0.5;
      const sendTurn = async () => {
        const r = await ctl.cmd('session.send', { threadId, text: `/tokens ${TOKENS} burst=${1 + Math.floor(rand() * 40)}`, userMessageUuid: `u${run}` });
        expect(r.type).toBe('ack');
      };
      let outcome: Promise<Outcome>;
      if (attachFirst) {
        outcome = consume(url, td.adminToken, threadId, rand);
        await sendTurn();
      } else {
        await sendTurn();
        outcome = consume(url, td.adminToken, threadId, rand);
      }
      const { events, reconnects, duplicates } = await outcome;
      totalReconnects += reconnects;

      expect(duplicates, `run ${run}: server re-sent already-seen events`).toBe(0);
      // No gap: with nothing acked there is no compaction, so seq is dense from 1.
      events.forEach((e, i) => { if (e.seq !== i + 1) throw new Error(`run ${run}: gap or reorder at index ${i}: seq ${e.seq}`); });
      const texts = events.filter((e) => e.name === 'onToken').map((e) => e.args[0] as string);
      expect(texts.length, `run ${run}`).toBe(TOKENS);
      texts.forEach((t, i) => { if (t !== fakeTokenText(i)) throw new Error(`run ${run}: token ${i} was ${t}`); });
      const names = events.map((e) => e.name);
      expect(names.at(-1)).toBe('session.state');
      expect(names.filter((n) => n === 'onDone')).toHaveLength(1);
      expect(names.filter((n) => n === 'onMessage')).toHaveLength(1);
    }
    // The test is only meaningful if sockets really were killed mid-stream.
    expect(totalReconnects).toBeGreaterThan(RUNS);
    await ctl.close();
  }, 120_000);
});

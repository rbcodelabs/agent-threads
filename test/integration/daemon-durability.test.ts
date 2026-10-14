import { appendFileSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SPEC, TestClient, sleep, startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const track = async (opts?: Parameters<typeof startTestDaemon>[0]) => {
  const td = await startTestDaemon(opts);
  cleanups.push(() => td.cleanup());
  return td;
};

async function allEvents(url: string, token: string, threadId: string, afterSeq = 0) {
  const c = await TestClient.connect(url, token);
  const ack = await c.cmd('attach', { ch: `t:${threadId}`, afterSeq });
  await sleep(150);
  const events = c.frames.filter((f) => f.type === 'event' || f.type === 'resync');
  await c.close();
  return { ack, events };
}

describe('slow consumer (4408)', () => {
  it('closes a client that does not read, then lets a healthy client resume the whole stream', async () => {
    const td = await track();
    const ctl = await TestClient.connect(td.daemon.url, td.adminToken);
    await ctl.cmd('session.open', { threadId: 'slow', spec: SPEC });

    const slow = await TestClient.connect(td.daemon.url, td.adminToken);
    await slow.cmd('attach', { ch: 't:slow', afterSeq: 0 });
    // Stop reading at the socket level: the kernel buffers fill, then the daemon's queue grows.
    (slow.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket.pause();

    // 200 x 256 KB = ~50 MB, produced far faster than a paused reader consumes.
    await ctl.cmd('session.send', { threadId: 'slow', text: '/tokens 200 size=262144 burst=5', userMessageUuid: 'u' });
    await ctl.waitFor((f) => f.type === 'ack', 5000);

    // The daemon must cut the connection on its own while we are still not reading.
    await sleep(1500);
    (slow.ws as unknown as { _socket: { resume(): void } })._socket.resume();
    const closed = await slow.closed;
    expect(closed.code).toBe(4408);
    expect(closed.reason).toBe('slow_consumer');

    // The daemon is still healthy and the stream is intact for a client that keeps up.
    const lastSeen = Math.max(0, ...slow.frames.filter((f) => f.type === 'event').map((f) => f.seq as number));
    const healthy = await TestClient.connect(td.daemon.url, td.adminToken);
    await healthy.cmd('attach', { ch: 't:slow', afterSeq: lastSeen });
    let seq = lastSeen;
    for (;;) {
      const ev = await healthy.nextEvent(20_000);
      expect(ev.seq).toBe(seq + 1);
      seq = ev.seq;
      if (ev.name === 'session.state' && ev.args.turnInFlight === false && seq > 200) break;
    }
    expect(healthy.closeInfo).toBeNull();
    await Promise.all([ctl.close(), healthy.close()]);
  }, 60_000);

  it('does not penalise a healthy client replaying a backlog larger than the 4 MB limit', async () => {
    const td = await track();
    const ctl = await TestClient.connect(td.daemon.url, td.adminToken);
    await ctl.cmd('session.open', { threadId: 'big', spec: SPEC });
    await ctl.cmd('session.send', { threadId: 'big', text: '/tokens 60 size=262144 burst=10', userMessageUuid: 'u' });
    await ctl.waitFor((f) => f.type === 'ack', 5000);
    await sleep(800); // ~15 MB journaled, nobody attached

    const c = await TestClient.connect(td.daemon.url, td.adminToken);
    await c.cmd('attach', { ch: 't:big', afterSeq: 0 });
    let tokens = 0;
    for (;;) {
      const ev = await c.nextEvent(20_000);
      if (ev.name === 'onToken') tokens++;
      if (ev.name === 'onDone') break;
    }
    expect(tokens).toBe(60);
    expect(c.closeInfo).toBeNull();
    await Promise.all([ctl.close(), c.close()]);
  }, 60_000);
});

describe('restart recovery', () => {
  it('closes an in-flight turn with daemon_restarted + interrupted after a crash, and keeps seq monotonic', async () => {
    const first = await track();
    const { dataDir } = first;
    const c = await TestClient.connect(first.daemon.url, first.adminToken);
    await c.cmd('session.open', { threadId: 'crash', spec: SPEC });
    await c.cmd('attach', { ch: 't:crash', afterSeq: 0 });
    await c.cmd('session.send', { threadId: 'crash', text: '/hang', userMessageUuid: 'u' });
    await c.waitFor((f) => f.name === 'onToken');
    const before = c.events().at(-1)!.seq as number;
    c.kill();
    await first.daemon.crash(); // SIGKILL semantics: nothing is finalized

    const second = await startTestDaemon({ dataDir });
    cleanups.push(() => second.cleanup());
    expect(second.daemon.recovered).toEqual(['crash']);
    expect(second.daemon.epoch).not.toBe(first.daemon.epoch);

    const { events } = await allEvents(second.daemon.url, second.adminToken, 'crash');
    const names = events.map((e) => e.name);
    const errIdx = names.indexOf('onError');
    expect(errIdx).toBeGreaterThan(-1);
    expect(events[errIdx].args[0]).toMatchObject({ name: 'daemon_restarted' });
    expect(names[errIdx + 1]).toBe('onInterrupted');
    const last = events.at(-1)!;
    expect(last).toMatchObject({ name: 'session.state', args: { turnInFlight: false } });
    // seq is dense and continues past what the old process had emitted.
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));
    // The unflushed tail of the dead process may be missing; the closing trio never is.
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(before).toBeGreaterThanOrEqual(3);

    // The thread is usable again after a re-open, and numbering never reuses a seq.
    const c2 = await TestClient.connect(second.daemon.url, second.adminToken);
    expect((await c2.cmd('session.send', { threadId: 'crash', text: 'x', userMessageUuid: 'u2' })).code).toBe('not_found');
    const opened = await c2.cmd('session.open', { threadId: 'crash', spec: SPEC });
    expect(opened.result.lastSeq).toBeGreaterThan(last.seq);
    await c2.close();
  });

  it('a client whose cursor is ahead of a lost journal gets a resync, not silence', async () => {
    const td = await track();
    const c = await TestClient.connect(td.daemon.url, td.adminToken);
    await c.cmd('session.open', { threadId: 'ahead', spec: SPEC });
    const ack = await c.cmd('attach', { ch: 't:ahead', afterSeq: 9999 });
    expect(ack.result.resync).toBe(true);
    const f = await c.nextEvent();
    expect(f.type).toBe('resync');
    await c.close();
  });

  it('discards a torn final line left by a crash mid-write', async () => {
    const first = await track();
    const c = await TestClient.connect(first.daemon.url, first.adminToken);
    await c.cmd('session.open', { threadId: 'torn', spec: SPEC });
    await c.cmd('session.send', { threadId: 'torn', text: 'hello', userMessageUuid: 'u' });
    await c.cmd('attach', { ch: 't:torn', afterSeq: 0 });
    await c.waitFor((f) => f.name === 'onDone');
    await sleep(50);
    c.kill();
    await first.daemon.stop();
    const file = join(first.dataDir, 'journal', 'torn.ndjson');
    const intact = statSync(file).size;
    appendFileSync(file, '{"seq":9999,"ts":1,"event":{"name":"onTok');

    const second = await startTestDaemon({ dataDir: first.dataDir });
    cleanups.push(() => second.cleanup());
    expect(statSync(file).size).toBe(intact);
    const { events } = await allEvents(second.daemon.url, second.adminToken, 'torn');
    expect(events.some((e) => e.seq === 9999)).toBe(false);
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));
  });

  it('persists journals as NDJSON with an .idx sidecar under journal/', async () => {
    const td = await track();
    const c = await TestClient.connect(td.daemon.url, td.adminToken);
    await c.cmd('session.open', { threadId: 'files', spec: SPEC });
    await c.cmd('session.send', { threadId: 'files', text: 'a b c', userMessageUuid: 'u' });
    await c.cmd('attach', { ch: 't:files', afterSeq: 0 });
    await c.waitFor((f) => f.name === 'onDone');
    await sleep(50);
    expect(readdirSync(join(td.dataDir, 'journal')).sort()).toEqual(['files.idx', 'files.ndjson']);
    const lines = readFileSync(join(td.dataDir, 'journal', 'files.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i + 1));
    const idx = JSON.parse(readFileSync(join(td.dataDir, 'journal', 'files.idx'), 'utf8'));
    expect(idx).toMatchObject({ lowWater: 0, epoch: td.daemon.epoch, turnInFlight: false });
    await c.close();
  });
});

describe('blocking requests', () => {
  it('keeps a permission_request open across a disconnect and lets a later client resolve it', async () => {
    const td = await track();
    const a = await TestClient.connect(td.daemon.url, td.adminToken);
    await a.cmd('session.open', { threadId: 'perm', spec: SPEC });
    await a.cmd('attach', { ch: 't:perm', afterSeq: 0 });
    await a.cmd('session.send', { threadId: 'perm', text: '/permission', userMessageUuid: 'u' });
    const req = await a.waitFor((f) => f.name === 'permission_request');
    a.kill();
    await a.closed;

    const b = await TestClient.connect(td.daemon.url, td.adminToken);
    await b.cmd('attach', { ch: 't:perm', afterSeq: 0 });
    const replayed = await b.waitFor((f) => f.name === 'permission_request');
    expect(replayed.args.requestId).toBe(req.args.requestId);
    expect(b.events().some((e) => e.name === 'request_resolved')).toBe(false);

    const ok = await b.cmd('resolve.permission', { threadId: 'perm', requestId: req.args.requestId, allow: true });
    expect(ok.type).toBe('ack');
    await b.waitFor((f) => f.name === 'request_resolved');
    await b.waitFor((f) => f.name === 'onDone');
    // First resolver wins; a second answer learns the request is gone.
    const again = await b.cmd('resolve.permission', { threadId: 'perm', requestId: req.args.requestId, allow: false });
    expect(again).toMatchObject({ type: 'err', code: 'not_found' });
    await b.close();
  });
});

describe('retention', () => {
  it('compacts tokens of a finished, acked turn: file shrinks, message and done are kept', async () => {
    const td = await track();
    const c = await TestClient.connect(td.daemon.url, td.adminToken);
    await c.cmd('session.open', { threadId: 'ret', spec: SPEC });
    await c.cmd('attach', { ch: 't:ret', afterSeq: 0 });
    await c.cmd('session.send', { threadId: 'ret', text: '/tokens 300 size=200', userMessageUuid: 'u' });
    let last = 0;
    for (;;) {
      const ev = await c.nextEvent();
      last = ev.seq;
      if (ev.name === 'session.state' && ev.args.turnInFlight === false && last > 300) break;
    }
    await sleep(50);
    const file = join(td.dataDir, 'journal', 'ret.ndjson');
    const before = statSync(file).size;
    expect((await c.cmd('ack', { ch: 't:ret', seq: last })).type).toBe('ack');
    await sleep(600); // compaction is coalesced 250 ms after the last ack
    // Tokens go; the finalized message (which repeats their text once) stays.
    expect(statSync(file).size).toBeLessThan(before * 0.6);
    await c.close();

    const { events } = await allEvents(td.daemon.url, td.adminToken, 'ret', 0);
    const names = events.map((e) => e.name);
    expect(names).not.toContain('onToken');
    expect(names).toContain('onMessage');
    expect(names).toContain('onDone');
    // Gaps are legal after compaction, but order and uniqueness are not negotiable.
    const seqs = events.map((e) => e.seq as number);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

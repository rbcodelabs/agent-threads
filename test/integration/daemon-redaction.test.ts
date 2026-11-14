/**
 * Phase 1 of "redact secrets at write time" (Compass OPP-17): a secret a session prints must not land
 * in the daemon's journal, and the frames a client receives (served from that journal, live and on
 * replay after a reconnect) carry the masked form too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SPEC, TestClient, sleep, startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';

const GH = 'ghp_' + 'e'.repeat(36);
const ANT = 'sk-ant-api03-' + 'Ab1_'.repeat(8);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const track = async (): Promise<TestDaemon> => {
  const td = await startTestDaemon();
  cleanups.push(() => td.cleanup());
  return td;
};

describe('daemon journal and client frames are masked', () => {
  it('masks a secret the session echoes in the journal file, live frames and reconnect replay', async () => {
    const td = await track();
    const ctl = await TestClient.connect(td.daemon.url, td.adminToken);
    await ctl.cmd('session.open', { threadId: 'redact', spec: SPEC });
    await ctl.cmd('attach', { ch: 't:redact', afterSeq: 0 });
    // The fake harness echoes the text back word by word, so the secrets travel the whole
    // driver -> emit -> journal -> frame path exactly like tool output would.
    await ctl.cmd('session.send', { threadId: 'redact', text: `cat .env gave ${GH} then ${ANT} done`, userMessageUuid: 'u1' });
    for (let sawDone = false; ;) {
      const ev = await ctl.nextEvent(10_000);
      if (ev.name === 'onDone') sawDone = true;
      // The turn is over once the idle state that follows onDone has arrived.
      if (sawDone && ev.name === 'session.state') break;
    }
    const live = JSON.stringify(ctl.frames);
    expect(live).not.toContain(GH);
    expect(live).not.toContain(ANT);
    expect(live).toContain('[REDACTED:github]');

    // A fresh client replaying from seq 0 is served from the journal: still masked.
    const replayer = await TestClient.connect(td.daemon.url, td.adminToken);
    await replayer.cmd('attach', { ch: 't:redact', afterSeq: 0 });
    await sleep(200);
    const replayed = JSON.stringify(replayer.frames);
    expect(replayed).toContain('[REDACTED:github]');
    expect(replayed).not.toContain(GH);
    expect(replayed).not.toContain(ANT);

    await Promise.all([ctl.close(), replayer.close()]);
    await td.daemon.stop();

    const journal = readFileSync(join(td.dataDir, 'journal', 'redact.ndjson'), 'utf8');
    expect(journal).not.toContain(GH);
    expect(journal).not.toContain(ANT);
    expect(journal).toContain('[REDACTED:github]');
    for (const line of journal.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
  }, 30_000);
});

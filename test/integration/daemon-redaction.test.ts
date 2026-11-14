/**
 * Phase 1 of "redact secrets at write time" (Compass OPP-17): a secret a session prints must not land
 * in the daemon's journal, and the frames a client receives (served from that journal, live and on
 * replay after a reconnect) carry the masked form too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SPEC, TestClient, sleep, startTestDaemon, type Frame, type TestDaemon } from '../helpers/daemonTestClient';

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

describe('tool.call: the executing client gets the REAL input, everything at rest and everyone else gets the masked form', () => {
  const mcpInput = {
    name: 'vercel',
    type: 'oauth',
    clientSecret: '${S}',
    env: { API_KEY: '${MY_KEY}' },
    headers: { Authorization: 'Bearer ${VERCEL_TOKEN}' },
  };
  const vaultWriteInput = { path: 'Notes/env.md', text: 'deploy notes\nGITHUB_TOKEN=' + 'ghx_' + 'z9'.repeat(10) + '\nDB_PASSWORD=hunter2hunter2' };
  const HOST_TOOLS = [
    { name: 'mcp_register_server', description: 'register', inputSchema: { type: 'object' }, requiresApproval: false, server: 'claude_threads' },
    { name: 'vault_write', description: 'write', inputSchema: { type: 'object' }, requiresApproval: false, server: 'claude_threads' },
  ];
  const dispatch = (c: TestClient, threadId: string, tool: string, input: object, n: number) =>
    c.cmd('session.send', { threadId, text: `/mcp claude_threads ${tool} ${JSON.stringify(input)}`, userMessageUuid: `u-${n}` });

  async function setup(threadId: string): Promise<{ td: TestDaemon; ctl: TestClient }> {
    const td = await track();
    const ctl = await TestClient.connect(td.daemon.url, td.adminToken);
    cleanups.push(() => ctl.close().catch(() => {}));
    expect((await ctl.cmd('session.open', { threadId, spec: { ...SPEC, hostTools: HOST_TOOLS } })).type).toBe('ack');
    await ctl.cmd('attach', { ch: `t:${threadId}`, afterSeq: 0 });
    return { td, ctl };
  }
  const callFrame = (c: TestClient, tool: string): Promise<Frame> => c.waitFor((f) => f.name === 'tool.call' && f.args.tool === tool, 8000, `tool.call ${tool}`);

  it('mcp_register_server and vault_write inputs reach the seat holder intact; the file, an observer and a replay stay masked', async () => {
    const { td, ctl } = await setup('tc');
    const observer = await TestClient.connect(td.daemon.url, td.adminToken);
    cleanups.push(() => observer.close().catch(() => {}));
    await observer.cmd('attach', { ch: 't:tc', afterSeq: 0, observe: true });

    await dispatch(ctl, 'tc', 'mcp_register_server', mcpInput, 1);
    const reg = await callFrame(ctl, 'mcp_register_server');
    expect(reg.args.input).toEqual(mcpInput); // ${NAME} placeholders, env, headers, clientSecret: all intact
    await ctl.cmd('tool.result', { threadId: 'tc', callId: reg.args.callId, success: true, text: 'registered' });

    await dispatch(ctl, 'tc', 'vault_write', vaultWriteInput, 2);
    const wr = await callFrame(ctl, 'vault_write');
    expect(wr.args.input).toEqual(vaultWriteInput); // would have written [REDACTED:secret] into the note
    await ctl.cmd('tool.result', { threadId: 'tc', callId: wr.args.callId, success: true, text: 'written' });

    // The observer saw the same events, masked.
    const obsReg = await callFrame(observer, 'mcp_register_server');
    expect(JSON.stringify(obsReg.args)).not.toContain('${MY_KEY}');
    expect(JSON.stringify(obsReg.args)).not.toContain('${S}');
    expect(JSON.stringify(obsReg.args)).toContain('[REDACTED:secret]');
    const obsWr = await callFrame(observer, 'vault_write');
    expect(JSON.stringify(obsWr.args)).not.toMatch(/hunter2|ghx_/);

    // A fresh seat holder replaying the finished history gets the masked, historic form (the call is closed).
    await ctl.close();
    const again = await TestClient.connect(td.daemon.url, td.adminToken);
    cleanups.push(() => again.close().catch(() => {}));
    await again.cmd('attach', { ch: 't:tc', afterSeq: 0 });
    await sleep(200);
    expect(JSON.stringify(again.frames)).not.toMatch(/\$\{MY_KEY\}|\$\{S\}|hunter2|ghx_/);

    await Promise.all([observer.close(), again.close()]);
    await td.daemon.stop();
    const journal = readFileSync(join(td.dataDir, 'journal', 'tc.ndjson'), 'utf8');
    expect(journal).not.toMatch(/\$\{MY_KEY\}|\$\{S\}|\$\{VERCEL_TOKEN\}|hunter2|ghx_/);
    for (const line of journal.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
  }, 30_000);

  it('an unanswered call is re-delivered raw to the reattaching seat holder (reopen) and masked to an observer', async () => {
    const { td, ctl } = await setup('tr');
    await dispatch(ctl, 'tr', 'mcp_register_server', mcpInput, 1);
    const first = await callFrame(ctl, 'mcp_register_server');
    expect(first.args.input).toEqual(mcpInput);
    ctl.kill(); // laptop lid closes with the call still open

    const back = await TestClient.connect(td.daemon.url, td.adminToken);
    cleanups.push(() => back.close().catch(() => {}));
    await back.cmd('attach', { ch: 't:tr', afterSeq: first.seq as number }); // saw the call; the daemon re-presents it
    const reopened = await back.waitFor((f) => f.name === 'tool.call' && f.reopen === true, 8000, 'reopened tool.call');
    expect(reopened.args.input).toEqual(mcpInput);

    const obs = await TestClient.connect(td.daemon.url, td.adminToken);
    cleanups.push(() => obs.close().catch(() => {}));
    await obs.cmd('attach', { ch: 't:tr', afterSeq: 0, observe: true });
    const masked = await callFrame(obs, 'mcp_register_server');
    expect(JSON.stringify(masked.args)).not.toContain('${MY_KEY}');
    expect(JSON.stringify(masked.args)).toContain('[REDACTED:secret]');

    // A seat holder that attaches far ahead of the journal is resynced: the folded checkpoint carries the open call raw.
    const resynced = await TestClient.connect(td.daemon.url, td.adminToken);
    cleanups.push(() => resynced.close().catch(() => {}));
    await back.cmd('session.detach', { threadId: 'tr' });
    await resynced.cmd('attach', { ch: 't:tr', afterSeq: 9_999 });
    const rs = await resynced.waitFor((f) => f.type === 'resync', 8000, 'resync');
    const open = (rs.checkpoint.openRequests as Array<{ event: { name: string; args: { input: unknown } } }>).find((r) => r.event.name === 'tool.call');
    expect(open?.event.args.input).toEqual(mcpInput);

    // An observer's resync is masked.
    const obs2 = await TestClient.connect(td.daemon.url, td.adminToken);
    cleanups.push(() => obs2.close().catch(() => {}));
    await obs2.cmd('attach', { ch: 't:tr', afterSeq: 9_999, observe: true });
    const rs2 = await obs2.waitFor((f) => f.type === 'resync', 8000, 'observer resync');
    expect(JSON.stringify(rs2)).not.toContain('${MY_KEY}');
    expect(JSON.stringify(rs2)).toContain('tool.call');
  }, 30_000);
});

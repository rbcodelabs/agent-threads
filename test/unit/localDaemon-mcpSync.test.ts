/** Local daemon: MCP definitions and their credentials go through the container's own admin token, values on stdin only. */
import { describe, expect, it } from 'vitest';
import type { VmCommandResult, VmCommandRunner } from '../../src/containerCli';
import { CredsPusher } from '../../src/localDaemon/credsPusher';
import { cliTokenPresentArgs, containerNameFor, credsPushArgs, mcpSyncArgs } from '../../src/localDaemon/spec';

const VAULT = '/Users/me/Vault';
const NAME = containerNameFor(VAULT);
const SECRET = 'sk-local-secret-9999';

function fixture(syncExits: number[] = [0], stdout = '{"accepted":["docs"],"rejected":[],"requiredCreds":["mcpsync-global.T"],"shadowed":[]}\n') {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const exits = [...syncExits];
  const run: VmCommandRunner = async (args, opts): Promise<VmCommandResult> => {
    calls.push({ args: [...args], input: opts.input });
    if (args.join(' ') === cliTokenPresentArgs(NAME).join(' ')) return { exitCode: 0, stdout: '', stderr: '' };
    if (args.includes('mcp') && args.includes('sync')) {
      const exit = exits.shift() ?? 0;
      return exit === 0 ? { exitCode: 0, stdout, stderr: '' } : { exitCode: exit, stdout: '', stderr: `refused: ${opts.input}` };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { pusher: new CredsPusher({ vaultPath: () => VAULT, runner: () => run }), calls };
}

describe('CredsPusher.syncMcp', () => {
  it('sends the definitions on stdin only and parses the daemon reply', async () => {
    const f = fixture();
    const reply = await f.pusher.syncMcp({ docs: { type: 'http', url: 'https://x.test', headers: { A: '${mcpsync-global.T}' } } });
    expect(reply).toEqual({ accepted: ['docs'], rejected: [], requiredCreds: ['mcpsync-global.T'], shadowed: [] });
    const call = f.calls.find((c) => c.args.join(' ') === mcpSyncArgs(NAME).join(' '))!;
    expect(JSON.parse(call.input!)).toEqual({ docs: { type: 'http', url: 'https://x.test', headers: { A: '${mcpsync-global.T}' } } });
    expect(JSON.stringify(f.calls.map((c) => c.args))).not.toContain('x.test');
  });

  it('retries once with a fresh admin token, then fails with the exit code', async () => {
    const f = fixture([1, 1]);
    await expect(f.pusher.syncMcp({})).rejects.toThrow(/exit 1/);
    expect(f.calls.filter((c) => c.args.includes('sync'))).toHaveLength(2);
    const ok = fixture([1, 0]);
    await expect(ok.pusher.syncMcp({})).resolves.toMatchObject({ accepted: ['docs'] });
  });

  it('pushes credential values on stdin, never in argv', async () => {
    const f = fixture();
    await f.pusher.push('mcpsync-global', { T: SECRET }, 30 * 86400);
    const push = f.calls.find((c) => c.args.join(' ') === credsPushArgs(NAME, 'mcpsync-global', 30 * 86400).join(' '))!;
    expect(JSON.parse(push.input!)).toEqual({ T: SECRET });
    expect(JSON.stringify(f.calls.map((c) => c.args))).not.toContain(SECRET);
  });
});

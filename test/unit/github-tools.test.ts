/**
 * MCP-surface tests for the Geode GitHub connection: discovery tools, the
 * enter_vm/vm_exec envelope (notes + redaction), and that a host without the
 * connection (Obsidian) is unaffected.
 */
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import os from 'os';
import fs from 'fs';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import { createClaudeThreadsMcpServers, type ObsidianMcpServerOptions } from '../../src/ObsidianTools';
import { containerNameForThread, type VmCommandRunner } from '../../src/sandboxVm';
import { GithubCredentialBroker, type GithubAuthBridge } from '../../src/githubCredentials';

const app = {
  plugins: { plugins: {} },
  workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() },
  vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
  metadataCache: { on: () => {} },
} as unknown as App;

const TOKEN = 'ghu_' + 'z'.repeat(36);
const THREAD = 't-gh-1';
const NAME = containerNameForThread(THREAD);
const MOUNT = fs.realpathSync(os.tmpdir());

type ToolDef = { name: string; handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };

function bridge(over: Partial<GithubAuthBridge> = {}): GithubAuthBridge {
  return {
    status: async () => ({ state: 'connected', login: 'octo-user' }),
    getToken: async () => ({ ok: true, value: TOKEN }),
    listAccess: async () => ({ ok: true, value: [{ id: 1, account: 'octo-user', repositories: [{ id: 9, fullName: 'octo-user/sandbox', private: true }] }] }),
    checkRepo: async (repo) => ({
      ok: true,
      value: repo === 'octo-user/sandbox'
        ? { covered: true, installationId: 1, installUrl: null }
        : { covered: false, installationId: null, installUrl: 'https://github.com/apps/geode-rb-code-labs/installations/new' },
    }),
    ...over,
  };
}

function tools(opts: { bridge?: GithubAuthBridge; enabled?: boolean; run?: VmCommandRunner } = {}) {
  const options: ObsidianMcpServerOptions = {
    threadId: THREAD,
    initialCwd: MOUNT,
    vmCommandRunner: opts.run,
    githubBroker: new GithubCredentialBroker({ bridge: opts.bridge, fetchProfile: async () => ({ id: 1, login: 'octo-user', name: 'Octo' }) }),
    isGithubConnectionEnabled: () => opts.enabled ?? true,
  };
  const server = createClaudeThreadsMcpServers(app, options).claude_threads as unknown as { tools: ToolDef[]; harnessTools: Array<{ name: string; requiresApproval: boolean }> };
  return { server, get: (n: string) => server.tools.find((t) => t.name === n)! };
}

async function call(def: ToolDef, args: Record<string, unknown> = {}) {
  const r = await def.handler(args, {});
  return { isError: r.isError === true, payload: JSON.parse(r.content[0]!.text) };
}

describe('github_list_access / github_check_repo', () => {
  it('lists repository names only — never a credential', async () => {
    const { get } = tools({ bridge: bridge() });
    const { payload, isError } = await call(get('github_list_access'));
    expect(isError).toBe(false);
    expect(payload.installations).toEqual([{ account: 'octo-user', repositories: ['octo-user/sandbox'] }]);
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
  });

  it('check_repo: granted, not granted (with install URL), and invalid input', async () => {
    const { get } = tools({ bridge: bridge() });
    expect((await call(get('github_check_repo'), { repo: 'octo-user/sandbox' })).payload).toMatchObject({ success: true, accessible: true });

    const denied = await call(get('github_check_repo'), { repo: 'octo-user/nope' });
    expect(denied.isError).toBe(true);
    expect(denied.payload.code).toBe('repo_not_granted');
    expect(denied.payload.installUrl).toContain('installations/new');
    expect(denied.payload.error).toContain('octo-user/nope');

    const bad = await call(get('github_check_repo'), { repo: 'not a repo; rm -rf' });
    expect(bad.isError).toBe(true);
  });

  it('gives actionable errors for disconnect / expiry', async () => {
    const disconnected = tools({ bridge: bridge({
      status: async () => ({ state: 'disconnected', encryptionAvailable: true }),
      listAccess: async () => ({ ok: false, code: 'reauth_required', message: 'GitHub is not connected.' }),
    }) });
    const d = await call(disconnected.get('github_list_access'));
    expect(d.payload.code).toBe('not_connected');
    expect(d.payload.error).toContain('Settings → GitHub');

    const expired = tools({ bridge: bridge({
      status: async () => ({ state: 'reauth_required', message: 'x' }),
      listAccess: async () => ({ ok: false, code: 'reauth_required', message: 'x' }),
    }) });
    expect((await call(expired.get('github_list_access'))).payload.code).toBe('reauth_required');
  });

  it('reports "unavailable" when there is no Geode bridge (Obsidian) or the setting is off', async () => {
    const obsidian = tools({ bridge: undefined });
    expect((await call(obsidian.get('github_list_access'))).payload.code).toBe('unavailable');
    const off = tools({ bridge: bridge(), enabled: false });
    expect((await call(off.get('github_list_access'))).payload.error).toContain('turned off');
  });

  it('is read-only on the native-harness path (no approval prompt) and registered on both servers', () => {
    const { server } = tools({ bridge: bridge() });
    for (const n of ['github_list_access', 'github_check_repo']) {
      expect(server.harnessTools.find((t) => t.name === n)?.requiresApproval, n).toBe(false);
    }
    const both = createClaudeThreadsMcpServers(app) as unknown as Record<string, { tools: Array<{ name: string }> }>;
    expect(both.obsidian!.tools.map((t) => t.name)).toContain('github_list_access');
  });
});

describe('enter_vm / vm_exec envelope', () => {
  function runner() {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const run: VmCommandRunner = async (args, opts) => {
      calls.push({ args: [...args], input: opts.input });
      const j = args.join(' ');
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'nf' };
      if (j.includes('git remote -v')) return { exitCode: 0, stdout: `origin https://x-access-token:${TOKEN}@github.com/a/b.git`, stderr: `warn ${TOKEN}` };
      if (args[0] === '--version') return { exitCode: 0, stdout: 'container 1', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    return { run, calls };
  }

  it('enter_vm reports the GitHub status note; the token is only ever sent over stdin', async () => {
    const { run, calls } = runner();
    const { get } = tools({ bridge: bridge(), run });
    const { payload } = await call(get('enter_vm'));
    expect(payload.success).toBe(true);
    expect(payload.notes.join('\n')).toContain('GitHub');
    expect(calls.filter((c) => c.input === TOKEN)).toHaveLength(1);
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain(TOKEN);
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
    void NAME;
  });

  it('vm_exec masks a token that a command echoes back', async () => {
    const { run } = runner();
    const { get } = tools({ bridge: bridge(), run });
    await call(get('enter_vm'));
    const { payload } = await call(get('vm_exec'), { command: 'git remote -v' });
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
    expect(payload.stdout).toContain('[REDACTED]');
  });

  it('without a Geode bridge, enter_vm/vm_exec behave as before (no notes, no credential traffic)', async () => {
    const { run, calls } = runner();
    const { get } = tools({ bridge: undefined, run });
    const entered = await call(get('enter_vm'));
    expect(entered.payload.notes).toBeUndefined();
    const exec = await call(get('vm_exec'), { command: 'echo hi' });
    expect(exec.payload.notes).toBeUndefined();
    expect(calls.every((c) => c.input === undefined)).toBe(true);
  });
});

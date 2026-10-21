import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../../daemon/config';
import { capabilitiesFor } from '../../daemon/connection';
import { createRealHarness, specToSessionOptions } from '../../daemon/claudeDriver';
import {
  HARNESS_FEATURES,
  describeHarnessCredential,
  findHarnessBinary,
  harnessCapabilities,
  missingBinaryMessage,
} from '../../daemon/harnesses';
import { PolicyError, isReadOnlyDenylist, validateSpec, filterClientEnv } from '../../daemon/sessionPolicy';
import { CodexSession } from '../../src/CodexSession';
import { openCodePermissionConfig } from '../../src/OpenCodeSession';
import { OpenCodeSession } from '../../src/OpenCodeSession';
import { ThreadSession } from '../../src/ThreadSession';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { RemoteSessionSpec } from '../../src/protocol';
import { isEditDenied } from '../../src/toolRestrictions';

let root: string;
let ws: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'harnesses-')));
  ws = join(root, 'ws');
  mkdirSync(join(ws, 'repo'), { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const exe = (dir: string, name: string): string => {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\n');
  chmodSync(p, 0o755);
  return p;
};

describe('binary discovery per harness', () => {
  it('finds each CLI on PATH by its own name', () => {
    const bin = join(root, 'bin-a');
    const codex = exe(bin, 'codex');
    const opencode = exe(bin, 'opencode');
    const env = { PATH: bin };
    expect(findHarnessBinary('codex', undefined, env, join(root, 'nohome'))).toBe(codex);
    expect(findHarnessBinary('opencode', undefined, env, join(root, 'nohome'))).toBe(opencode);
    expect(findHarnessBinary('claude', undefined, env, join(root, 'nohome'))).toBeNull();
  });

  it('falls back to the usual install directories under HOME', () => {
    const home = join(root, 'home-b');
    const codex = exe(join(home, '.npm-global/bin'), 'codex');
    const opencode = exe(join(home, '.opencode/bin'), 'opencode');
    expect(findHarnessBinary('codex', undefined, { PATH: '' }, home)).toBe(codex);
    expect(findHarnessBinary('opencode', undefined, { PATH: '' }, home)).toBe(opencode);
  });

  it('an explicit path is used as given and never replaced by a PATH lookup', () => {
    const bin = join(root, 'bin-c');
    exe(bin, 'codex');
    expect(findHarnessBinary('codex', join(root, 'missing-codex'), { PATH: bin }, join(root, 'nohome'))).toBeNull();
    const explicit = exe(join(root, 'elsewhere'), 'my-codex');
    expect(findHarnessBinary('codex', explicit, { PATH: '' }, join(root, 'nohome'))).toBe(explicit);
  });

  it('the missing-CLI message names the config key and the environment variable', () => {
    expect(missingBinaryMessage('codex')).toMatch(/codex CLI not found.*codexBinaryPath.*AGENT_THREADS_CODEX_BINARY/);
    expect(missingBinaryMessage('opencode')).toMatch(/opencode CLI not found.*opencodeBinaryPath.*AGENT_THREADS_OPENCODE_BINARY/);
    expect(missingBinaryMessage('claude')).toMatch(/claude CLI not found/);
  });

  it('createRealHarness throws the clear error instead of constructing a session without a CLI', () => {
    const spec = (harness: string) => ({ harness, cwd: ws, permissionMode: 'default', extraEnvRaw: '' }) as RemoteSessionSpec;
    for (const [h, re] of [['claude', /claude CLI not found/], ['codex', /codex CLI not found/], ['opencode', /opencode CLI not found/]] as const) {
      expect(() => createRealHarness(spec(h), { claude: '/nonexistent/claude', codex: '/nonexistent/codex', opencode: '/nonexistent/opencode' }, { PATH: '' })).toThrow(re);
    }
    expect(() => createRealHarness(spec('fake'), {}, { PATH: '' })).toThrow(/cannot be started/);
  });

  it('createRealHarness builds the adapter that matches the spec', () => {
    const bin = join(root, 'bin-d');
    const binaries = Object.fromEntries(['claude', 'codex', 'opencode'].map((n) => [n, exe(bin, n)]));
    const env = { PATH: '' };
    const spec = (harness: string) => ({ harness, cwd: ws, permissionMode: 'default', extraEnvRaw: '' }) as RemoteSessionSpec;
    expect(createRealHarness(spec('claude'), binaries, env)).toBeInstanceOf(ThreadSession);
    expect(createRealHarness(spec('codex'), binaries, env)).toBeInstanceOf(CodexSession);
    expect(createRealHarness(spec('opencode'), binaries, env)).toBeInstanceOf(OpenCodeSession);
  });
});

describe('credential discovery for the startup log', () => {
  it('reports the source, never the value', () => {
    const home = join(root, 'home-cred');
    expect(describeHarnessCredential('codex', { CODEX_API_KEY: 'sk-secret' }, home)).toBe('CODEX_API_KEY (environment)');
    expect(describeHarnessCredential('codex', { OPENAI_API_KEY: 'sk-secret' }, home)).toBe('OPENAI_API_KEY (environment)');
    expect(describeHarnessCredential('codex', {}, home)).toMatch(/none found.*codex login/);
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), '{}');
    expect(describeHarnessCredential('codex', {}, home)).toMatch(/existing Codex login/);
    expect(describeHarnessCredential('opencode', {}, home)).toMatch(/none found.*opencode auth login/);
    expect(describeHarnessCredential('opencode', { OPENROUTER_API_KEY: 'x' }, home)).toBe('OPENROUTER_API_KEY (environment)');
    mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
    writeFileSync(join(home, '.local/share/opencode/auth.json'), '{}');
    expect(describeHarnessCredential('opencode', {}, home)).toMatch(/existing OpenCode login/);
    for (const text of [describeHarnessCredential('codex', { CODEX_API_KEY: 'sk-secret' }, home), describeHarnessCredential('opencode', { OPENROUTER_API_KEY: 'sk-secret' }, home)]) {
      expect(text).not.toContain('sk-secret');
    }
  });

  it('a client may not set the credential or config-location variables of the new harnesses', () => {
    const raw = ['CODEX_HOME=/evil', 'OPENAI_API_KEY=x', 'OPENCODE_CONFIG=/evil', 'XDG_CONFIG_HOME=/evil', 'MYVAR=1'].join('\n');
    // Even when the operator lists them, they stay unsettable.
    const out = filterClientEnv(raw, ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENCODE_CONFIG', 'XDG_CONFIG_HOME', 'MYVAR']);
    expect(out.text).toBe('MYVAR=1');
    expect(out.dropped).toEqual(['CODEX_HOME', 'OPENAI_API_KEY', 'OPENCODE_CONFIG', 'XDG_CONFIG_HOME']);
  });
});

describe('capabilities', () => {
  it('each harness advertises its own feature set', () => {
    const caps = harnessCapabilities(['claude', 'codex', 'opencode']);
    for (const [h, features] of Object.entries(HARNESS_FEATURES)) {
      expect(caps).toContain(`harness.${h}`);
      for (const f of features) expect(caps).toContain(`harness.${h}.${f}`);
    }
    expect(HARNESS_FEATURES.claude).toEqual(expect.arrayContaining(['mcp_status', 'session_options']));
    expect(HARNESS_FEATURES.codex).not.toContain('session_options');
    expect(HARNESS_FEATURES.opencode).not.toContain('mcp_status');
  });

  it('is what the adapters really implement', () => {
    // The claim behind `mcp_status`, and the absence of a child-agent feature: only ThreadSession reports MCP status,
    // and no local harness has the optional child-agent controls.
    expect(typeof (ThreadSession.prototype as any).mcpServerStatus).toBe('function');
    for (const proto of [ThreadSession.prototype, CodexSession.prototype, OpenCodeSession.prototype] as any[]) {
      expect(proto.sendAgentMessage).toBeUndefined();
      expect(proto.interruptAgent).toBeUndefined();
    }
    for (const proto of [CodexSession.prototype, OpenCodeSession.prototype] as any[]) {
      expect(proto.mcpServerStatus).toBeUndefined();
      for (const m of ['setModel', 'setPermissionMode', 'getContextUsage', 'getUsageSnapshot']) expect(typeof proto[m]).toBe('function');
    }
  });

  it('capabilitiesFor keeps the base set, adds enabled harnesses, and treats fake as fake only', () => {
    expect(capabilitiesFor('claude')).toEqual(expect.arrayContaining(['host.tools', 'harness.claude', 'harness.claude.set_model']));
    expect(capabilitiesFor('claude', ['claude', 'codex'])).toContain('harness.codex');
    expect(capabilitiesFor('claude', ['claude', 'codex'])).not.toContain('harness.opencode');
    expect(capabilitiesFor('fake', ['claude'])).toContain('harness.fake');
    expect(capabilitiesFor('fake', ['claude'])).not.toContain('harness.claude');
  });
});

describe('config: harness selection', () => {
  const cfg = (flags: object = {}, env: NodeJS.ProcessEnv = {}) => resolveConfig({ flags: { dataDir: join(root, 'cfg'), workspaces: [ws], ...flags }, env });

  it('defaults to all three harnesses with claude as the default', () => {
    expect(cfg()).toMatchObject({ harness: 'claude', harnesses: ['claude', 'codex', 'opencode'] });
  });
  it('an explicit single harness restricts the daemon to it (the old meaning of AGENT_THREADS_HARNESS)', () => {
    expect(cfg({}, { AGENT_THREADS_HARNESS: 'claude' })).toMatchObject({ harness: 'claude', harnesses: ['claude'] });
    expect(cfg({ harness: 'codex' })).toMatchObject({ harness: 'codex', harnesses: ['codex'] });
  });
  it('an explicit set wins, from flag or env; the default is the explicit harness or the first of the set', () => {
    expect(cfg({ harnesses: ['codex', 'opencode'] })).toMatchObject({ harness: 'codex', harnesses: ['codex', 'opencode'] });
    expect(cfg({}, { AGENT_THREADS_HARNESSES: 'opencode,claude' })).toMatchObject({ harness: 'opencode', harnesses: ['opencode', 'claude'] });
    expect(cfg({ harness: 'claude', harnesses: ['claude', 'codex'] })).toMatchObject({ harness: 'claude', harnesses: ['claude', 'codex'] });
  });
  it('rejects an unknown harness and a default outside the set', () => {
    expect(() => cfg({}, { AGENT_THREADS_HARNESS: 'gemini' })).toThrow(/invalid harness/);
    expect(() => cfg({}, { AGENT_THREADS_HARNESSES: 'claude,gemini' })).toThrow(/invalid harness/);
    expect(() => cfg({ harness: 'codex', harnesses: ['claude'] })).toThrow(/not among the enabled/);
  });
  it('fake stays available for tests and ignores the set', () => {
    expect(cfg({ harness: 'fake' }).harness).toBe('fake');
  });
  it('takes the binary paths from flag, env, then config', () => {
    expect(cfg({ codexBinaryPath: '/a/codex' }, { AGENT_THREADS_CODEX_BINARY: '/b/codex' }).codexBinaryPath).toBe('/a/codex');
    expect(cfg({}, { AGENT_THREADS_CODEX_BINARY: '/b/codex', AGENT_THREADS_OPENCODE_BINARY: '/b/opencode' })).toMatchObject({ codexBinaryPath: '/b/codex', opencodeBinaryPath: '/b/opencode' });
    expect(cfg().codexBinaryPath).toBeUndefined();
  });
});

describe('policy: harness admission', () => {
  const spec = (over: Partial<RemoteSessionSpec> = {}): RemoteSessionSpec =>
    ({ harness: 'claude', cwd: join(ws, 'repo'), permissionMode: 'default', extraEnvRaw: '', ...over });
  const code = (fn: () => unknown): string | undefined => {
    try { fn(); } catch (e) { return e instanceof PolicyError ? `${e.code}:${e.message}` : `other:${String(e)}`; }
    return undefined;
  };

  it.each(['claude', 'codex', 'opencode'] as const)('accepts %s when enabled', (harness) => {
    expect(validateSpec(spec({ harness }), { workspaces: [ws], allowBypass: false, harnesses: ['claude', 'codex', 'opencode'] }).harness).toBe(harness);
  });
  it('without a harness list only Claude is allowed (the policy before this change)', () => {
    expect(code(() => validateSpec(spec(), { workspaces: [ws], allowBypass: false }))).toBeUndefined();
    expect(code(() => validateSpec(spec({ harness: 'codex' }), { workspaces: [ws], allowBypass: false }))).toMatch(/^bad_frame:.*not enabled/);
  });
  it('refuses a harness that is not enabled, and one that does not exist', () => {
    expect(code(() => validateSpec(spec({ harness: 'opencode' }), { workspaces: [ws], allowBypass: false, harnesses: ['claude'] }))).toMatch(/^bad_frame:.*not enabled/);
    expect(code(() => validateSpec(spec({ harness: 'gemini' as never }), { workspaces: [ws], allowBypass: false, harnesses: ['claude', 'codex', 'opencode'] }))).toMatch(/^bad_frame:.*not supported/);
    expect(code(() => validateSpec(spec({ harness: 'fake' as never }), { workspaces: [ws], allowBypass: false, harnesses: ['claude'] }))).toMatch(/^bad_frame/);
  });
  it('the read-only denylist is the same for every harness and recognised as such', () => {
    for (const harness of ['claude', 'codex', 'opencode'] as const) {
      const out = validateSpec(spec({ harness }), { workspaces: [], readOnlyWorkspaces: [ws], allowBypass: false, harnesses: ['claude', 'codex', 'opencode'] });
      expect(isReadOnlyDenylist(out.disallowedTools)).toBe(true);
    }
    expect(isReadOnlyDenylist(['Edit'])).toBe(false);
    expect(isReadOnlyDenylist(undefined)).toBe(false);
  });
});

describe('spec -> HarnessSessionOptions per harness', () => {
  const callbacks = {} as SessionCallbacks;
  const base = (over: Partial<RemoteSessionSpec> = {}): RemoteSessionSpec =>
    ({ harness: 'claude', cwd: ws, permissionMode: 'default', extraEnvRaw: '', ...over });
  const parts = { callbacks };

  it('codex: maps every permission mode through resolveCodexPermissions', () => {
    const table: Record<string, [string, string]> = {
      default: ['untrusted', 'workspace-write'],
      plan: ['on-request', 'read-only'],
      acceptEdits: ['on-request', 'workspace-write'],
      dontAsk: ['never', 'workspace-write'],
      bypassPermissions: ['never', 'workspace-write'],
      auto: ['on-request', 'workspace-write'],
    };
    for (const [mode, [approvalPolicy, sandbox]] of Object.entries(table)) {
      const o = specToSessionOptions(base({ harness: 'codex', permissionMode: mode as never }), parts);
      expect(o.codex).toMatchObject({ approvalPolicy, sandbox });
    }
  });

  it('codex: carries model, prompt, directories and resume; drops the Claude-only session options', () => {
    const o = specToSessionOptions(base({
      harness: 'codex', model: 'gpt-5', appendSystemPrompt: 'be brief', additionalDirectories: [ws], resumeFallbackHistory: 'h',
      disallowedTools: ['Bash'], sessionOptions: { effort: 'xhigh', thinking: { type: 'enabled' }, betas: ['b'], agents: { a: {} }, persistSession: false },
    }), { ...parts, resume: 'thread-1' });
    expect(o).toMatchObject({ cwd: ws, model: 'gpt-5', appendSystemPrompt: 'be brief', additionalDirectories: [ws], resumeFallbackHistory: 'h', resume: 'thread-1', disallowedTools: ['Bash'] });
    expect(o.codex?.effort).toBe('xhigh');
    expect(JSON.stringify(o.codex)).not.toMatch(/thinking|betas|agents|persistSession/);
    expect(o.claude).toBeUndefined();
  });

  it('codex: a read-only denylist pins the sandbox read-only whatever the mode', () => {
    const o = specToSessionOptions(base({ harness: 'codex', permissionMode: 'dontAsk', disallowedTools: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'] }), parts);
    expect(o.codex).toMatchObject({ sandbox: 'read-only', enforceReadOnly: true, approvalPolicy: 'never' });
  });

  it('opencode: only the opencode block, with external servers and tools; no claude, no codex', () => {
    const tool = { name: 't', description: 'd', inputSchema: {}, requiresApproval: false, invoke: vi.fn() };
    const o = specToSessionOptions(base({ harness: 'opencode', mcpServers: { docs: { type: 'sse', url: 'https://x.test/sse' } } }), { ...parts, dynamicTools: [tool] });
    expect(o.opencode).toEqual({ dynamicTools: [tool], mcpServers: { docs: { type: 'sse', url: 'https://x.test/sse' } } });
    expect(o.claude).toBeUndefined();
    expect(o.codex).toBeUndefined();
  });

  it('daemon-configured servers reach codex and opencode, and win over a client server of the same name', () => {
    const daemonServers = { gh: { command: 'gh-mcp', args: ['--x'] }, docs: { type: 'http' as const, url: 'https://daemon.test/mcp' } };
    for (const harness of ['codex', 'opencode'] as const) {
      const o = specToSessionOptions(base({ harness, mcpServers: { docs: { type: 'http', url: 'https://client.test/mcp' }, claude_threads: { type: 'http', url: 'https://evil.test' } } }), { ...parts, daemonServers, hostServerNames: ['claude_threads'] });
      const servers = (harness === 'codex' ? o.codex : o.opencode)?.mcpServers;
      expect(servers).toEqual({ docs: { type: 'http', url: 'https://daemon.test/mcp' }, gh: { command: 'gh-mcp', args: ['--x'] } });
    }
  });

  it('a daemon-configured server may not use a reserved name even if it slipped past config parsing', () => {
    const daemonServers = { claude_threads: { command: 'evil' } };
    const o = specToSessionOptions(base({ harness: 'codex' }), { ...parts, daemonServers });
    expect(o.codex?.mcpServers).toBeUndefined();
  });
});

describe('read-only enforcement in the adapters', () => {
  it('OpenCode denies its edit permission when any edit tool is disallowed', () => {
    expect(openCodePermissionConfig(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']).edit).toBe('deny');
    expect(openCodePermissionConfig(['Write']).edit).toBe('deny');
    expect(openCodePermissionConfig(['Bash']).edit).toBeUndefined();
    expect(openCodePermissionConfig().edit).toBeUndefined();
    expect(isEditDenied(['WebFetch'])).toBe(false);
  });

  it('Codex keeps the sandbox read-only across a live permission-mode change when enforceReadOnly is set', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'thread';
    internal.options = { cwd: ws, permissionMode: 'plan', codex: { approvalPolicy: 'on-request', sandbox: 'read-only', enforceReadOnly: true }, callbacks: { onError: vi.fn() } };
    const request = vi.spyOn(internal, 'request').mockResolvedValue({});
    await session.setPermissionMode('dontAsk');
    expect(request).toHaveBeenCalledWith('thread/settings/update', expect.objectContaining({ approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } }));
  });

  it('Codex without the flag still follows the mode (a user\'s own thread is unchanged)', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'thread';
    internal.options = { cwd: ws, permissionMode: 'plan', codex: { approvalPolicy: 'on-request', sandbox: 'read-only' }, callbacks: { onError: vi.fn() } };
    const request = vi.spyOn(internal, 'request').mockResolvedValue({});
    await session.setPermissionMode('dontAsk');
    expect(request).toHaveBeenCalledWith('thread/settings/update', expect.objectContaining({ sandboxPolicy: expect.objectContaining({ type: 'workspaceWrite' }) }));
  });
});

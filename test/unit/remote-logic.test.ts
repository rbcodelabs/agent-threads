import { describe, expect, it } from 'vitest';
import type { HarnessSessionOptions } from '../../src/HarnessSession';
import { SESSION_OPTION_DISPOSITION } from '../../src/protocol';
import { GitDiffService, type GitDiffExecFile } from '../../src/GitDiffService';
import { StatusLineService, type StatusLineExec } from '../../src/StatusLineService';
import type { ThreadManager } from '../../src/ThreadManager';
import { resolveThreadProjectName } from '../../src/pathUtils';
import { connectionPill } from '../../src/remote/connectionPill';
import { checkDaemonInput, describeProbe, slugifyDaemonName, tokenSecretNameFor, uniqueDaemonId } from '../../src/remote/daemonConfig';
import { normalizeRemoteCwd, resolveRunOn, runOnSuffix } from '../../src/remote/runOn';
import { buildRemoteEnvironmentPrompt, projectSessionOptions } from '../../src/remote/sessionSpec';
import { remoteCwdLabel, remoteGroup, threadCwdLabel } from '../../src/remote/threadLocation';
import type { RemoteDaemonConfig, Thread } from '../../src/types';

const box: RemoteDaemonConfig = { id: 'claude-box', name: 'claude-box', url: 'wss://claude-box.ts.net:8443', tokenSecretName: 'T', defaultCwdRoot: '/srv/workspaces' };
const lab: RemoteDaemonConfig = { id: 'lab', name: 'lab', url: 'ws://100.1.2.3:7433', tokenSecretName: 'T2' };

function remoteThread(over: Partial<Thread> = {}): Thread {
  return {
    id: 't1', title: 't', cwd: '/srv/workspaces/x', messages: [], createdAt: 0, updatedAt: 0, status: 'waiting',
    remote: { daemonId: 'claude-box', ownership: 'client', remoteCwd: '/srv/workspaces/x', lastSeq: 0, ownerClientId: 'c' },
    ...over,
  } as Thread;
}

describe('projectSessionOptions', () => {
  const callbacks = {} as HarnessSessionOptions['callbacks'];
  const options: HarnessSessionOptions = {
    cwd: '/Users/me/vault/local',
    permissionMode: 'acceptEdits',
    extraEnvRaw: 'AWS_SECRET=hunter2\nPATH=/Users/me/bin',
    resume: 'native-1',
    callbacks,
    additionalDirectories: ['/Users/me/vault', '/Users/me/vault/local'],
    model: 'opus',
    appendSystemPrompt: 'remote prompt',
    resumeFallbackHistory: 'history',
    secretEnv: { GH_TOKEN: 'ghp_secret' },
    containerAuthToken: 'container-token',
    disallowedTools: ['Bash(rm:*)'],
    claude: {
      mcpServers: { local: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer leak' } } as never },
      vmMcpServers: {},
      disallowedTools: ['WebSearch', 'Bash(rm:*)'],
      sessionOptions: { effort: 'high', betas: ['b1' as never], persistSession: true, plugins: [{ type: 'local', path: '/Users/me/p' } as never], agents: { reviewer: { description: 'd', prompt: 'p' } as never } },
      vm: { mode: 'always' } as never,
    },
    codex: { approvalPolicy: 'never', sandbox: 'read-only' },
    opencode: { dynamicTools: [] },
  };

  it('carries the daemon-meaningful fields and uses the remote cwd, not the local one', () => {
    const spec = projectSessionOptions(options, remoteThread());
    expect(spec).toMatchObject({
      harness: 'claude', cwd: '/srv/workspaces/x', permissionMode: 'acceptEdits', model: 'opus', resume: 'native-1',
      resumeFallbackHistory: 'history', appendSystemPrompt: 'remote prompt',
    });
    expect(spec.disallowedTools).toEqual(['WebSearch', 'Bash(rm:*)']);
    expect(spec.sessionOptions).toMatchObject({ effort: 'high', betas: ['b1'], persistSession: true, agents: { reviewer: { prompt: 'p' } } });
  });

  it('leaves everything local behind: secrets, env, paths, callbacks, MCP servers, VM routing, other harnesses', () => {
    const spec = projectSessionOptions(options, remoteThread());
    const wire = JSON.stringify(spec);
    for (const leak of ['hunter2', 'ghp_secret', 'container-token', 'Bearer leak', '/Users/me', '127.0.0.1', 'always']) {
      expect(wire, `spec leaks "${leak}"`).not.toContain(leak);
    }
    expect(spec.extraEnvRaw).toBe('');
    expect(spec).not.toHaveProperty('additionalDirectories');
    expect(spec).not.toHaveProperty('mcpServers');
    expect(spec).not.toHaveProperty('hostTools');
    expect(spec).not.toHaveProperty('callbacks');
    expect(spec.sessionOptions).not.toHaveProperty('plugins');
  });

  it('every field the disposition table says never crosses the wire is absent from the spec', () => {
    const spec = projectSessionOptions(options, remoteThread()) as unknown as Record<string, unknown>;
    for (const [field, how] of Object.entries(SESSION_OPTION_DISPOSITION)) {
      if (how === 'omitted') expect(spec, field).not.toHaveProperty(field);
    }
  });

  it('refuses a thread that is not remote', () => {
    expect(() => projectSessionOptions(options, { ...remoteThread(), remote: undefined })).toThrow(/not a remote thread/);
  });

  it('describes the remote machine, not the Mac vault, in the environment prompt', () => {
    const p = buildRemoteEnvironmentPrompt('/srv/workspaces/x', 'claude-box', 'Geode');
    expect(p).toContain('claude-box');
    expect(p).toContain('/srv/workspaces/x');
    expect(p).not.toContain('Vault root');
  });
});

describe('Run on picker logic', () => {
  it('normalises the remote folder', () => {
    expect(normalizeRemoteCwd(' /srv//workspaces/x/ ')).toEqual({ ok: true, cwd: '/srv/workspaces/x' });
    expect(normalizeRemoteCwd('/')).toEqual({ ok: true, cwd: '/' });
    expect(normalizeRemoteCwd('')).toMatchObject({ ok: false });
    expect(normalizeRemoteCwd('~/x')).toMatchObject({ ok: false, reason: expect.stringMatching(/absolute/) });
    expect(normalizeRemoteCwd('relative/x')).toMatchObject({ ok: false });
  });

  it('runs locally when no daemon is selected', () => {
    expect(resolveRunOn({}, [box])).toEqual({ ok: true });
  });

  it('resolves a daemon + folder, falling back to the daemon default folder', () => {
    expect(resolveRunOn({ daemonId: 'claude-box', cwd: '/srv/workspaces/p' }, [box, lab])).toEqual({ ok: true, remote: { daemonId: 'claude-box', cwd: '/srv/workspaces/p' } });
    expect(resolveRunOn({ daemonId: 'claude-box' }, [box])).toEqual({ ok: true, remote: { daemonId: 'claude-box', cwd: '/srv/workspaces' } });
  });

  it('never falls back to local when the folder is bad or the daemon is gone', () => {
    expect(resolveRunOn({ daemonId: 'lab', cwd: '' }, [lab])).toMatchObject({ ok: false });
    expect(resolveRunOn({ daemonId: 'lab', cwd: 'nope' }, [lab])).toMatchObject({ ok: false });
    expect(resolveRunOn({ daemonId: 'removed', cwd: '/x' }, [box])).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer configured/) });
  });

  it('labels the send button', () => {
    expect(runOnSuffix({ daemonId: 'claude-box' }, [box])).toBe(' on claude-box');
    expect(runOnSuffix({}, [box])).toBe('');
    expect(runOnSuffix({ daemonId: 'gone' }, [box])).toBe('');
  });
});

describe('daemon settings logic', () => {
  it('derives unique ids and secret names', () => {
    expect(slugifyDaemonName('  Claude Box! ')).toBe('claude-box');
    expect(slugifyDaemonName('!!!')).toBe('daemon');
    expect(uniqueDaemonId('claude-box', [box])).toBe('claude-box-2');
    expect(uniqueDaemonId('Lab', [box])).toBe('lab');
    expect(tokenSecretNameFor('claude-box')).toBe('AGENT_THREADS_DAEMON_CLAUDE_BOX_TOKEN');
  });

  it('validates input', () => {
    expect(checkDaemonInput({ name: '', url: 'wss://x' }, [])).toMatchObject({ ok: false, field: 'name' });
    expect(checkDaemonInput({ name: 'CLAUDE-BOX', url: 'wss://x' }, [box])).toMatchObject({ ok: false, field: 'name' });
    expect(checkDaemonInput({ name: 'claude-box', url: 'wss://x' }, [box], 'claude-box')).toMatchObject({ ok: true });
    expect(checkDaemonInput({ name: 'a', url: '' }, [])).toMatchObject({ ok: false, field: 'url' });
    expect(checkDaemonInput({ name: 'a', url: 'ftp://x' }, [])).toMatchObject({ ok: false, field: 'url' });
    expect(checkDaemonInput({ name: 'a', url: 'wss://user:pw@x' }, [])).toMatchObject({ ok: false, field: 'url', reason: expect.stringMatching(/credentials/) });
    expect(checkDaemonInput({ name: 'a', url: 'wss://x?token=1' }, [])).toMatchObject({ ok: false, field: 'url' });
    expect(checkDaemonInput({ name: 'a', url: 'wss://x', requireToken: true }, [])).toMatchObject({ ok: false, field: 'token' });
    expect(checkDaemonInput({ name: 'a', url: '100.1.2.3:7433/', token: 't', requireToken: true }, [])).toEqual({ ok: true, url: 'ws://100.1.2.3:7433' });
  });

  it('words the test-connection result', () => {
    const info = { daemonId: 'd', daemonVersion: '0.62.2', protocol: 1, minClientVersion: '0.0.0', capabilities: [], epoch: 'e' };
    expect(describeProbe({ ok: true, info })).toEqual({ tone: 'ok', text: 'Connected: agent-threads 0.62.2, protocol 1' });
    expect(describeProbe({ ok: false, status: 'unauthorized', detail: 'x' })).toMatchObject({ tone: 'error', text: expect.stringMatching(/rejected this token/) });
    expect(describeProbe({ ok: false, status: 'incompatible', detail: 'protocol 2' }).text).toMatch(/protocol 2/);
    expect(describeProbe({ ok: false, status: 'unreachable', detail: 'ECONNREFUSED' }).text).toMatch(/ECONNREFUSED/);
  });
});

describe('connection pill', () => {
  const info = { daemonId: 'd', daemonVersion: '0.62.2', protocol: 1, minClientVersion: '0.0.0', capabilities: [], epoch: 'e' };
  it('maps every state to a distinct, honest pill', () => {
    expect(connectionPill({ status: 'connected', attempt: 0, info }, 'box')).toMatchObject({ kind: 'connected', tone: 'ok', label: 'Connected' });
    expect(connectionPill({ status: 'reconnecting', attempt: 2 }, 'box')).toMatchObject({ kind: 'reconnecting', tone: 'warn', label: 'Reconnecting' });
    expect(connectionPill({ status: 'unreachable', attempt: 5, detail: 'timeout' }, 'box')).toMatchObject({ kind: 'unreachable', tone: 'error', label: 'Daemon unreachable' });
    expect(connectionPill({ status: 'incompatible', attempt: 0, detail: 'older' }, 'box')).toMatchObject({ kind: 'protocol', label: 'Protocol too old' });
    expect(connectionPill({ status: 'unauthorized', attempt: 0 }, 'box')).toMatchObject({ kind: 'auth' });
    expect(connectionPill(undefined, 'box')).toMatchObject({ kind: 'connecting' });
    expect(connectionPill({ status: 'reconnecting', attempt: 1 }, 'box').title).toMatch(/continues on the daemon/);
  });
});

describe('where a thread runs', () => {
  const nameOf = (id: string) => (id === 'claude-box' ? 'Claude Box' : id);
  it('spells remote folders as host:path and groups them by daemon + folder', () => {
    const t = remoteThread();
    expect(remoteCwdLabel(t, nameOf)).toBe('Claude Box:/srv/workspaces/x');
    expect(threadCwdLabel(t, () => 'local label', nameOf)).toBe('Claude Box:/srv/workspaces/x');
    expect(threadCwdLabel({ ...t, remote: undefined }, () => 'local label', nameOf)).toBe('local label');
    expect(remoteGroup(t, nameOf)).toEqual({ key: 'remote:claude-box:/srv/workspaces/x', label: 'Claude Box · x' });
    expect(remoteGroup({ ...t, remote: undefined })).toBeUndefined();
  });

  it('never walks the local disk for a remote thread project name', () => {
    // `/` exists locally and is a directory; a remote thread must not resolve through it.
    expect(resolveThreadProjectName({ cwd: '/srv/workspaces/my-app', remote: {} })).toBe('my-app');
    expect(resolveThreadProjectName({ cwd: '/srv/workspaces/my-app/', remote: {}, projectNameOverride: 'Override' })).toBe('Override');
  });
});

// ── local polling services must skip remote threads ─────────────────────────

function fakeManager(threads: Thread[]) {
  const listeners = new Set<(id: string, ev: { type: string }) => void>();
  const applied: Array<{ id: string; kind: string }> = [];
  return {
    subscribe(l: (id: string, ev: { type: string }) => void) { listeners.add(l); return () => listeners.delete(l); },
    emit(id: string, ev: { type: string }) { for (const l of listeners) l(id, ev); },
    getThreads() { return threads; },
    getThread(id: string) { return threads.find((t) => t.id === id); },
    applyStatusTags(id: string) { applied.push({ id, kind: 'tags' }); return false; },
    applyGitDiff(id: string) { applied.push({ id, kind: 'diff' }); },
    applied,
  };
}

describe('local polling skips remote threads', () => {
  const localThread = { id: 'local', title: 'l', cwd: '/srv/workspaces/x', messages: [], createdAt: 0, updatedAt: 0 } as Thread;

  it('StatusLineService never runs the command for, or applies tags to, a remote thread', async () => {
    const mgr = fakeManager([remoteThread({ id: 'remote' }), localThread]);
    const cwds: string[] = [];
    const exec: StatusLineExec = (_cmd, opts, cb) => { cwds.push(String((opts as { cwd?: string }).cwd ?? '')); setTimeout(() => cb(null, '[]', ''), 0); return { stdin: { write() {}, end() {} } }; };
    const svc = new StatusLineService(mgr as unknown as ThreadManager, () => ({ statusLineCommand: 'sl.sh' }), { exec, now: () => 1, homedir: () => '/h', isMobile: false });
    await svc.pollAll();
    svc.pokeThread('remote');
    mgr.emit('remote', { type: 'done' });
    await new Promise((r) => setTimeout(r, 300));
    // The remote and the local thread share the same cwd string; only the local thread may be touched.
    expect(mgr.applied.map((a) => a.id)).toEqual(['local']);
    svc.stop();
  });

  it('GitDiffService never runs git for, or applies a diff to, a remote thread', async () => {
    const mgr = fakeManager([remoteThread({ id: 'remote' }), localThread]);
    const calls: string[] = [];
    const execFile: GitDiffExecFile = (_f, _args, o, cb) => { calls.push(o.cwd); setTimeout(() => cb(new Error('no git'), '', ''), 0); };
    const svc = new GitDiffService(mgr as unknown as ThreadManager, { execFile, now: () => 1, isMobile: false });
    await svc.pollAll();
    svc.pokeThread('remote');
    await new Promise((r) => setTimeout(r, 100));
    expect(mgr.applied.filter((a) => a.id === 'remote')).toEqual([]);
    expect(calls.every((c) => c === '/srv/workspaces/x')).toBe(true); // only from the local thread's poll
    expect(calls.length).toBeGreaterThan(0);
    svc.stop();
  });
});

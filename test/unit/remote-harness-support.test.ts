import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from '../../daemon/connection';
import { daemonHarnesses, gateHarness } from '../../src/remote/harnessSupport';
import { projectSessionOptions } from '../../src/remote/sessionSpec';
import { describeHostToolsForPrompt } from '../../src/remote/hostTools';
import type { HarnessSessionOptions } from '../../src/HarnessSession';
import type { Thread } from '../../src/types';
import type { SessionCallbacks } from '../../src/ClaudeSession';

describe('daemonHarnesses', () => {
  it('reads harness.<kind> and ignores harness.<kind>.<feature>', () => {
    expect(daemonHarnesses(['host.tools', 'harness.claude', 'harness.claude.set_model', 'harness.codex'])).toEqual(['claude', 'codex']);
    expect(daemonHarnesses(['harness.opencode.usage'])).toEqual(['claude']); // a feature entry alone is not the harness
  });
  it('an older daemon (no harness.* at all) is Claude only', () => {
    expect(daemonHarnesses(['session.channel', 'host.tools'])).toEqual(['claude']);
    expect(daemonHarnesses([])).toEqual(['claude']);
  });
  it('capabilities not known yet are unknown, not "none"', () => {
    expect(daemonHarnesses(undefined)).toBeUndefined();
  });
  it('the scripted fake daemon accepts any harness; unknown kinds are ignored', () => {
    expect(daemonHarnesses(['harness.fake'])).toEqual(['claude', 'codex', 'opencode']);
    expect(daemonHarnesses(['harness.gemini', 'harness.codex'])).toEqual(['codex']);
  });
  it('agrees with what the daemon advertises', () => {
    expect(daemonHarnesses(capabilitiesFor('claude', ['claude', 'opencode']))).toEqual(['claude', 'opencode']);
    expect(daemonHarnesses(capabilitiesFor('claude', ['claude']))).toEqual(['claude']);
    expect(daemonHarnesses(capabilitiesFor('fake'))).toEqual(['claude', 'codex', 'opencode']);
  });
});

describe('gateHarness', () => {
  it('passes a harness the daemon offers and one it might (unknown)', () => {
    expect(gateHarness('codex', ['harness.codex'], 'box')).toEqual({ ok: true, known: true });
    expect(gateHarness('codex', undefined, 'box')).toEqual({ ok: true, known: false });
  });
  it('explains what is missing, and what is offered', () => {
    const g = gateHarness('opencode', ['harness.claude', 'harness.codex'], 'box');
    expect(g).toEqual({ ok: false, reason: expect.stringContaining('box is not set up for OpenCode (it offers: Claude, Codex)') });
  });
  it('tells an older daemon to be updated rather than reconfigured', () => {
    const g = gateHarness('codex', ['host.tools'], 'old-box');
    expect(g).toEqual({ ok: false, reason: 'old-box is an older daemon that only runs Claude. Update it to run Codex.' });
    expect(gateHarness('claude', ['host.tools'], 'old-box')).toEqual({ ok: true, known: true });
  });
});

describe('projectSessionOptions per harness', () => {
  const callbacks = {} as SessionCallbacks;
  const thread = (agentHarness: Thread['agentHarness']): Thread => ({
    id: 't', title: 'x', cwd: '/srv/x', status: 'idle', messages: [], createdAt: 0, updatedAt: 0, agentHarness,
    remote: { daemonId: 'box', ownership: 'client', remoteCwd: '/srv/x', lastSeq: 0 },
  }) as unknown as Thread;
  const mcp = { docs: { type: 'http' as const, url: 'https://docs.test/mcp', headers: { a: 'b' } } };
  const base: HarnessSessionOptions = { cwd: '/srv/x', permissionMode: 'default', extraEnvRaw: '', callbacks, model: 'm', appendSystemPrompt: 'p' };

  it('claude keeps the full projection', () => {
    const spec = projectSessionOptions({
      ...base, disallowedTools: ['Bash'],
      claude: { disallowedTools: ['WebFetch'], sessionOptions: { effort: 'high', persistSession: true, betas: ['b'] as never, agents: { a: {} } as never }, remoteMcpServers: mcp },
    }, thread('claude'));
    expect(spec).toMatchObject({
      harness: 'claude', cwd: '/srv/x', permissionMode: 'default', model: 'm', appendSystemPrompt: 'p', extraEnvRaw: '',
      disallowedTools: ['WebFetch', 'Bash'], sessionOptions: { effort: 'high', persistSession: true, betas: ['b'], agents: { a: {} } }, mcpServers: mcp,
    });
  });

  it('a thread with no harness recorded is Claude (older data)', () => {
    expect(projectSessionOptions(base, thread(undefined)).harness).toBe('claude');
  });

  it('codex: the harness, the effort the daemon reads, the vetted MCP servers; nothing Claude-only', () => {
    const spec = projectSessionOptions({
      ...base, disallowedTools: ['Bash'],
      // a stale claude block must not leak into a Codex spec
      claude: { disallowedTools: ['WebFetch'], sessionOptions: { effort: 'low', betas: ['b'] as never, agents: { a: {} } as never }, remoteMcpServers: { leak: mcp.docs } },
      codex: { approvalPolicy: 'untrusted', sandbox: 'workspace-write', effort: 'ultra', mcpServers: mcp },
    }, thread('codex'));
    expect(spec.harness).toBe('codex');
    expect(spec.sessionOptions).toEqual({ effort: 'ultra' });
    expect(spec.mcpServers).toEqual(mcp);
    expect(spec.disallowedTools).toEqual(['Bash']);
    expect(JSON.stringify(spec)).not.toMatch(/approvalPolicy|sandbox|betas|agents|leak|WebFetch/);
  });

  it('codex without an effort sends no session options', () => {
    expect(projectSessionOptions({ ...base, codex: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' } }, thread('codex')).sessionOptions).toBeUndefined();
  });

  it('opencode: the harness and its vetted MCP servers only', () => {
    const spec = projectSessionOptions({ ...base, claude: { sessionOptions: { effort: 'high' } }, opencode: { mcpServers: mcp } }, thread('opencode'));
    expect(spec.harness).toBe('opencode');
    expect(spec.sessionOptions).toBeUndefined();
    expect(spec.mcpServers).toEqual(mcp);
  });

  it('only http/sse servers cross, whatever the harness', () => {
    const spec = projectSessionOptions({ ...base, codex: { approvalPolicy: 'untrusted', sandbox: 'workspace-write', mcpServers: { local: { command: 'node' }, ...mcp } } }, thread('codex'));
    expect(Object.keys(spec.mcpServers ?? {})).toEqual(['docs']);
  });
});

describe('host-tools prompt names per harness', () => {
  const summary = { builtIn: ['vault_search'], servers: { 'google-docs': ['create_doc'] } };
  it('Claude keeps the MCP names', () => {
    const text = describeHostToolsForPrompt(summary, 'Geode').join('\n');
    expect(text).toContain('mcp__claude_threads__*: vault_search');
    expect(text).toContain('mcp__google-docs__*: create_doc');
  });
  it('Codex and OpenCode get the names they actually see', () => {
    for (const h of ['codex', 'opencode'] as const) {
      const text = describeHostToolsForPrompt(summary, 'Geode', h).join('\n');
      expect(text, h).toContain('  - vault_search');
      expect(text, h).toContain('  - google-docs__create_doc');
      expect(text, h).not.toContain('mcp__');
    }
  });
});

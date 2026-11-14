/**
 * The six places that used to fall through silently to Claude or OpenCode, and the other wiring a new harness needs.
 * Each assertion fails if Antigravity is dropped from (or mistaken for another harness in) that place.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_HARNESSES, DEFAULT_SETTINGS, agentHarnessLabel, isAgentHarness, type Thread } from '../../src/types';
import { createHarnessSession } from '../../src/HarnessFactory';
import { AntigravitySession } from '../../src/AntigravitySession';
import { HARNESS_BRAND_ICONS } from '../../src/harnessBrandIcons';
import { describeComposerSettings } from '../../src/composerSettings';
import { chooseChiefOfStaffHarness } from '../../src/chiefOfStaffOnboarding';
import { SESSION_OPTION_DISPOSITION } from '../../src/protocol/spec';
import { projectSessionOptions } from '../../src/remote/sessionSpec';
import { describeHostToolsForPrompt } from '../../src/remote/hostTools';
import { parseHarnessProbe } from '../../src/localDaemon/parse';
import { LOCAL_HARNESSES } from '../../src/localDaemon/spec';
import { specToSessionOptions } from '../../daemon/claudeDriver';
import { HARNESS_BINARY, REAL_HARNESSES, harnessCapabilities } from '../../daemon/harnesses';
import { gateHarness } from '../../src/remote/harnessSupport';
import type { SessionCallbacks } from '../../src/ClaudeSession';
import type { HarnessSessionOptions } from '../../src/HarnessSession';
import type { RemoteSessionSpec } from '../../src/protocol';

const callbacks = {} as SessionCallbacks;

describe('antigravity is a first-class harness value', () => {
  it('is registered, labelled and recognised', () => {
    expect(AGENT_HARNESSES).toContain('antigravity');
    expect(isAgentHarness('antigravity')).toBe(true);
    expect(agentHarnessLabel('antigravity')).toBe('Antigravity');
    expect(DEFAULT_SETTINGS.antigravityBinaryPath).toBe('agy');
  });

  it('has an icon and a composer glyph of its own', () => {
    expect(HARNESS_BRAND_ICONS.antigravity).toBe('antigravity-mark');
    expect(describeComposerSettings({ harness: 'antigravity', model: undefined, activeModel: undefined }).provider)
      .toEqual({ glyph: 'antigravity', label: 'Antigravity' });
  });

  it('HarnessFactory builds an AntigravitySession, not Claude, for it', () => {
    const session = createHarnessSession({ agentHarness: 'antigravity' } as Thread, { ...DEFAULT_SETTINGS, antigravityBinaryPath: '/x/agy' });
    expect(session).toBeInstanceOf(AntigravitySession);
  });

  it('the wire disposition table classifies its option block', () => {
    expect(SESSION_OPTION_DISPOSITION.antigravity).toBe('transformed');
  });
});

describe('remote wiring', () => {
  const thread = { agentHarness: 'antigravity', remote: { daemonId: 'd', remoteCwd: '/srv/w', clientId: 'c' }, goal: undefined } as unknown as Thread;
  const base: HarnessSessionOptions = { cwd: '/srv/w', permissionMode: 'default', extraEnvRaw: '', callbacks, model: 'm' };

  it('projectSessionOptions reads the antigravity block for MCP servers (not OpenCode\'s)', () => {
    const spec = projectSessionOptions({
      ...base,
      opencode: { mcpServers: { wrong: { type: 'http', url: 'https://wrong.example' } } },
      antigravity: { mcpServers: { docs: { type: 'http', url: 'https://docs.example', headers: { A: 'b' } } } },
    }, thread);
    expect(spec.harness).toBe('antigravity');
    expect(spec.mcpServers).toEqual({ docs: { type: 'http', url: 'https://docs.example', headers: { A: 'b' } } });
    expect(spec.sessionOptions).toBeUndefined();
  });

  it('the daemon turns an antigravity spec into the antigravity block and never into Claude options', () => {
    const spec = { harness: 'antigravity', cwd: '/srv/w', permissionMode: 'default', extraEnvRaw: '', mcpServers: { docs: { type: 'http', url: 'https://docs.example' } } } as RemoteSessionSpec;
    const options = specToSessionOptions(spec, { callbacks, dynamicTools: [{ name: 't', description: '', inputSchema: {}, requiresApproval: false, invoke: async () => ({ success: true, text: '' }) }] });
    expect(options.antigravity?.dynamicTools).toHaveLength(1);
    expect(options.antigravity?.mcpServers).toMatchObject({ docs: { url: 'https://docs.example' } });
    expect(options.claude).toBeUndefined();
    expect(options.opencode).toBeUndefined();
  });

  it('an unknown harness is refused instead of silently becoming Claude', () => {
    expect(() => specToSessionOptions({ harness: 'gemini', cwd: '/w', permissionMode: 'default', extraEnvRaw: '' } as unknown as RemoteSessionSpec, { callbacks })).toThrow(/cannot be started/);
  });

  it('the daemon hosts, advertises and locates it', () => {
    expect(REAL_HARNESSES).toContain('antigravity');
    expect(HARNESS_BINARY.antigravity.exe).toBe('agy');
    expect(harnessCapabilities(['antigravity'])).toEqual(expect.arrayContaining(['harness.antigravity', 'harness.antigravity.set_model']));
    expect(gateHarness('antigravity', ['harness.claude'], 'box')).toMatchObject({ ok: false });
    expect(gateHarness('antigravity', ['harness.claude', 'harness.antigravity'], 'box')).toEqual({ ok: true, known: true });
  });

  it('names host tools as plain tools in the remote prompt, like Codex and OpenCode, not as Claude MCP names', () => {
    const summary = { builtIn: ['vault_search'], servers: {} } as never;
    const text = describeHostToolsForPrompt(summary, 'Mac', 'antigravity').join('\n');
    expect(text).toContain('vault_search');
    expect(text).not.toContain('mcp__');
  });
});

describe('the managed local container does not offer Antigravity yet', () => {
  it('is not a local harness, and a probe line for it is ignored rather than misread', () => {
    expect(LOCAL_HARNESSES).not.toContain('antigravity');
    expect(parseHarnessProbe('antigravity.cli=1\nclaude.cli=1\n')).toEqual({ claude: { cli: true, signedIn: false } });
  });
});

describe('Chief of Staff harness choice', () => {
  it('never lands on Antigravity (its adapter has no skill sources, so cos-setup would not exist)', () => {
    expect(chooseChiefOfStaffHarness('antigravity', () => true)).toBe('claude');
    expect(chooseChiefOfStaffHarness('antigravity', (h) => h === 'antigravity')).toBeUndefined();
    expect(chooseChiefOfStaffHarness('codex', () => true)).toBe('codex');
  });
});

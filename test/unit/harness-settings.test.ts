import { describe, expect, it } from 'vitest';
import {
  isLikelyClaudeModel,
  migrateHarnessSettings,
  normalizeCatalogEntries,
  resolveDefaultPermissionMode,
  resolveEffectivePermissionMode,
  resolveHarnessDefaultModel,
  resolveHarnessPermissionModeOverride,
  setHarnessDefaultModel,
  setHarnessPermissionModeOverride,
  updateCatalogEntries,
} from '../../src/harnessSettings';
import { DEFAULT_SETTINGS, type PluginSettings, type Thread } from '../../src/types';
import { ThreadManager } from '../../src/ThreadManager';
import { createClaudeThreadsApiV1 } from '../../src/PublicApi';
import { describeScheduledExecution } from '../../src/scheduledWorkView';

describe('harnessSettings helpers', () => {
  it('recognizes Claude aliases and pinned IDs vs other provider models', () => {
    expect(isLikelyClaudeModel('opus')).toBe(true);
    expect(isLikelyClaudeModel('sonnet')).toBe(true);
    expect(isLikelyClaudeModel('claude-opus-5-5')).toBe(true);
    expect(isLikelyClaudeModel('us.anthropic.claude-sonnet-5-5')).toBe(true);
    expect(isLikelyClaudeModel('gemini-4-carbon-medium')).toBe(false);
    expect(isLikelyClaudeModel('gpt-5.6-codex')).toBe(false);
    expect(isLikelyClaudeModel('openai/gpt-5')).toBe(false);
    expect(isLikelyClaudeModel('')).toBe(false);
  });

  it('migrates legacy Claude defaultModel into defaultModelByHarness.claude', () => {
    const settings: PluginSettings = {
      ...DEFAULT_SETTINGS,
      agentHarness: 'claude',
      defaultModel: 'sonnet',
    };
    expect(migrateHarnessSettings(settings)).toBe(true);
    expect(settings.defaultModelByHarness).toEqual({ claude: 'sonnet' });
    expect(settings.defaultModel).toBe('sonnet');
    // Idempotent on second pass
    expect(migrateHarnessSettings(settings)).toBe(false);
  });

  it('rescues a non-Claude model ID saved in defaultModel when agentHarness was non-Claude', () => {
    const settings: PluginSettings = {
      ...DEFAULT_SETTINGS,
      agentHarness: 'antigravity',
      defaultModel: 'gemini-4-carbon-medium',
    };
    expect(migrateHarnessSettings(settings)).toBe(true);
    expect(settings.defaultModelByHarness).toEqual({ antigravity: 'gemini-4-carbon-medium' });
    expect(settings.defaultModel).toBe('');
    expect(resolveHarnessDefaultModel(settings, 'antigravity')).toBe('gemini-4-carbon-medium');
    expect(resolveHarnessDefaultModel(settings, 'claude')).toBeUndefined();
  });

  it('stores independent default models per harness without clobbering others', () => {
    const settings: PluginSettings = { ...DEFAULT_SETTINGS };
    setHarnessDefaultModel(settings, 'claude', 'opus');
    setHarnessDefaultModel(settings, 'codex', 'gpt-5.6-codex');
    setHarnessDefaultModel(settings, 'opencode', 'anthropic/claude-sonnet-4-5');
    setHarnessDefaultModel(settings, 'antigravity', 'gemini-4-carbon-medium');

    expect(resolveHarnessDefaultModel(settings, 'claude')).toBe('opus');
    expect(settings.defaultModel).toBe('opus');
    expect(resolveHarnessDefaultModel(settings, 'codex')).toBe('gpt-5.6-codex');
    expect(resolveHarnessDefaultModel(settings, 'opencode')).toBe('anthropic/claude-sonnet-4-5');
    expect(resolveHarnessDefaultModel(settings, 'antigravity')).toBe('gemini-4-carbon-medium');

    // Clearing Claude default clears legacy defaultModel without touching Antigravity/Codex
    setHarnessDefaultModel(settings, 'claude', '');
    expect(resolveHarnessDefaultModel(settings, 'claude')).toBeUndefined();
    expect(settings.defaultModel).toBe('');
    expect(resolveHarnessDefaultModel(settings, 'antigravity')).toBe('gemini-4-carbon-medium');
    expect(resolveHarnessDefaultModel(settings, 'codex')).toBe('gpt-5.6-codex');
  });

  it('resolves permission mode hierarchy: thread override > harness override > global default', () => {
    const settings: PluginSettings = {
      ...DEFAULT_SETTINGS,
      permissionMode: 'acceptEdits',
    };
    setHarnessPermissionModeOverride(settings, 'antigravity', 'bypassPermissions');
    setHarnessPermissionModeOverride(settings, 'codex', 'default');

    expect(resolveHarnessPermissionModeOverride(settings, 'claude')).toBeUndefined();
    expect(resolveDefaultPermissionMode(settings, 'claude')).toBe('acceptEdits');
    expect(resolveDefaultPermissionMode(settings, 'antigravity')).toBe('bypassPermissions');
    expect(resolveDefaultPermissionMode(settings, 'codex')).toBe('default');

    expect(resolveEffectivePermissionMode(settings, { agentHarness: 'antigravity' })).toBe('bypassPermissions');
    expect(resolveEffectivePermissionMode(settings, { agentHarness: 'antigravity', permissionMode: 'plan' })).toBe('plan');
    expect(resolveEffectivePermissionMode(settings, { agentHarness: 'claude' })).toBe('acceptEdits');

    setHarnessPermissionModeOverride(settings, 'antigravity', undefined);
    expect(resolveDefaultPermissionMode(settings, 'antigravity')).toBe('acceptEdits');
  });

  it('normalizes, merges, and replaces discovered model catalogs with accurate change detection', () => {
    const initial = normalizeCatalogEntries([
      { value: 'gemini-4-carbon-medium', displayName: 'Gemini 4 Carbon (Medium)' },
      { value: 'gemini-4-carbon-medium', displayName: 'Duplicate ignored' },
      { value: '  ', displayName: 'Blank ignored' },
    ]);
    expect(initial).toEqual([
      { value: 'gemini-4-carbon-medium', displayName: 'Gemini 4 Carbon (Medium)' },
    ]);

    const unchanged = updateCatalogEntries(initial, initial, 'merge');
    expect(unchanged.changed).toBe(false);

    const merged = updateCatalogEntries(
      initial,
      [
        { value: 'gemini-4-carbon-medium', displayName: 'Gemini 4 Carbon (Medium) v2' },
        { value: 'gemini-4-carbon-high', displayName: 'Gemini 4 Carbon (High)' },
      ],
      'merge',
    );
    expect(merged.changed).toBe(true);
    expect(merged.entries).toEqual([
      { value: 'gemini-4-carbon-medium', displayName: 'Gemini 4 Carbon (Medium) v2' },
      { value: 'gemini-4-carbon-high', displayName: 'Gemini 4 Carbon (High)' },
    ]);

    const replaced = updateCatalogEntries(
      merged.entries,
      [{ value: 'gemini-4-argon-high', displayName: 'Gemini 4 Argon (High)' }],
      'replace',
    );
    expect(replaced.changed).toBe(true);
    expect(replaced.entries).toEqual([
      { value: 'gemini-4-argon-high', displayName: 'Gemini 4 Argon (High)' },
    ]);
  });
});

describe('ThreadManager & PublicApi per-harness defaults', () => {
  it('passes per-harness default model and permission mode to local and remote session options', () => {
    const settings: PluginSettings = {
      ...DEFAULT_SETTINGS,
      permissionMode: 'acceptEdits',
      defaultModel: 'sonnet',
      defaultModelByHarness: {
        claude: 'sonnet',
        codex: 'gpt-5.6-codex',
        opencode: 'openai/gpt-5',
        antigravity: 'gemini-4-carbon-medium',
      },
      permissionModeByHarness: {
        antigravity: 'bypassPermissions',
        codex: 'default',
      },
    };

    const manager = new ThreadManager(settings);
    const buildLocal = (thread: Thread) =>
      (manager as unknown as { buildThreadSessionOptions: (id: string, t: Thread) => any }).buildThreadSessionOptions(thread.id, thread);
    const buildRemote = (thread: Thread) =>
      (manager as unknown as { buildRemoteSessionOptions: (id: string, t: Thread, mo: string | undefined, latest: boolean) => any })
        .buildRemoteSessionOptions(thread.id, thread, undefined, true);

    const agyThread = manager.createThread('Agy work', process.cwd(), undefined, 'antigravity');
    const agyOpts = buildLocal(agyThread);
    expect(agyOpts.model).toBe('gemini-4-carbon-medium');
    expect(agyOpts.permissionMode).toBe('bypassPermissions');

    // Explicit thread override wins over harness default
    agyThread.model = 'gemini-4-carbon-high';
    agyThread.permissionMode = 'plan';
    const agyOverridden = buildLocal(agyThread);
    expect(agyOverridden.model).toBe('gemini-4-carbon-high');
    expect(agyOverridden.permissionMode).toBe('plan');

    const codexThread = manager.createThread('Codex work', process.cwd(), undefined, 'codex');
    const codexOpts = buildLocal(codexThread);
    expect(codexOpts.model).toBe('gpt-5.6-codex');
    expect(codexOpts.permissionMode).toBe('default');
    expect(codexOpts.codex.approvalPolicy).toBe('untrusted');

    const remoteAgy: Thread = {
      ...manager.createThread('Remote Agy', '/srv/repo', undefined, 'antigravity'),
      remote: { daemonId: 'd1', ownership: 'client', remoteCwd: '/srv/repo', lastSeq: 0, ownerClientId: 'c1' },
    };
    const remoteOpts = buildRemote(remoteAgy);
    expect(remoteOpts.model).toBe('gemini-4-carbon-medium');
    expect(remoteOpts.permissionMode).toBe('bypassPermissions');
  });

  it('resolves PublicApi.threads.permissions against the thread harness permission override', async () => {
    const threads = new Map<string, Thread>([
      ['t-agy', { id: 't-agy', title: 'Agy', cwd: '/tmp', agentHarness: 'antigravity', messages: [], createdAt: 1, updatedAt: 1 }],
      ['t-claude', { id: 't-claude', title: 'Claude', cwd: '/tmp', agentHarness: 'claude', messages: [], createdAt: 1, updatedAt: 1 }],
    ]);
    const settings: PluginSettings = {
      ...DEFAULT_SETTINGS,
      permissionMode: 'acceptEdits',
      permissionModeByHarness: { antigravity: 'bypassPermissions' },
    };
    const service = createClaudeThreadsApiV1({
      hostVersion: '0.76.1',
      getThreads: () => [...threads.values()],
      getThread: (id) => threads.get(id),
      isRunning: () => false,
      hasPendingApproval: () => false,
      createThread: () => threads.get('t-claude')!,
      sendMessage: async () => {},
      interrupt: async () => {},
      openThread: async () => {},
      subscribe: () => () => {},
      listOrchestrators: () => [],
      resolveOrchestrator: async () => null,
      triggerHostEvent: () => {},
      getDefaultPermissionMode: (harness) => resolveDefaultPermissionMode(settings, harness),
    });
    service.start();
    const agySnap = await service.api.threads.permissions!('t-agy');
    const claudeSnap = await service.api.threads.permissions!('t-claude');
    expect(agySnap?.effectivePermissionMode).toBe('bypassPermissions');
    expect(agySnap?.overridden).toBe(false);
    expect(claudeSnap?.effectivePermissionMode).toBe('acceptEdits');
    service.stop();
  });

  it('describes scheduled execution using per-harness default models', () => {
    const item = {
      id: 's1',
      name: 'Watch',
      prompt: 'Check',
      schedule: { type: 'interval' as const, intervalSeconds: 600 },
      enabled: true,
      targetThreadId: 't-agy',
    };
    const models: Record<string, string | undefined> = {
      claude: 'sonnet',
      antigravity: 'gemini-4-carbon-medium',
    };
    const display = describeScheduledExecution(
      item,
      'claude',
      (h) => models[h],
      { agentHarness: 'antigravity' },
    );
    expect(display.summary).toBe('Existing thread · Antigravity · gemini-4-carbon-medium');
  });
});

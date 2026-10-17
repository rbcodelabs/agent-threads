/**
 * Data written while per-thread sandbox VMs existed must load without crashing,
 * drop the inert VM fields, and leave the threads usable on the host.
 */
import os from 'os';
import { describe, it, expect, vi } from 'vitest';
import type { ThreadSessionOptions } from '../../src/ThreadSession';
import { DEFAULT_SETTINGS, type Thread } from '../../src/types';
import { mergePersistedSettings } from '../../src/productIdentity';
import {
  LEGACY_SANDBOX_SETTING_KEYS,
  stripLegacySandboxSettings,
  stripLegacySandboxThreadFields,
} from '../../src/legacySandboxVm';

const started: ThreadSessionOptions[] = [];

vi.mock('../../src/ThreadSession', () => ({
  ThreadSession: class {
    get turnInFlight(): boolean { return false; }
    async start(options: ThreadSessionOptions): Promise<void> { started.push(options); }
    send(): void {}
    async interrupt(): Promise<void> {}
    async setModel(): Promise<void> {}
    async setPermissionMode(): Promise<void> {}
    async restart(): Promise<void> {}
    close(): void {}
    async getContextUsage(): Promise<null> { return null; }
  },
}));

const { ThreadManager } = await import('../../src/ThreadManager');

/** What a 0.6x data.json looked like with the sandbox feature configured. */
const LEGACY_DATA = {
  vaultFolder: 'Agent Threads',
  defaultModel: 'opus',
  vmImage: 'claude-threads-coding:1',
  vmDefaultNetwork: 'internal',
  harnessVmMode: 'always',
  harnessVmImage: 'claude-threads-harness:1',
  sandboxVmMemory: '8G',
  sandboxVmCpus: 8,
  containerAwsProfiles: 'prod\nstaging',
  sandboxSetupPromptDismissed: true,
};

describe('legacy sandbox VM settings', () => {
  it('survives the persisted-settings merge and is then stripped, keeping every unrelated setting', () => {
    const merged = mergePersistedSettings(DEFAULT_SETTINGS, LEGACY_DATA as never) as unknown as Record<string, unknown>;
    // The merge is a plain Object.assign, so the stale keys do arrive.
    expect(merged.harnessVmMode).toBe('always');

    expect(stripLegacySandboxSettings(merged)).toBe(true);
    for (const key of LEGACY_SANDBOX_SETTING_KEYS) expect(merged, key).not.toHaveProperty(key);
    expect(merged.vaultFolder).toBe('Agent Threads');
    expect(merged.defaultModel).toBe('opus');
    // JSON round trip (what the next save writes) no longer mentions the feature.
    expect(JSON.stringify(merged)).not.toMatch(/harnessVm|sandboxVm|vmImage|containerAws/);
  });

  it('is idempotent and reports whether it changed anything', () => {
    const settings: Record<string, unknown> = { ...LEGACY_DATA };
    expect(stripLegacySandboxSettings(settings)).toBe(true);
    expect(stripLegacySandboxSettings(settings)).toBe(false);
    expect(stripLegacySandboxSettings(undefined)).toBe(false);
    expect(stripLegacySandboxSettings(null)).toBe(false);
  });

  it('no longer defines the sandbox settings in the defaults', () => {
    for (const key of LEGACY_SANDBOX_SETTING_KEYS) expect(DEFAULT_SETTINGS, key).not.toHaveProperty(key);
  });
});

describe('legacy per-thread VM mode', () => {
  const legacyThread = (over: Partial<Thread> & { harnessVmMode?: string } = {}): Thread => ({
    id: 'legacy-1',
    title: 'Ran in a container',
    messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    cwd: os.tmpdir(),
    createdAt: 1,
    updatedAt: 2,
    status: 'waiting',
    agentHarness: 'claude',
    harnessVmMode: 'always',
    ...over,
  } as unknown as Thread);

  it('stripLegacySandboxThreadFields removes only the VM mode', () => {
    const t = legacyThread();
    expect(stripLegacySandboxThreadFields(t)).toBe(true);
    expect(t).not.toHaveProperty('harnessVmMode');
    expect(t.title).toBe('Ran in a container');
    expect(stripLegacySandboxThreadFields(t)).toBe(false);
  });

  it('loadThreads accepts such a thread (host and container modes) and drops the field', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    manager.loadThreads([legacyThread(), legacyThread({ id: 'legacy-2', harnessVmMode: 'never' } as never)]);
    for (const id of ['legacy-1', 'legacy-2']) {
      const loaded = manager.getThread(id)!;
      expect(loaded).toBeDefined();
      expect(loaded).not.toHaveProperty('harnessVmMode');
      expect(JSON.stringify(loaded)).not.toContain('harnessVmMode');
    }
  });

  it('a previously containerised thread just runs: the session starts with no VM routing input', async () => {
    started.length = 0;
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
    manager.loadThreads([legacyThread()]);
    await manager.sendMessage('legacy-1', 'carry on');
    expect(started).toHaveLength(1);
    expect(started[0].claude).not.toHaveProperty('vm');
    expect(started[0].claude).not.toHaveProperty('vmMcpServers');
    expect(started[0]).not.toHaveProperty('containerAuthToken');
    expect(manager.getThread('legacy-1')!.messages.some((m) => m.content === 'carry on')).toBe(true);
  });
});

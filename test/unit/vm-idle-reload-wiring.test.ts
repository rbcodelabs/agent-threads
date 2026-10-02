import { describe, expect, it, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';
import { SandboxVmManager, type VmCommandRunner } from '../../src/sandboxVm';

describe('VM idle-stop plugin reload ordering', () => {
  it('cancels before graceful shutdown finishes and blocks replacement settings/startup until the old stop settles', async () => {
    let releaseStop!: () => void;
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
    const run: VmCommandRunner = async args => {
      if (args[0] === 'stop') await stopGate;
      return { exitCode: args[0] === 'inspect' ? 1 : 0, stdout: '', stderr: '' };
    };
    const vm = new SandboxVmManager({ containerName: () => 'synthetic-reload-vm', run });
    await vm.ensureHarnessContainer({ image: 'synthetic', mountPath: '/tmp', network: 'default' });
    const stop = vm.stopHarnessForIdle();
    const cancel = vi.fn(() => vm.dispose());
    const gracefulShutdown = vi.fn(() => new Promise(() => {}));
    const oldPlugin = Object.assign(Object.create(ClaudeThreadsPlugin.prototype), {
      revokePublicApi: vi.fn(), manager: { stopVmIdleLifecycle: cancel,
        getRunningThreads: () => [{ title: 'Synthetic running thread' }], gracefulShutdown },
    }) as ClaudeThreadsPlugin;
    void oldPlugin.onunload();
    expect(cancel).toHaveBeenCalledOnce();
    expect(gracefulShutdown).toHaveBeenCalledOnce();

    const sentinel = new Error('stop after settings');
    const loadSettings = vi.fn(async () => { throw sentinel; });
    const replacement = Object.assign(Object.create(ClaudeThreadsPlugin.prototype), { loadSettings }) as ClaudeThreadsPlugin;
    const loading = replacement.onload().catch(error => error);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(loadSettings).not.toHaveBeenCalled();
    releaseStop(); await stop;
    expect(await loading).toBe(sentinel);
    expect(loadSettings).toHaveBeenCalledOnce();
  });
});

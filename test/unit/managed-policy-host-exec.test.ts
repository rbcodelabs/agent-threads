/**
 * host_exec under managed policy: the manifest drops it, the executor refuses a call that arrives anyway (stale
 * manifest, or a daemon that sends tool.call regardless), and allowAlways=false ignores standing approvals while the
 * per-call prompt stays.
 */
import { describe, expect, it, vi } from 'vitest';
import { HostToolExecutor, HostToolSlots } from '../../src/remote/hostToolExecutor';
import { RemoteHostTools } from '../../src/remote/hostTools';
import { HOST_EXEC_DISABLED_MESSAGE, hostExecState, type HostExecPolicyAccess } from '../../src/managedPolicy';
import { hostExecAlwaysAllowOffer } from '../../src/hostExecPrefix';
import type { HarnessDynamicTool } from '../../src/HarnessSession';
import { manifestFromSpecs } from '../../src/protocol';

const dyn = (name: string, requiresApproval = false): HarnessDynamicTool =>
  ({ name, description: 'd', inputSchema: { type: 'object' }, requiresApproval, invoke: vi.fn(async () => ({ success: true, text: `ran ${name}` })) });

function access(state: { enabled: boolean; allowAlways: boolean }): HostExecPolicyAccess & { set(s: { enabled: boolean; allowAlways: boolean }): void } {
  let current = state;
  return { initial: state, current: async () => current, set: (s) => { current = s; } };
}

describe('RemoteHostTools with hostExec policy', () => {
  const builtIn = [dyn('host_exec', true), dyn('vault_search')];
  const overrides = { exec: 'host', vault: 'host' } as const;

  it('offers host_exec when enabled', async () => {
    const tools = new RemoteHostTools({ builtIn, overrides, hostExecPolicy: access({ enabled: true, allowAlways: true }) });
    expect((await tools.manifest()).claude_threads.map((t) => t.name)).toEqual(['host_exec', 'vault_search']);
  });

  it('drops host_exec (and only it) from the manifest when disabled', async () => {
    const tools = new RemoteHostTools({ builtIn, overrides, hostExecPolicy: access({ enabled: false, allowAlways: false }) });
    expect((await tools.manifest()).claude_threads.map((t) => t.name)).toEqual(['vault_search']);
    expect(tools.summary.builtIn).toEqual(['vault_search']);
  });

  it('applies a policy change to the NEXT manifest of a live session', async () => {
    const policy = access({ enabled: true, allowAlways: true });
    const tools = new RemoteHostTools({ builtIn, overrides, hostExecPolicy: policy });
    expect((await tools.manifest()).claude_threads.map((t) => t.name)).toContain('host_exec');
    policy.set({ enabled: false, allowAlways: false });
    expect((await tools.manifest()).claude_threads.map((t) => t.name)).not.toContain('host_exec');
  });

  it('invoke refuses host_exec at the source even if the manifest offered it earlier', async () => {
    const exec = builtIn[0];
    const policy = access({ enabled: true, allowAlways: true });
    const tools = new RemoteHostTools({ builtIn, overrides, hostExecPolicy: policy });
    await tools.manifest();
    policy.set({ enabled: false, allowAlways: false });
    const out = await tools.invoke('claude_threads', 'host_exec', { command: 'rm -rf /' });
    expect(out).toEqual({ success: false, text: HOST_EXEC_DISABLED_MESSAGE });
    expect(exec.invoke).not.toHaveBeenCalled();
  });

  it('is unchanged without a policy', async () => {
    const tools = new RemoteHostTools({ builtIn, overrides });
    expect((await tools.manifest()).claude_threads.map((t) => t.name)).toContain('host_exec');
    expect((await tools.invoke('claude_threads', 'host_exec', {})).success).toBe(true);
  });
});

describe('HostToolExecutor gateCall', () => {
  const manifest = manifestFromSpecs([{ name: 'host_exec', description: 'd', inputSchema: { type: 'object' }, requiresApproval: true, server: 'claude_threads' }]);
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const call = (callId: string) => ({ callId, threadId: 't', server: 'claude_threads', tool: 'host_exec', input: { command: 'echo hi' } });

  function rig(over: Partial<ConstructorParameters<typeof HostToolExecutor>[0]> = {}) {
    const results: Array<{ callId: string; success: boolean; text: string }> = [];
    const invoke = vi.fn(async () => ({ success: true, text: 'executed' }));
    const requestPermission = vi.fn(async () => true);
    const isPreApproved = vi.fn(() => true);
    const ex = new HostToolExecutor({
      manifest: () => manifest, invoke, requestPermission, isPreApproved, slots: new HostToolSlots(),
      sendResult: async (callId, r) => { results.push({ callId, ...r }); }, ...over,
    });
    return { ex, results, invoke, requestPermission, isPreApproved };
  }

  it('a stale manifest cannot execute host_exec: no card, no invoke, a plain refusal', async () => {
    const { ex, results, invoke, requestPermission } = rig({ gateCall: async () => ({ ok: false, text: HOST_EXEC_DISABLED_MESSAGE }) });
    ex.handleCall(call('c1'));
    await tick();
    expect(invoke).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(results).toEqual([{ callId: 'c1', success: false, text: HOST_EXEC_DISABLED_MESSAGE }]);
  });

  it('a refused call is remembered: a reopen gets the same answer and still never runs', async () => {
    const { ex, results, invoke } = rig({ gateCall: async () => ({ ok: false, text: HOST_EXEC_DISABLED_MESSAGE }) });
    ex.handleCall(call('c1'));
    await tick();
    ex.handleCall(call('c1'), true);
    await tick();
    expect(invoke).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
  });

  it('allowAlways=false ignores a saved prefix: the per-call card is shown', async () => {
    const { ex, requestPermission, isPreApproved, invoke } = rig({ gateCall: async () => ({ ok: true, allowAlways: false }) });
    ex.handleCall(call('c1'));
    await tick();
    expect(isPreApproved).not.toHaveBeenCalled();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('allowAlways=false with the user denying the card still runs nothing', async () => {
    const { ex, invoke } = rig({ gateCall: async () => ({ ok: true, allowAlways: false }), requestPermission: async () => false });
    ex.handleCall(call('c1'));
    await tick();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('with allowAlways the saved prefix still skips the card', async () => {
    const { ex, requestPermission, invoke } = rig({ gateCall: async () => ({ ok: true, allowAlways: true }) });
    ex.handleCall(call('c1'));
    await tick();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe('hostExec policy is independent of the machine target and shapes the UI offer', () => {
  it('"Always allow `prefix`" is offered only while allowAlways', () => {
    const pending = { toolName: 'mcp__claude_threads__host_exec', detail: JSON.stringify({ command: 'git status', cwd: '/x', reason: 'r', timeoutSeconds: 5 }) };
    expect(hostExecAlwaysAllowOffer(pending)).not.toBeNull();
    expect(hostExecAlwaysAllowOffer(pending, true)).not.toBeNull();
    expect(hostExecAlwaysAllowOffer(pending, false)).toBeNull();
  });

  it('machine off leaves host_exec on; hostExec off leaves the machine on', () => {
    const machineOff = { machine: { enabled: false } };
    expect(hostExecState(machineOff).enabled).toBe(true);
    expect(hostExecState({ hostExec: { enabled: false } }).enabled).toBe(false);
  });
});

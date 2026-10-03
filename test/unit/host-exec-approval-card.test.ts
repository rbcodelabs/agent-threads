import { describe, expect, it, vi } from 'vitest';
import {
  createHostExecHandler,
  formatHostExecPermissionDetail,
  type HostExecHooks,
  type HostExecRequest,
} from '../../src/hostExec';
import { parsePermissionDetail } from '../../src/permissionDetail';
import { HOST_EXEC_PERMISSION_TOOL, canAlwaysAllow, isPermissionPreApproved } from '../../src/toolNameUtils';

const request: HostExecRequest = {
  command: 'pnpm test --run',
  cwd: '/Users/me/project',
  reason: 'Verify before opening a PR',
  timeoutSeconds: 120,
};

describe('host_exec permission card', () => {
  it('shows command as the headline and cwd, reason and timeout under Details', () => {
    const parsed = parsePermissionDetail(formatHostExecPermissionDetail(request));
    expect(parsed.summary).toBe('pnpm test --run');
    expect(parsed.fields).toEqual([
      { key: 'command', value: 'pnpm test --run' },
      { key: 'cwd', value: '/Users/me/project' },
      { key: 'reason', value: 'Verify before opening a PR' },
      { key: 'timeoutSeconds', value: '120' },
    ]);
  });

  it('offers no always option for host_exec but keeps it for other tools', () => {
    expect(canAlwaysAllow(HOST_EXEC_PERMISSION_TOOL)).toBe(false);
    expect(canAlwaysAllow('Bash')).toBe(true);
    expect(canAlwaysAllow('mcp__claude_threads__vault_search')).toBe(true);
  });

  it('ignores persisted alwaysAllowedTools for host_exec', () => {
    expect(isPermissionPreApproved('host_exec', ['host_exec', 'Bash'])).toBe(false);
    expect(isPermissionPreApproved('Bash', ['host_exec', 'Bash'])).toBe(true);
  });

  it('never treats host_exec as a trusted built-in', () => {
    expect(isPermissionPreApproved('host_exec', [])).toBe(false);
    expect(isPermissionPreApproved('mcp__claude_threads__host_exec', [])).toBe(false);
  });
});

describe('createHostExecHandler approval outcomes', () => {
  const hooks = (over: Partial<HostExecHooks> = {}) => ({
    isInteractive: () => true,
    requestApproval: vi.fn(async () => true),
    run: vi.fn(async () => ({
      exitCode: 0, signal: null, stdout: 'ok', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false,
    })),
    ...over,
  });
  const args = { command: 'ls', reason: 'look', cwd: process.cwd() };

  it('does not run the command when the card is denied', async () => {
    const h = hooks({ requestApproval: vi.fn(async () => false) });
    const result = await createHostExecHandler(h, () => undefined)(args);
    expect(result).toMatchObject({ success: false, status: 'denied' });
    expect(h.run).not.toHaveBeenCalled();
  });

  it('denies without prompting or running when the thread cannot prompt', async () => {
    const h = hooks({ isInteractive: () => false });
    const result = await createHostExecHandler(h, () => undefined)(args);
    expect(result).toMatchObject({ success: false, status: 'denied' });
    expect(h.requestApproval).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('denies when the approval card is unavailable', async () => {
    const h = hooks({ requestApproval: vi.fn(async () => { throw new Error('gone'); }) });
    const result = await createHostExecHandler(h, () => undefined)(args);
    expect(result).toMatchObject({ success: false, status: 'denied' });
    expect(h.run).not.toHaveBeenCalled();
  });
});

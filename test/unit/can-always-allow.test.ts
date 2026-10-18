import { describe, expect, it } from 'vitest';
import { canAlwaysAllow, isPermissionPreApproved, HOST_EXEC_PERMISSION_TOOL } from '../../src/toolNameUtils';

describe('per-call approvals are never remembered', () => {
  it('host_exec and sync_resolve_conflict cannot be Always Allowed, whatever the lists say', () => {
    expect(canAlwaysAllow(HOST_EXEC_PERMISSION_TOOL)).toBe(false);
    expect(canAlwaysAllow('mcp__claude_threads__sync_resolve_conflict')).toBe(false);
    expect(canAlwaysAllow('sync_resolve_conflict')).toBe(false);
    expect(isPermissionPreApproved('mcp__claude_threads__sync_resolve_conflict', ['mcp__claude_threads__sync_resolve_conflict'])).toBe(false);
    expect(isPermissionPreApproved(HOST_EXEC_PERMISSION_TOOL, [HOST_EXEC_PERMISSION_TOOL])).toBe(false);
  });

  it('other tools still can', () => {
    expect(canAlwaysAllow('Bash')).toBe(true);
    expect(canAlwaysAllow('mcp__claude_threads__vault_search')).toBe(true);
    expect(isPermissionPreApproved('Bash', ['Bash'])).toBe(true);
  });
});

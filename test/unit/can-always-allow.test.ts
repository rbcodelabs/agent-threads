import { describe, expect, it } from 'vitest';
import { canAlwaysAllow, isPermissionPreApproved, HOST_EXEC_PERMISSION_TOOL } from '../../src/toolNameUtils';

describe('per-call approvals are never remembered', () => {
  it('host_exec and sync_resolve_conflict cannot be Always Allowed, whatever the lists say', () => {
    expect(canAlwaysAllow(HOST_EXEC_PERMISSION_TOOL)).toBe(false);
    expect(canAlwaysAllow('mcp__claude_threads__sync_resolve_conflict')).toBe(false);
    expect(canAlwaysAllow('sync_resolve_conflict')).toBe(false);
    expect(canAlwaysAllow('Agent Threads: host_exec')).toBe(false);
    expect(canAlwaysAllow('Agent Threads: sync_resolve_conflict')).toBe(false);
    expect(canAlwaysAllow('Antigravity: mcp_agent-threads_sync_resolve_conflict')).toBe(false);
    expect(isPermissionPreApproved('mcp__claude_threads__sync_resolve_conflict', ['mcp__claude_threads__sync_resolve_conflict'])).toBe(false);
    expect(isPermissionPreApproved('Agent Threads: sync_resolve_conflict', ['mcp__claude_threads__sync_resolve_conflict', 'Agent Threads: sync_resolve_conflict'])).toBe(false);
    expect(isPermissionPreApproved(HOST_EXEC_PERMISSION_TOOL, [HOST_EXEC_PERMISSION_TOOL])).toBe(false);
  });

  it('other tools still can', () => {
    expect(canAlwaysAllow('Bash')).toBe(true);
    expect(canAlwaysAllow('mcp__claude_threads__vault_search')).toBe(true);
    expect(isPermissionPreApproved('Bash', ['Bash'])).toBe(true);
  });

  it('matches Always Allow entries across Claude, Antigravity, and Agent Threads MCP naming conventions', () => {
    // Claude MCP Always Allow -> Antigravity eager/lazy MCP permission requests
    expect(
      isPermissionPreApproved('Antigravity: mcp_compass_move_task_status', ['mcp__compass__move_task_status']),
    ).toBe(true);
    expect(
      isPermissionPreApproved('Antigravity: mcp_home-assistant_turn_on', ['mcp__home_assistant__turn_on']),
    ).toBe(true);
    expect(
      isPermissionPreApproved('Antigravity: mcp_compass_get_workspace_by_slug', ['mcp__claude_ai_Compass__get_workspace_by_slug']),
    ).toBe(true);

    // Antigravity MCP Always Allow -> Claude MCP permission requests
    expect(
      isPermissionPreApproved('mcp__compass__move_task_status', ['Antigravity: mcp_compass_move_task_status']),
    ).toBe(true);

    // Agent Threads host bridge <-> Claude claude_threads MCP Always Allow
    expect(
      isPermissionPreApproved('Agent Threads: enter_worktree', ['mcp__claude_threads__enter_worktree']),
    ).toBe(true);
    expect(
      isPermissionPreApproved('mcp__claude_threads__enter_worktree', ['Agent Threads: enter_worktree']),
    ).toBe(true);
    expect(
      isPermissionPreApproved('Agent Threads: vault_search', []),
    ).toBe(true);

    // Unrelated tools and non-MCP native harness prefixes remain distinct
    expect(
      isPermissionPreApproved('Antigravity: mcp_compass_delete_task', ['mcp__compass__move_task_status']),
    ).toBe(false);
    expect(
      isPermissionPreApproved('Antigravity: Bash', ['mcp__compass__move_task_status']),
    ).toBe(false);
  });
});

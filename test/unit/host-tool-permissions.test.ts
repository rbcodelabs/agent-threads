import { describe, expect, it } from 'vitest';
import { isTrustedBuiltInTool } from '../../src/toolNameUtils';

describe('built-in tool permission classification', () => {
  it('trusts canonical and legacy built-in tools by explicit capability', () => {
    expect(isTrustedBuiltInTool('mcp__claude_threads__vault_search')).toBe(true);
    expect(isTrustedBuiltInTool('mcp__claude_threads__vault_list')).toBe(true);
    expect(isTrustedBuiltInTool('mcp__obsidian__obsidian_search_vault')).toBe(true);
    expect(isTrustedBuiltInTool('threads_send_message')).toBe(true);
    expect(isTrustedBuiltInTool('threads_create')).toBe(true);
    expect(isTrustedBuiltInTool('threads_open')).toBe(true);
    expect(isTrustedBuiltInTool('mcp__obsidian__obsidian_open_thread')).toBe(true);
    expect(isTrustedBuiltInTool('threads_update_project')).toBe(true);
    expect(isTrustedBuiltInTool('mcp__obsidian__obsidian_update_project')).toBe(true);
    expect(isTrustedBuiltInTool('fork_conversation')).toBe(false);
  });

  it('does not trust arbitrary names based on an obsidian prefix', () => {
    expect(isTrustedBuiltInTool('obsidian_delete_everything')).toBe(false);
    expect(isTrustedBuiltInTool('mcp__evil__vault_search')).toBe(false);
  });
});

import { isPermissionPreApproved, canAlwaysAllow, buildPermissionDetail, requiresPerCallApproval } from '../../src/toolNameUtils';
import { parsePermissionDetail } from '../../src/permissionDetail';

describe('browser_eval per-call approval', () => {
  const evalNames = ['browser_eval', 'mcp__claude_threads__browser_eval'];

  it('is never pre-approved, even when persisted as Always Allow', () => {
    for (const n of evalNames) {
      expect(isPermissionPreApproved(n, [])).toBe(false);
      expect(isPermissionPreApproved(n, [n])).toBe(false);
      expect(canAlwaysAllow(n)).toBe(false);
      expect(requiresPerCallApproval(n)).toBe(true);
    }
  });

  it('leaves the other browser tools pre-approved and always-allowable', () => {
    for (const k of ['browser_navigate', 'browser_click', 'browser_type', 'browser_console', 'browser_network', 'browser_snapshot']) {
      expect(isPermissionPreApproved(`mcp__claude_threads__${k}`, [])).toBe(true);
      expect(canAlwaysAllow(`mcp__claude_threads__${k}`)).toBe(true);
    }
  });

  it('shows the full expression on the card, ignoring the SDK description', () => {
    const expression = 'document.title + ' + "'x'.repeat(5)" + ' // ' + 'y'.repeat(3000);
    const detail = buildPermissionDetail('mcp__claude_threads__browser_eval', { expression }, { description: 'Evaluate JS (1234 chars)' });
    const fields = parsePermissionDetail(detail).fields;
    expect(fields?.find((f) => f.key === 'expression')?.value).toBe(expression);
  });

  it('keeps the description-first behaviour for other tools', () => {
    expect(buildPermissionDetail('Bash', { command: 'ls' }, { description: 'List files' })).toBe('List files');
  });
});

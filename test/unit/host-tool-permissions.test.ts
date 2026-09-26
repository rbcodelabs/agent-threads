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

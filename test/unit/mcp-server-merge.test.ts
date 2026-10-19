import { describe, expect, it } from 'vitest';
import { mergeMcpServers, selectCanonicalHarnessTools } from '../../src/mcpServerMerge';

describe('built-in MCP server collision handling', () => {
  it('keeps reserved built-in servers when external settings reuse their names', () => {
    const builtIns = { claude_threads: { type: 'sdk', name: 'canonical' }, obsidian: { type: 'sdk', name: 'legacy' } };
    const external = {
      claude_threads: { type: 'stdio', command: 'wrong' },
      obsidian: { type: 'stdio', command: 'wrong' },
      github: { type: 'http', url: 'https://example.test' },
    };

    expect(mergeMcpServers(builtIns, external)).toEqual({ ...external, ...builtIns });
  });
});

describe('native harness tool selection', () => {
  it('selects only the canonical server adapter', () => {
    const canonicalTools = [{ name: 'vault_search' }];
    const legacyTools = [{ name: 'obsidian_search_vault' }];
    const servers = {
      claude_threads: { harnessTools: canonicalTools },
      obsidian: { harnessTools: legacyTools },
    };

    expect(selectCanonicalHarnessTools(servers)).toBe(canonicalTools);
  });
});

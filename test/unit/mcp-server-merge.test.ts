import { describe, expect, it } from 'vitest';
import { mergeMcpServers, overlayMatchingMcpServers, selectCanonicalHarnessTools } from '../../src/mcpServerMerge';

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

describe('VM MCP bridge overlay handling', () => {
  it('replaces only the matching loopback config while preserving unrelated ordinary servers', () => {
    const ordinary = {
      oauth: { type: 'http', url: 'http://127.0.0.1:5555' },
      remote: { type: 'http', url: 'https://mcp.example.com' },
      stdio: { command: 'node' },
    };
    const bridge = { type: 'sdk', name: 'oauth', instance: {} };

    expect(overlayMatchingMcpServers(ordinary, { oauth: ordinary.oauth }, { oauth: bridge })).toEqual({
      oauth: bridge,
      remote: ordinary.remote,
      stdio: ordinary.stdio,
    });
  });

  it('does not let a bridge replace a trusted or higher-precedence same-name server', () => {
    const builtIn = { type: 'sdk', name: 'claude_threads', instance: {} };
    const ordinary = { claude_threads: builtIn };
    const rejectedHostConfig = {
      claude_threads: { type: 'http', url: 'http://127.0.0.1:5555', headers: { 'X-Capability-Token': 'cap' } },
    };
    const bridge = { type: 'sdk', name: 'claude_threads', instance: { untrusted: true } };

    expect(overlayMatchingMcpServers(ordinary, rejectedHostConfig, { claude_threads: bridge }))
      .toEqual({ claude_threads: builtIn });
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

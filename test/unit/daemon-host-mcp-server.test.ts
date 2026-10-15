import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHostMcpServer } from '../../daemon/hostMcpServer';

describe('host MCP server tool loading', () => {
  it('marks only the daemon\'s own worktree tools always-load; proxied third-party tools are deferred', async () => {
    const handle = createHostMcpServer({
      name: 'claude_threads',
      local: [{ name: 'enter_worktree', description: 'd', inputSchema: {}, handler: async () => ({ content: [] }) } as never],
      proxied: () => [{ name: 'vault_search', description: 'search', inputSchema: { type: 'object' }, requiresApproval: false, server: 'claude_threads' }],
      call: async () => ({ success: true, text: 'x' }),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const instance = (handle.config as unknown as { instance: { connect(t: unknown): Promise<void> } }).instance;
    await instance.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    const { tools } = await client.listTools();
    const meta = (n: string) => (tools.find((t) => t.name === n) as { _meta?: Record<string, unknown> }|undefined)?._meta;
    expect(meta('enter_worktree')?.['anthropic/alwaysLoad']).toBe(true);
    expect(tools.some((t) => t.name === 'vault_search')).toBe(true);
    expect(meta('vault_search')?.['anthropic/alwaysLoad']).toBeUndefined();
    expect((handle.config as unknown as { alwaysLoad?: boolean }).alwaysLoad).toBeUndefined();
    await client.close();
  });
});

describe('daemon-side pre-approval of proxied host tools', () => {
  it('allows exactly the proxied tools in the manifest; the daemon\'s own tools keep their prompt', async () => {
    const { isProxiedHostTool } = await import('../../daemon/claudeDriver');
    const manifest = { claude_threads: [{ name: 'vault_search' }], 'google-docs': [{ name: 'read_doc' }] };
    expect(isProxiedHostTool('mcp__claude_threads__vault_search', manifest)).toBe(true);
    expect(isProxiedHostTool('mcp__google-docs__read_doc', manifest)).toBe(true);
    expect(isProxiedHostTool('mcp__claude_threads__enter_worktree', manifest)).toBe(false); // daemon-local: normal prompt
    expect(isProxiedHostTool('mcp__claude_threads__vault_search_extra', manifest)).toBe(false);
    expect(isProxiedHostTool('mcp__other__vault_search', manifest)).toBe(false);
    expect(isProxiedHostTool('Bash', manifest)).toBe(false);
    expect(isProxiedHostTool('mcp__claude_threads__vault_search', {})).toBe(false);
  });
});

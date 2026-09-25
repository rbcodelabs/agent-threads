import { describe, expect, it } from 'vitest';
import { resolveCodexPermissions, resolveDynamicToolApproval, serializableMcpServers } from '../../src/HarnessSession';

describe('resolveCodexPermissions', () => {
  it('keeps the default policy conservative', () => {
    expect(resolveCodexPermissions('default')).toEqual({ approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
  });

  it('enforces a read-only sandbox for plan mode', () => {
    expect(resolveCodexPermissions('plan')).toEqual({ approvalPolicy: 'on-request', sandbox: 'read-only' });
  });

  it.each(['bypassPermissions', 'dontAsk'] as const)('maps %s to non-interactive workspace writes', (mode) => {
    expect(resolveCodexPermissions(mode)).toEqual({ approvalPolicy: 'never', sandbox: 'workspace-write' });
  });
});

describe('resolveDynamicToolApproval', () => {
  it('allows read-only host tools without a prompt', () => {
    expect(resolveDynamicToolApproval('default', false)).toBe('allow');
  });

  it.each(['default', 'acceptEdits'] as const)('prompts for a mutation in %s mode', (mode) => {
    expect(resolveDynamicToolApproval(mode, true)).toBe('prompt');
  });

  it.each(['plan', 'dontAsk'] as const)('denies a mutation in %s mode', (mode) => {
    expect(resolveDynamicToolApproval(mode, true)).toBe('deny');
  });
});

describe('serializableMcpServers', () => {
  it('keeps process-transport servers and drops in-process SDK servers', () => {
    expect(serializableMcpServers({
      local: { type: 'stdio', command: 'node', args: ['server.js'], env: { A: '1' }, timeout: 5000, alwaysLoad: true } as never,
      bare: { command: 'uvx' } as never,
      remote: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer x' }, tools: [] } as never,
      events: { type: 'sse', url: 'https://example.test/sse' } as never,
      host: { type: 'sdk', name: 'obsidian', instance: {} } as never,
    })).toEqual({
      local: { type: 'stdio', command: 'node', args: ['server.js'], env: { A: '1' }, timeout: 5000 },
      bare: { command: 'uvx' },
      remote: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer x' } },
      events: { type: 'sse', url: 'https://example.test/sse' },
    });
  });

  it('drops malformed entries and tolerates undefined', () => {
    expect(serializableMcpServers(undefined)).toEqual({});
    expect(serializableMcpServers({ broken: { type: 'http' } })).toEqual({});
  });
});

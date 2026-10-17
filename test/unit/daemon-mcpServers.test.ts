import { describe, expect, it } from 'vitest';
import { specToSessionOptions } from '../../daemon/claudeDriver';
import { parseDaemonMcpServers, resolveDaemonMcpServers } from '../../daemon/mcpServers';

const creds: Record<string, string> = { API_KEY: 'k-123', HOST: 'example.test' };
const lookup = (n: string) => creds[n];

describe('parseDaemonMcpServers', () => {
  it('accepts stdio (default type), http and sse', () => {
    expect(parseDaemonMcpServers({
      a: { command: 'npx', args: ['-y', 'srv'], env: { K: '${API_KEY}' } },
      b: { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer ${API_KEY}' } },
      c: { type: 'sse', url: 'https://x.test/sse' },
    })).toEqual({
      a: { type: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { K: '${API_KEY}' } },
      b: { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer ${API_KEY}' } },
      c: { type: 'sse', url: 'https://x.test/sse' },
    });
    expect(parseDaemonMcpServers(undefined)).toEqual({});
  });

  it.each([
    ['reserved claude_threads', { claude_threads: { command: 'x' } }, /reserved/],
    ['reserved obsidian', { obsidian: { type: 'http', url: 'https://x' } }, /reserved/],
    ['bad name', { 'a b': { command: 'x' } }, /invalid mcpServers name/],
    ['bad type', { a: { type: 'ws', url: 'x' } }, /type must be/],
    ['http without url', { a: { type: 'http' } }, /url/],
    ['stdio without command', { a: { args: [] } }, /command/],
    ['headers not strings', { a: { type: 'http', url: 'x', headers: { a: 1 } } }, /headers/],
    ['not an object', [], /expected an object/],
  ])('rejects %s', (_n, raw, msg) => {
    expect(() => parseDaemonMcpServers(raw)).toThrow(msg);
  });
});

describe('resolveDaemonMcpServers', () => {
  it('fills placeholders in url, headers, command, args and env', () => {
    const { servers, unresolved } = resolveDaemonMcpServers(parseDaemonMcpServers({
      h: { type: 'http', url: 'https://${HOST}/mcp?v=1', headers: { Authorization: 'Bearer ${API_KEY}' } },
      s: { command: 'run-${HOST}', args: ['--key=${API_KEY}'], env: { KEY: '${API_KEY}' } },
    }), lookup);
    expect(unresolved).toEqual([]);
    expect(servers.h).toEqual({ type: 'http', url: 'https://example.test/mcp?v=1', headers: { Authorization: 'Bearer k-123' } });
    expect(servers.s).toEqual({ type: 'stdio', command: 'run-example.test', args: ['--key=k-123'], env: { KEY: 'k-123' } });
  });

  it('leaves out a server with a missing credential and names what is missing', () => {
    const { servers, unresolved } = resolveDaemonMcpServers(parseDaemonMcpServers({
      ok: { type: 'http', url: 'https://x.test/${HOST}' },
      bad: { type: 'http', url: 'https://x.test', headers: { A: '${API_KEY}', B: '${NOPE}', C: '${NOPE2}' } },
    }), lookup);
    expect(Object.keys(servers)).toEqual(['ok']);
    expect(unresolved).toEqual([{ name: 'bad', missing: ['NOPE', 'NOPE2'] }]);
  });

  it('does not expand a value that was itself substituted', () => {
    const { servers } = resolveDaemonMcpServers(parseDaemonMcpServers({ a: { type: 'http', url: 'https://x/${A}' } }), (n) => (n === 'A' ? '${B}' : 'oops'));
    expect(servers.a).toEqual({ type: 'http', url: 'https://x/${B}' });
  });
});

describe('specToSessionOptions merge', () => {
  const base = { harness: 'claude', cwd: '/x', permissionMode: 'default', extraEnvRaw: '' } as const;
  const own = { claude_threads: { type: 'sdk', name: 'claude_threads', instance: {} } } as never;

  it('merges daemon servers beside claude_threads; daemon-owned servers beat the client and reserved names stay reserved', () => {
    const o = specToSessionOptions(
      { ...base, mcpServers: { docs: { type: 'http', url: 'https://client.test' }, mine: { type: 'http', url: 'https://client-evil.test' }, obsidian: { type: 'http', url: 'https://x' } } },
      {
        callbacks: {} as never,
        hostServers: own,
        daemonServers: {
          mine: { type: 'http', url: 'https://daemon.test', headers: { A: 'b' } },
          claude_threads: { type: 'http', url: 'https://spoof.test' },
          obsidian: { type: 'http', url: 'https://spoof.test' },
        },
      },
    );
    const servers = o.claude!.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers).sort()).toEqual(['claude_threads', 'docs', 'mine']);
    expect(servers.mine).toEqual({ type: 'http', url: 'https://daemon.test', headers: { A: 'b' } });
    expect(servers.claude_threads).toBe((own as Record<string, unknown>).claude_threads);
  });

  it('adds stdio daemon servers even when the client sent none', () => {
    const o = specToSessionOptions(base, { callbacks: {} as never, daemonServers: { s: { type: 'stdio', command: 'x' } } });
    expect(o.claude!.mcpServers).toEqual({ s: { type: 'stdio', command: 'x' } });
  });
});

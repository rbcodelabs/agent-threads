import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionMetaStore } from '../../daemon/sessionMeta';
import { redactMcpServersForStorage, urlCarriesCredentials } from '../../src/protocol';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('session recipe on disk holds no credential', () => {
  it('leaves out header-bearing and credential-URL MCP servers, keeps the rest, and names what it left out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meta-'));
    dirs.push(dir);
    const store = new SessionMetaStore(dir);
    store.save({
      threadId: 't1', updatedAt: 1,
      spec: {
        harness: 'claude', cwd: '/srv/w', permissionMode: 'default', extraEnvRaw: '',
        mcpServers: {
          docs: { type: 'http', url: 'https://mcp.example.com/x' },
          authed: { type: 'http', url: 'https://a.example.com', headers: { Authorization: 'Bearer SECRET-VALUE' } },
          tokenUrl: { type: 'sse', url: 'https://b.example.com/s?token=SECRET-QUERY' },
        },
      },
    });
    const raw = readFileSync(join(dir, 'sessions', 't1.json'), 'utf8');
    expect(raw).not.toContain('SECRET-VALUE');
    expect(raw).not.toContain('SECRET-QUERY');
    const loaded = store.load('t1')!;
    expect(Object.keys(loaded.spec.mcpServers ?? {})).toEqual(['docs']);
    expect(loaded.omittedMcpServers?.sort()).toEqual(['authed', 'tokenUrl']);
  });

  it('classifies credential-bearing URLs', () => {
    expect(urlCarriesCredentials('https://u:p@x.example.com')).toBe(true);
    expect(urlCarriesCredentials('https://x.example.com/?access_token=abc')).toBe(true);
    expect(urlCarriesCredentials('https://x.example.com/?q=hello&page=3')).toBe(false);
    expect(urlCarriesCredentials('not a url')).toBe(false);
    expect(redactMcpServersForStorage(undefined)).toEqual({ kept: undefined, omitted: [] });
  });
});

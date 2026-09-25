/**
 * vault_list: a read-only, adapter-backed folder listing, so skills that must
 * not use Bash can still list vault folders (Claude Code 2.1.282 exposes no
 * Glob/Grep tool, so the model otherwise falls back to `ls`/`find`).
 */
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { listVault, normalizeVaultListPath, VaultListError, type VaultListAdapter } from '../../src/vaultList';

/** In-memory adapter: keys are vault-relative paths; folders end in '/'. */
function fakeAdapter(tree: Record<string, { size?: number; mtime?: number } | 'folder'>): VaultListAdapter & { listCalls: string[] } {
  const listCalls: string[] = [];
  const all = Object.keys(tree);
  const isFolder = (p: string) => p === '' || tree[p] === 'folder';
  const children = (dir: string) => all.filter((p) => {
    const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    return parent === dir;
  });
  const key = (p: string) => (p === '/' ? '' : p);
  return {
    listCalls,
    exists: async (p) => key(p) === '' || key(p) in tree,
    stat: async (p) => {
      const k = key(p);
      if (k === '') return { type: 'folder' };
      const entry = tree[k];
      if (!entry) return null;
      return entry === 'folder' ? { type: 'folder', mtime: 1 } : { type: 'file', size: entry.size ?? 0, mtime: entry.mtime ?? 0 };
    },
    list: async (p) => {
      const k = key(p);
      listCalls.push(k);
      if (!isFolder(k)) throw new Error(`not a folder: ${k}`);
      const kids = children(k);
      // Like FileSystemAdapter, return vault-relative paths (root may come back with a leading slash).
      const out = (xs: string[]) => xs.map((x) => (k === '' ? `/${x}` : x));
      return { files: out(kids.filter((c) => !isFolder(c))), folders: out(kids.filter((c) => isFolder(c))) };
    },
  };
}

const TREE = {
  '.obsidian': 'folder',
  '.obsidian/app.json': { size: 10, mtime: 5 },
  'Daily': 'folder',
  'Daily/2026-09-25.md': { size: 120, mtime: 1000 },
  'Daily/2026-09-24.md': { size: 80, mtime: 900 },
  'Projects': 'folder',
  'Projects/Chief of Staff': 'folder',
  'Projects/Chief of Staff/Spec.md': { size: 3000, mtime: 2000 },
  'Welcome.md': { size: 42, mtime: 10 },
  'image.png': { size: 999, mtime: 11 },
} as const;

describe('normalizeVaultListPath', () => {
  it('defaults to the vault root', () => {
    for (const input of [undefined, '', '.', './', '/']) expect(normalizeVaultListPath(input)).toBe('');
  });

  it('strips ./ and trailing slashes and collapses duplicate separators', () => {
    expect(normalizeVaultListPath('./Daily/')).toBe('Daily');
    expect(normalizeVaultListPath('Projects//Chief of Staff/')).toBe('Projects/Chief of Staff');
    expect(normalizeVaultListPath('Projects\\Chief of Staff')).toBe('Projects/Chief of Staff');
  });

  it('rejects absolute paths', () => {
    for (const input of ['/Users/rick/vault', '/etc', 'C:\\Users', 'c:/x', '\\\\server\\share', '~/notes']) {
      expect(() => normalizeVaultListPath(input)).toThrow(VaultListError);
    }
  });

  it('rejects .. escapes anywhere in the path', () => {
    for (const input of ['..', '../x', 'Daily/../..', 'a/../b', 'Daily/..']) {
      expect(() => normalizeVaultListPath(input)).toThrow(/inside the vault/);
    }
  });
});

describe('listVault', () => {
  it('lists the root non-recursively, sorted, skipping the config dir', async () => {
    const result = await listVault(fakeAdapter(TREE), { configDir: '.obsidian' });
    expect(result).toEqual({
      path: '',
      truncated: false,
      entries: [
        { path: 'Daily', type: 'folder', mtime: 1 },
        { path: 'Projects', type: 'folder', mtime: 1 },
        { path: 'Welcome.md', type: 'file', size: 42, mtime: 10 },
        { path: 'image.png', type: 'file', size: 999, mtime: 11 },
      ],
    });
  });

  it('lists a subfolder', async () => {
    const result = await listVault(fakeAdapter(TREE), { path: 'Daily', configDir: '.obsidian' });
    expect(result.entries.map((e) => e.path)).toEqual(['Daily/2026-09-24.md', 'Daily/2026-09-25.md']);
    expect(result.entries[1]).toEqual({ path: 'Daily/2026-09-25.md', type: 'file', size: 120, mtime: 1000 });
  });

  it('recurses when asked, still skipping the config dir', async () => {
    const result = await listVault(fakeAdapter(TREE), { recursive: true, configDir: '.obsidian' });
    expect(result.entries.map((e) => e.path)).toEqual([
      'Daily',
      'Daily/2026-09-24.md',
      'Daily/2026-09-25.md',
      'Projects',
      'Projects/Chief of Staff',
      'Projects/Chief of Staff/Spec.md',
      'Welcome.md',
      'image.png',
    ]);
    expect(result.truncated).toBe(false);
  });

  it('lists the config dir only when it is explicitly requested', async () => {
    const result = await listVault(fakeAdapter(TREE), { path: '.obsidian', configDir: '.obsidian' });
    expect(result.entries.map((e) => e.path)).toEqual(['.obsidian/app.json']);
  });

  it('honours limit and reports truncation, stopping the walk early', async () => {
    const adapter = fakeAdapter(TREE);
    const result = await listVault(adapter, { recursive: true, limit: 3, configDir: '.obsidian' });
    expect(result.entries).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.entries.map((e) => e.path)).toEqual(['Daily', 'Daily/2026-09-24.md', 'Daily/2026-09-25.md']);
    // It did not walk the whole tree to return three entries.
    expect(adapter.listCalls).not.toContain('Projects/Chief of Staff');
  });

  it('is not truncated when the limit exactly fits', async () => {
    const result = await listVault(fakeAdapter(TREE), { limit: 4, configDir: '.obsidian' });
    expect(result.entries).toHaveLength(4);
    expect(result.truncated).toBe(false);
  });

  it('defaults the limit to 500 and caps it at 2000', async () => {
    const big: Record<string, { size: number } | 'folder'> = {};
    for (let i = 0; i < 2100; i++) big[`n${String(i).padStart(4, '0')}.md`] = { size: 1 };
    const byDefault = await listVault(fakeAdapter(big), { configDir: '.obsidian' });
    expect(byDefault.entries).toHaveLength(500);
    expect(byDefault.truncated).toBe(true);
    const capped = await listVault(fakeAdapter(big), { limit: 5000, configDir: '.obsidian' });
    expect(capped.entries).toHaveLength(2000);
    expect(capped.truncated).toBe(true);
  });

  it('gives a clear error for a missing folder', async () => {
    await expect(listVault(fakeAdapter(TREE), { path: 'Nope', configDir: '.obsidian' }))
      .rejects.toThrow('Folder not found: Nope');
  });

  it('gives a clear error when the path is a file', async () => {
    await expect(listVault(fakeAdapter(TREE), { path: 'Welcome.md', configDir: '.obsidian' }))
      .rejects.toThrow('Not a folder: Welcome.md');
  });

  it('rejects escapes before touching the adapter', async () => {
    const adapter = fakeAdapter(TREE);
    await expect(listVault(adapter, { path: '../outside', configDir: '.obsidian' })).rejects.toThrow(VaultListError);
    expect(adapter.listCalls).toEqual([]);
  });
});

// ─── registration: name, trust tier, read-only on native harnesses ──────────

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

describe('vault_list registration', () => {
  it('is on the claude_threads server, trusted, and approval-free for Codex/OpenCode; the handler returns JSON', async () => {
    const { createClaudeThreadsMcpServers } = await import('../../src/ObsidianTools');
    const { isTrustedBuiltInTool } = await import('../../src/toolNameUtils');
    const adapter = fakeAdapter(TREE);
    const app = {
      plugins: { plugins: {} },
      workspace: { getLeavesOfType: () => [], onLayoutReady: (cb: () => void) => cb() },
      vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [], adapter, configDir: '.obsidian' },
      metadataCache: { on: () => {} },
    } as unknown as App;
    const servers = createClaudeThreadsMcpServers(app) as unknown as {
      claude_threads: { tools: Array<{ name: string; handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>; harnessTools: Array<{ name: string; requiresApproval: boolean }> };
    };
    const vaultList = servers.claude_threads.tools.find((t) => t.name === 'vault_list')!;
    expect(vaultList).toBeDefined();
    expect(isTrustedBuiltInTool('mcp__claude_threads__vault_list')).toBe(true);
    expect(servers.claude_threads.harnessTools.find((t) => t.name === 'vault_list')?.requiresApproval).toBe(false);

    const ok = await vaultList.handler({ path: 'Daily' }, {});
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(ok.content[0]!.text)).toMatchObject({ path: 'Daily', truncated: false, entries: [{ path: 'Daily/2026-09-24.md' }, { path: 'Daily/2026-09-25.md' }] });

    const bad = await vaultList.handler({ path: '../etc' }, {});
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/inside the vault/);
  });
});

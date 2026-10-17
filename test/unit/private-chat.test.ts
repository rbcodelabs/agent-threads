import { describe, it, expect } from 'vitest';
import { VaultPersistence } from '../../src/VaultPersistence';
import type { Thread } from '../../src/types';

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'private-1', title: 'Secret', cwd: '/x', messages: [],
    createdAt: 1, updatedAt: 2, status: 'waiting', ...overrides,
  };
}

describe('private chats', () => {
  it('VaultPersistence.saveThread writes nothing for a private thread', async () => {
    const contents: Record<string, string> = {};
    const app = {
      vault: {
        getAbstractFileByPath: () => null,
        createFolder: async () => { throw new Error('should not touch vault'); },
        create: async (p: string, c: string) => { contents[p] = c; },
        modify: async () => { throw new Error('should not touch vault'); },
        getMarkdownFiles: () => [],
      },
      metadataCache: { getFileCache: () => null },
    };
    const vp = new VaultPersistence(app as any, 'Claude');
    expect(await vp.saveThread(thread({ private: true }))).toBe('');
    expect(Object.keys(contents)).toEqual([]);
  });

  it('writes a normal thread (control)', async () => {
    const contents: Record<string, string> = {};
    const folders = new Set<string>();
    const { TFile } = await import('obsidian');
    const app = {
      vault: {
        getAbstractFileByPath: (p: string) => (p in contents ? new TFile(p) : folders.has(p) ? { path: p } : null),
        createFolder: async (p: string) => { folders.add(p); },
        create: async (p: string, c: string) => { contents[p] = c; return new TFile(p); },
        modify: async (f: { path: string }, c: string) => { contents[f.path] = c; },
        rename: async () => {},
        read: async (f: { path: string }) => contents[f.path],
        getMarkdownFiles: () => [],
      },
      metadataCache: { getFileCache: () => null },
    };
    const vp = new VaultPersistence(app as any, 'Claude');
    expect(await vp.saveThread(thread())).not.toBe('');
    expect(Object.keys(contents).length).toBeGreaterThan(0);
  });
});

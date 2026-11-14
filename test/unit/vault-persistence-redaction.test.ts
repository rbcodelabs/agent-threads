import { describe, it, expect, afterEach } from 'vitest';
import { VaultPersistence } from '../../src/VaultPersistence';
import { decodeThreadRecoverySnapshot } from '../../src/threadRecoverySnapshot';
import { setKnownSecretsProvider } from '../../src/secretRedaction';
import type { Thread } from '../../src/types';

const GH = 'ghp_' + 'c'.repeat(36);
const KNOWN = 'correct-horse-battery-staple';

function makeApp() {
  const created: Record<string, string> = {};
  return {
    app: {
      vault: {
        getAbstractFileByPath: () => null,
        createFolder: async () => {},
        create: async (path: string, content: string) => { created[path] = content; },
        modify: async () => {},
      },
      metadataCache: { getFileCache: () => null },
    },
    created,
  };
}

function leakyThread(): Thread {
  return {
    id: 't1',
    title: 'Leaky',
    cwd: '/tmp',
    messages: [
      { id: 'm1', role: 'user', content: `please read .env\n${GH}\nDB_PASSWORD="a b c" and ${KNOWN}`, timestamp: 1 },
      { id: 'm2', role: 'assistant', content: `done. ${GH}`, timestamp: 2, toolCalls: [{ name: 'Bash', summary: `curl -H "Authorization: Bearer ${GH}0000"` }] },
    ],
    createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
    updatedAt: Date.parse('2026-01-01T00:00:00.000Z'),
    status: 'archived',
  };
}

describe('archived thread notes are redacted on write', () => {
  afterEach(() => setKnownSecretsProvider(null));

  it('masks secrets in both the markdown note and the recovery sidecar, which still decodes', async () => {
    setKnownSecretsProvider(() => [KNOWN]);
    const { app, created } = makeApp();
    await new VaultPersistence(app as never, 'Claude').saveThread(leakyThread());

    const entries = Object.entries(created);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const [, content] of entries) {
      expect(content).not.toContain(GH);
      expect(content).not.toContain(KNOWN);
      expect(content).not.toContain('a b c');
      expect(content).toMatch(/\[REDACTED:[a-z-]+\]/);
    }
    const sidecar = entries.find(([path]) => !path.endsWith('.md'))![1];
    const decoded = decodeThreadRecoverySnapshot(sidecar);
    expect(decoded?.id).toBe('t1');
    expect(decoded?.messages).toHaveLength(2);
  });
});

import { describe, expect, it } from 'vitest';
import { buildEnvironmentSystemPrompt } from '../../src/ThreadManager';

describe('host-aware environment prompt', () => {
  for (const host of ['Geode', 'Obsidian'] as const) {
    it(`identifies ${host} and teaches only canonical tools`, () => {
      const prompt = buildEnvironmentSystemPrompt('/vault', '/work', 'Claude', true, host);
      expect(prompt).toContain(`inside the ${host} Agent Threads plugin`);
      expect(prompt).toContain('Vault root (filesystem path): /vault');
      expect(prompt).toContain('Working directory: /work');
      expect(prompt).not.toContain('Vault root (filesystem path): /work');
      expect(prompt).toContain('vault_search');
      expect(prompt).toContain('host_list_commands');
      expect(prompt).not.toContain('obsidian_search_vault');
      expect(prompt).not.toContain('obsidian_list_commands');
      if (host === 'Geode') expect(prompt).not.toContain('inside the Obsidian');
    });
  }
});

import './obsidian-mock'; // sets up HTMLElement.prototype
import { SkillsManagerView } from '../../src/SkillsManagerView';
import { DEFAULT_SETTINGS } from '../../src/types';
import { computeSkillRoots, setSkillRoots } from '../../src/skillPaths';
import { VAULT_SKILLS_DIR, seedAuthoredSkill } from './mocks/fs';
import { mockLeaf, mockApp } from './obsidian-mock';

// Mirrors what main.ts does on load. Without this the view resolves no vault
// root, every skill renders read-only, and the Vault group never appears.
const MANIFEST_DIR = '.obsidian/plugins/claude-threads';
setSkillRoots({ ...computeSkillRoots('/Users/mock/vault', MANIFEST_DIR, '/Users/mock'), localRoot: '/Users/mock/vault/Skills' });

const mockPlugin = {
  app: mockApp,
  settings: { ...DEFAULT_SETTINGS },
  manifest: { dir: MANIFEST_DIR },
  saveSettings: async () => {},
  getPluginSkillsRoot: () => VAULT_SKILLS_DIR,
  getLocalSkillsRoot: () => '/Users/mock/vault/Skills',
  // renderTabActions calls this unguarded; non-null enables the Import menu's GitHub-clone entry.
  getSkillSourceCloneBase: () => `/Users/mock/vault/${MANIFEST_DIR}/skill-sources`,
  createLocalSkill: async (params: { skillId: string; skillMd: string }) => {
    seedAuthoredSkill(params.skillId, params.skillMd);
    return { skillId: params.skillId, path: `/Users/mock/vault/Skills/${params.skillId}`, availability: 'next-session' };
  },
  updateLocalSkill: async (params: { skillId: string; files: Array<{ content: string }> }) => {
    seedAuthoredSkill(params.skillId, params.files[0].content);
    return { availability: 'next-session' };
  },
};

const view = new SkillsManagerView(mockLeaf as any, mockPlugin as any);
const container = document.getElementById('app')!;
container.appendChild(view.containerEl);
view.onOpen();

// Expose for Playwright
(window as any).__skillsView = view;

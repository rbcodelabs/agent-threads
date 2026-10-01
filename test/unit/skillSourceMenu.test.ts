import { describe, it, expect } from 'vitest';
import {
  getImportMenuState,
  describeSkillSourceCount,
  NO_INSTALL_ROOT_MESSAGE,
  NO_CLONE_BASE_MESSAGE,
} from '../../src/skillSourceMenu';

const byId = (s: ReturnType<typeof getImportMenuState>, id: string) => s.items.find((i) => i.id === id)!;

describe('getImportMenuState', () => {
  it('enables everything when both roots resolve', () => {
    const s = getImportMenuState({ canInstall: true, canClone: true });
    expect(s.enabled).toBe(true);
    expect(s.items.map((i) => i.id)).toEqual(['import-folder', 'import-file', 'add-github-source', 'add-local-source']);
    expect(s.items.every((i) => i.enabled && !i.disabledReason)).toBe(true);
  });

  it('keeps the button enabled with source-adding only, disabling imports with a reason', () => {
    const s = getImportMenuState({ canInstall: false, canClone: true });
    expect(s.enabled).toBe(true);
    expect(byId(s, 'import-folder')).toMatchObject({ enabled: false, disabledReason: NO_INSTALL_ROOT_MESSAGE });
    expect(byId(s, 'import-file').enabled).toBe(false);
    expect(byId(s, 'add-github-source').enabled).toBe(true);
  });

  it('keeps the button enabled with import only, disabling GitHub with a reason', () => {
    const s = getImportMenuState({ canInstall: true, canClone: false });
    expect(s.enabled).toBe(true);
    expect(byId(s, 'add-github-source')).toMatchObject({ enabled: false, disabledReason: NO_CLONE_BASE_MESSAGE });
    expect(byId(s, 'import-folder').enabled).toBe(true);
  });

  it('still offers the local-folder source when neither root resolves', () => {
    const s = getImportMenuState({ canInstall: false, canClone: false });
    expect(byId(s, 'add-local-source').enabled).toBe(true);
    expect(s.enabled).toBe(true);
  });
});

describe('describeSkillSourceCount', () => {
  it('handles zero, one and many', () => {
    expect(describeSkillSourceCount(0)).toBe('No skill sources configured.');
    expect(describeSkillSourceCount(1)).toBe('1 skill source configured.');
    expect(describeSkillSourceCount(3)).toBe('3 skill sources configured.');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { ArtifactProviderRegistry, toArtifactRef } from '../../src/ArtifactContributions';
import { createLegacyDesignArtifactContribution } from '../../src/legacyDesignArtifactProvider';

const ref = toArtifactRef({
  id: 'design-t1', kind: 'design-static', title: 'Saved design', createdAt: 1, updatedAt: 1,
  root: '/vault/.geode/artifacts/design-t1', manifestPath: '/vault/.geode/artifacts/design-t1/artifact.json',
  entryPath: '/vault/.geode/artifacts/design-t1/index.html',
});

describe('legacy design artifact fallback', () => {
  it('offers only source reveal and does not claim provider ownership', async () => {
    const registry = new ArtifactProviderRegistry({ fallbacks: [createLegacyDesignArtifactContribution()] });
    const presentation = registry.present(ref);
    expect(presentation).toMatchObject({ status: 'ok', presentation: { subtitle: expect.stringContaining('not installed') } });
    if (presentation.status === 'ok') expect(presentation.presentation.actions.map(action => action.id)).toEqual(['reveal']);
    expect(registry.ownerOf('agent-threads.design')).toBeUndefined();

    const revealInFolder = vi.fn(async () => true);
    await expect(registry.invoke('reveal', ref, {
      openView: async () => 'unavailable', revealInFolder, updateArtifact: async () => {},
    })).resolves.toEqual({ status: 'ok' });
    expect(revealInFolder).toHaveBeenCalledWith('/vault/.geode/artifacts/design-t1/artifact.json');
  });
});

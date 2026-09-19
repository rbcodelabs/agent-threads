/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { ThreadsView } from '../../src/ThreadsView';
import { toArtifactRef } from '../../src/ArtifactContributions';
import { previewDesignArtifact } from '../../src/designArtifactProvider';
import type { DesignArtifact } from '../../src/types';

const artifact = {
  id: 'design-t', kind: 'design-static', title: 'Concept',
  root: '/artifact', manifestPath: '/artifact/artifact.json', entryPath: '/artifact/index.html',
  createdAt: 1, updatedAt: 1,
} as DesignArtifact;

function setup(type = 'geode-artifact', contextual = false) {
  const view = Object.create(ThreadsView.prototype);
  const leaf = { setViewState: vi.fn(async () => {}), getViewState: () => ({ type }) };
  view.app = { workspace: { getLeavesOfType: () => [], getLeaf: () => leaf, revealLeaf: vi.fn() } };
  view.plugin = { isConversationFirst: () => contextual, contextPanel: { setViewState: leaf.setViewState, getLeaf: () => leaf } };
  const threadsView = view as ThreadsView;
  return { view: threadsView, leaf, host: threadsView.artifactActionHost('thread-1', toArtifactRef(artifact)) };
}

describe('design preview outcomes', () => {
  for (const contextual of [false, true]) {
    it(`reports a loaded preview (contextual=${contextual})`, async () => {
      const { leaf, host } = setup('geode-artifact', contextual);
      expect(await previewDesignArtifact(artifact, host)).toEqual({ status: 'opened' });
      expect(leaf.setViewState).toHaveBeenCalledWith({ type: 'geode-artifact', active: true, state: { root: '/artifact' } });
    });
    it(`does not claim success when an unsupported host silently substitutes another view (contextual=${contextual})`, async () => {
      const { host } = setup('empty', contextual);
      expect((await previewDesignArtifact(artifact, host)).status).not.toBe('opened');
    });
  }

  it('reports where the host actually placed the view', async () => {
    expect(await setup('geode-artifact', true).view.openArtifactView({ type: 'geode-artifact', state: { root: '/artifact' } }))
      .toBe('context-panel');
    expect(await setup('geode-artifact', false).view.openArtifactView({ type: 'geode-artifact', state: { root: '/artifact' } }))
      .toBe('tab');
    expect(await setup('empty', false).view.openArtifactView({ type: 'geode-artifact', state: { root: '/artifact' } }))
      .toBe('unavailable');
  });
});

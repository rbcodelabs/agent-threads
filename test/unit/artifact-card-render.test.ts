/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { describe, expect, it, vi } from 'vitest';
import { ThreadsView } from '../../src/ThreadsView';
import { ArtifactProviderRegistry, type ArtifactContribution } from '../../src/ArtifactContributions';
import { createDesignArtifactContribution, DESIGN_PROVIDER_OWNER } from '../../src/designArtifactProvider';
import type { ThreadArtifactRecord } from '../../src/types';

const legacyDesignArtifact: ThreadArtifactRecord = {
  id: 'design-thread-1',
  kind: 'design-static',
  title: 'Responsive checkout concept',
  createdAt: 1,
  updatedAt: 1,
  // Provider-owned fields, opaque to the host.
  ...{ root: '/vault/.geode/artifacts/design-thread-1', manifestPath: '/vault/.geode/artifacts/design-thread-1/artifact.json', entryPath: '/vault/.geode/artifacts/design-thread-1/index.html' },
};

function mountCard(artifacts: ThreadArtifactRecord[], registry: ArtifactProviderRegistry) {
  const view = Object.create(ThreadsView.prototype);
  const card = document.createElement('div');
  document.body.replaceChildren(card);
  Object.assign(view, {
    artifactCardEl: card,
    activeThreadId: 'thread-1',
    manager: { getThread: (id: string) => (id === 'thread-1' ? { id, artifacts } : undefined) },
    plugin: { artifactProviders: registry, saveSettings: vi.fn(async () => {}) },
  });
  (view as ThreadsView).refreshArtifactCard();
  return { view: view as ThreadsView, card };
}

function labels(card: HTMLElement): string[] {
  return [...card.querySelectorAll('.ct-artifact-action')].map(el => el.getAttribute('aria-label') ?? '');
}

describe('generic artifact card', () => {
  it('renders the built-in design provider through the public contract', () => {
    const registry = new ArtifactProviderRegistry();
    registry.register(DESIGN_PROVIDER_OWNER, createDesignArtifactContribution());
    const { card } = mountCard([legacyDesignArtifact], registry);

    expect(card.hasClass('ct-hidden')).toBe(false);
    expect(card.querySelector('.ct-artifact-card-title')?.textContent).toBe('Responsive checkout concept');
    expect(card.querySelector('.ct-artifact-card-meta')?.textContent).toBe('Static design artifact');
    expect(labels(card)).toEqual(['Preview design', 'Capture design screenshot', 'Reveal design source']);
    expect(card.querySelectorAll('.ct-artifact-action-secondary')).toHaveLength(2);
    expect(card.querySelector('.ct-artifact-action-primary .ct-artifact-action-label')?.textContent).toBe('Preview');
  });

  it('keeps prior work visible when no plugin provides the artifact', () => {
    const { card } = mountCard([legacyDesignArtifact], new ArtifactProviderRegistry());
    expect(card.hasClass('ct-hidden')).toBe(false);
    expect(card.querySelector('.ct-artifact-card-title')?.textContent).toBe('Responsive checkout concept');
    expect(card.querySelector('.ct-artifact-card-meta')?.textContent).toContain('agent-threads.design');
    expect(labels(card)).toEqual([]);
  });

  it('degrades to the placeholder when a provider throws while describing itself', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = new ArtifactProviderRegistry();
    registry.register(DESIGN_PROVIDER_OWNER, {
      providerId: 'agent-threads.design', kinds: ['design-static'],
      present: () => { throw new Error('provider bug'); },
      invoke: async () => ({ status: 'ok' }),
    } as ArtifactContribution);

    expect(() => mountCard([legacyDesignArtifact], registry)).not.toThrow();
    const card = document.body.firstElementChild as HTMLElement;
    expect(card.querySelector('.ct-artifact-card-title')?.textContent).toBe('Responsive checkout concept');
    expect(labels(card)).toEqual([]);
    spy.mockRestore();
  });

  it('surfaces a failing action without breaking the card', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = new ArtifactProviderRegistry({ invokeTimeoutMs: 10 });
    registry.register(DESIGN_PROVIDER_OWNER, {
      providerId: 'agent-threads.design', kinds: ['design-static'],
      present: ref => ({ title: ref.title, actions: [{ id: 'boom', label: 'Boom', variant: 'secondary' }] }),
      invoke: async () => { throw new Error('action exploded'); },
    } as ArtifactContribution);
    const { card } = mountCard([legacyDesignArtifact], registry);

    (card.querySelector('.ct-artifact-action') as HTMLElement).click();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(labels(document.body.firstElementChild as HTMLElement)).toEqual(['Boom']);
    spy.mockRestore();
  });

  it('hides the card when the thread has no artifacts', () => {
    const { card } = mountCard([], new ArtifactProviderRegistry());
    expect(card.hasClass('ct-hidden')).toBe(true);
  });

  it('writes provider data back through the scoped host only', async () => {
    const registry = new ArtifactProviderRegistry();
    registry.register(DESIGN_PROVIDER_OWNER, createDesignArtifactContribution());
    const artifacts = [{ ...legacyDesignArtifact }];
    const { view } = mountCard(artifacts, registry);
    const host = view.artifactActionHost('thread-1', { providerId: 'agent-threads.design', kind: 'design-static', schemaVersion: 1, id: 'design-thread-1', title: 'x', data: {} });

    await host.updateArtifact({ data: { id: 'hijacked', kind: 'evil', providerId: 'evil.plugin', lastCapturePath: '/shots/a.png' } });
    expect(artifacts[0]).toMatchObject({ id: 'design-thread-1', kind: 'design-static', lastCapturePath: '/shots/a.png' });
    expect(artifacts[0].providerId).toBeUndefined();
  });
});

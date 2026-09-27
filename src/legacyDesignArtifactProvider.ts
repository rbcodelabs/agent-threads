import type { ArtifactContribution, ThreadArtifactRef } from './ArtifactContributions';

const PROVIDER_ID = 'agent-threads.design';
const KIND = 'design-static';
const REVEAL = 'reveal';

function manifestPath(ref: ThreadArtifactRef): string | undefined {
  const data = ref.data as { manifestPath?: unknown };
  return typeof data?.manifestPath === 'string' ? data.manifestPath : undefined;
}

/** Read-only fallback for artifacts created before Design became a peer plugin. */
export function createLegacyDesignArtifactContribution(): ArtifactContribution {
  return {
    providerId: PROVIDER_ID,
    kinds: [KIND],
    present: ref => ({
      title: ref.title,
      subtitle: 'Design plugin not installed · source remains available',
      icon: 'panels-top-left',
      actions: [{ id: REVEAL, label: 'Reveal design source', variant: 'secondary', icon: 'folder-open' }],
    }),
    invoke: async (actionId, ref, host) => {
      if (actionId !== REVEAL) return { status: 'error', message: 'Install Design for Agent Threads to preview or capture this artifact.' };
      const path = manifestPath(ref);
      if (!path) return { status: 'error', message: 'This legacy design artifact has no source path.' };
      return await host.revealInFolder(path)
        ? { status: 'ok' }
        : { status: 'error', message: 'Could not reveal the design source.' };
    },
  };
}

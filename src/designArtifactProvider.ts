/**
 * Built-in Design artifact provider.
 *
 * This is the reference consumer for ADR-0008's contribution API: it registers
 * through `api.v1.extensions.registerArtifactProvider` with a real peer
 * identity, and reaches the host only through `ArtifactActionHost`. The one
 * thing it touches directly is `window.geode`, which is an ambient host-app
 * global available to any plugin — not a privileged Agent Threads path.
 */

import type {
  ArtifactActionHost,
  ArtifactActionResult,
  ArtifactContribution,
  ArtifactPresentation,
  ThreadArtifactRef,
} from './ArtifactContributions';
import type { DesignArtifact } from './types';

export const DESIGN_PROVIDER_ID = 'agent-threads.design';
export const DESIGN_ARTIFACT_KIND = 'design-static';

/** The plugin's own identity when it registers built-in capabilities. */
export const DESIGN_PROVIDER_OWNER = Object.freeze({
  pluginId: 'claude-threads',
  displayName: 'Agent Threads Design',
});

export const DESIGN_ACTION_PREVIEW = 'preview';
export const DESIGN_ACTION_CAPTURE = 'capture';
export const DESIGN_ACTION_REVEAL = 'reveal';

/** Mirrors the legacy `DesignPreviewResult` the design-mode entry reports. */
export type DesignPreviewOutcome =
  | { status: 'opened' }
  | { status: 'source-revealed' | 'unavailable'; warning: string };

interface GeodeCaptureHost {
  captureArtifact?: (root: string) => Promise<{ path: string; width: number; height: number }>;
}

function geodeHost(): GeodeCaptureHost | undefined {
  return (globalThis as unknown as { geode?: GeodeCaptureHost }).geode;
}

/** Narrows the opaque ref payload back to this provider's own schema. */
function designData(ref: ThreadArtifactRef): DesignArtifact {
  return ref.data as DesignArtifact;
}

export function presentDesignArtifact(ref: ThreadArtifactRef): ArtifactPresentation {
  return {
    title: ref.title,
    subtitle: 'Static design artifact',
    icon: 'panels-top-left',
    actions: [
      { id: DESIGN_ACTION_PREVIEW, label: 'Preview design', variant: 'primary', icon: 'play', shortLabel: 'Preview' },
      { id: DESIGN_ACTION_CAPTURE, label: 'Capture design screenshot', variant: 'secondary', icon: 'camera' },
      { id: DESIGN_ACTION_REVEAL, label: 'Reveal design source', variant: 'secondary', icon: 'folder-open' },
    ],
  };
}

/**
 * Opens the secure artifact view, falling back to revealing the source when
 * the host cannot place it. Exported because design-mode entry (`/design`,
 * `EnterDesignMode`) needs the same outcome shape immediately after creating
 * an artifact, before any card action has been clicked.
 */
export async function previewDesignArtifact(
  artifact: Pick<DesignArtifact, 'root' | 'manifestPath'>,
  host: ArtifactActionHost,
): Promise<DesignPreviewOutcome> {
  const placement = await host.openView({ type: 'geode-artifact', state: { root: artifact.root } });
  if (placement !== 'unavailable') return { status: 'opened' };
  const revealed = await host.revealInFolder(artifact.manifestPath);
  if (revealed) {
    return { status: 'source-revealed', warning: 'Secure artifact preview requires Geode; revealed the source instead.' };
  }
  return { status: 'unavailable', warning: 'Could not open artifact preview or reveal source.' };
}

async function captureDesignArtifact(ref: ThreadArtifactRef, host: ArtifactActionHost): Promise<ArtifactActionResult> {
  const artifact = designData(ref);
  const capture = geodeHost()?.captureArtifact;
  if (!capture) {
    return { status: 'warning', message: 'Artifact capture requires Geode with ArtifactView support.' };
  }
  let captured: { path: string; width: number; height: number };
  try {
    captured = await capture(artifact.root);
  } catch (error) {
    return { status: 'error', message: `Artifact capture failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  await host.updateArtifact({
    data: { ...artifact, lastCapturePath: captured.path, updatedAt: Date.now() },
  });
  return { status: 'ok', message: `Captured ${captured.width}×${captured.height} artifact screenshot.` };
}

export function createDesignArtifactContribution(): ArtifactContribution {
  return {
    providerId: DESIGN_PROVIDER_ID,
    kinds: [DESIGN_ARTIFACT_KIND],
    present: presentDesignArtifact,
    invoke: async (actionId, ref, host) => {
      if (actionId === DESIGN_ACTION_PREVIEW) {
        const preview = await previewDesignArtifact(designData(ref), host);
        return preview.status === 'opened' ? { status: 'ok' } : { status: 'warning', message: preview.warning };
      }
      if (actionId === DESIGN_ACTION_CAPTURE) return captureDesignArtifact(ref, host);
      if (actionId === DESIGN_ACTION_REVEAL) {
        const revealed = await host.revealInFolder(designData(ref).manifestPath);
        return revealed ? { status: 'ok' } : { status: 'error', message: 'Could not reveal the design source.' };
      }
      return { status: 'error', message: `Unknown design artifact action: ${actionId}` };
    },
  };
}

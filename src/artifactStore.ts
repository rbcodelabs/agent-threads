/**
 * Host-owned artifact persistence behind public API v1's `artifacts` namespace
 * (ADR-0008, ADR-0010).
 *
 * The store owns identity, attachment and storage validation. It does not own
 * action execution: `invokeAction` forwards to the view's card-click path so
 * that a peer calling `artifacts.invokeAction` and a user clicking the button
 * run the same code, with the same provider isolation and timeout. When no
 * view is mounted there is nowhere to place a preview, which surfaces as an
 * error result rather than a throw.
 */

import type { ArtifactActionResult, ArtifactStoreHost } from './ArtifactContributions';
import type { ThreadArtifactRecord } from './types';
import { allocateStorageRoot, removeStorageRoot, resolveStorageRoot, type ArtifactStorageFs, type StorageRootResolution } from './artifactStorage';

export interface ArtifactStoreDeps {
  /** Absolute vault path, or '' where the host has no local filesystem. */
  vaultRoot(): string;
  getThread(threadId: string): { artifacts?: ThreadArtifactRecord[] } | undefined;
  saveSettings(): Promise<void>;
  /**
   * The card-click execution path, or `undefined` when no view is mounted.
   */
  invokeAction?(threadId: string, artifactId: string, actionId: string): Promise<ArtifactActionResult> | undefined;
  /** Called after the artifact set for a thread changes, so the card re-renders. */
  onChanged?(threadId: string): void;
  /** Injectable for tests; defaults to the real filesystem. */
  storageFs?: ArtifactStorageFs;
}

export const NO_VIEW_MESSAGE = 'The Agent Threads view is not open, so artifact actions cannot run.';

export function createArtifactStore(deps: ArtifactStoreDeps): ArtifactStoreHost {
  const records = (threadId: string): ThreadArtifactRecord[] | null => {
    const thread = deps.getThread(threadId);
    if (!thread) return null;
    if (!thread.artifacts) thread.artifacts = [];
    return thread.artifacts;
  };

  return {
    list(threadId: string): readonly ThreadArtifactRecord[] | null {
      const current = records(threadId);
      return current ? [...current] : null;
    },

    resolveStorageRoot(candidate: unknown): StorageRootResolution {
      return resolveStorageRoot(deps.vaultRoot(), candidate, deps.storageFs);
    },

    allocateStorageRoot(artifactId: unknown): Promise<StorageRootResolution & { existed?: boolean }> {
      return allocateStorageRoot(deps.vaultRoot(), artifactId, deps.storageFs);
    },

    releaseStorageRoot(candidate: unknown): Promise<boolean> {
      return removeStorageRoot(deps.vaultRoot(), candidate, deps.storageFs);
    },

    async put(threadId: string, record: ThreadArtifactRecord) {
      const current = records(threadId);
      if (!current) return 'thread-not-found' as const;
      const index = current.findIndex(candidate => candidate.id === record.id);
      if (index < 0) {
        current.push(record);
        await deps.saveSettings();
        deps.onChanged?.(threadId);
        return 'attached' as const;
      }
      // Idempotent on artifact id: re-attaching the same artifact updates it in
      // place. Re-entering design mode on a thread must not produce a second
      // card, and a peer retrying an attach must not duplicate either.
      current[index] = { ...current[index], ...record, createdAt: current[index].createdAt };
      await deps.saveSettings();
      deps.onChanged?.(threadId);
      return 'updated' as const;
    },

    async detach(threadId: string, artifactId: string) {
      const current = records(threadId);
      if (!current) return 'thread-not-found' as const;
      const index = current.findIndex(candidate => candidate.id === artifactId);
      if (index < 0) return 'artifact-not-found' as const;
      current.splice(index, 1);
      await deps.saveSettings();
      deps.onChanged?.(threadId);
      // Storage is intentionally left alone: detaching a card is not deleting
      // a user's work. Storage is collected when the thread itself is deleted.
      return 'detached' as const;
    },

    async invokeAction(threadId: string, artifactId: string, actionId: string): Promise<ArtifactActionResult> {
      const dispatched = deps.invokeAction?.(threadId, artifactId, actionId);
      if (!dispatched) return { status: 'error', message: NO_VIEW_MESSAGE };
      return dispatched;
    },
  };
}

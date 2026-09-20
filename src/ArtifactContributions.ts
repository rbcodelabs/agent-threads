/**
 * Declarative artifact-provider contract (ADR-0008, ADR-0010).
 *
 * A provider describes an artifact and never receives a view instance, a
 * workspace leaf, or a DOM node. It returns a presentation — title, subtitle
 * and named actions — and the host renders it. When an action fires, the host
 * lends the provider a bounded `ArtifactActionHost` for the duration of that
 * one call; everything the provider cannot reach on its own (panel placement,
 * shell reveal, vault persistence) is brokered through it.
 *
 * The contract is identical for the built-in Design provider and for a
 * third-party peer plugin. Built-in Design registers through
 * `api.v1.extensions.registerArtifactProvider` exactly as a peer would.
 */

import type { ThreadArtifactRecord } from './types';
import type { StorageRootResolution } from './artifactStorage';

/** Namespaced owner identity supplied by the registering plugin. */
export interface PeerIdentity {
  readonly pluginId: string;
  readonly displayName?: string;
}

/**
 * A persisted artifact as the host sees it. `data` is opaque: no host code
 * ever inspects it, it is only handed back to the owning provider.
 */
export interface ThreadArtifactRef {
  readonly providerId: string;
  readonly kind: string;
  readonly schemaVersion: number;
  readonly id: string;
  readonly title: string;
  readonly data: unknown;
  /**
   * Absolute directory this artifact's files live in, if it has any. The one
   * deliberately non-opaque field: the host needs it to garbage-collect
   * storage when the owning thread is deleted (ADR-0010). Validated against
   * the vault artifact root on the way in — see `src/artifactStorage.ts`.
   */
  readonly storageRoot?: string;
}

export interface ArtifactAction {
  readonly id: string;
  readonly label: string;
  readonly tooltip?: string;
  readonly variant?: 'primary' | 'secondary';
  /** Lucide icon name rendered inside the button. */
  readonly icon?: string;
  /** Compact caption rendered beside the icon; primary actions only. */
  readonly shortLabel?: string;
}

export interface ArtifactPresentation {
  readonly title: string;
  readonly subtitle?: string;
  /** Lucide icon name rendered as the card's leading glyph. */
  readonly icon?: string;
  readonly actions: readonly ArtifactAction[];
}

export type ArtifactActionResult =
  | { readonly status: 'ok'; readonly message?: string }
  | { readonly status: 'warning'; readonly message: string }
  | { readonly status: 'error'; readonly message: string };

/** Where the host actually placed a view it was asked to open. */
export type ArtifactViewPlacement = 'context-panel' | 'tab' | 'unavailable';

/** Capabilities the host lends a provider for the duration of one action. */
export interface ArtifactActionHost {
  /** Host decides placement per its own panel policy and reports where it landed. */
  openView(state: { type: string; state?: Record<string, unknown> }): Promise<ArtifactViewPlacement>;
  revealInFolder(absolutePath: string): Promise<boolean>;
  /** Scoped write-through for this artifact only. */
  updateArtifact(patch: { title?: string; data?: unknown }): Promise<void>;
}

export interface ArtifactContribution {
  readonly providerId: string;
  readonly kinds: readonly string[];
  present(ref: ThreadArtifactRef): ArtifactPresentation;
  invoke(actionId: string, ref: ThreadArtifactRef, host: ArtifactActionHost): Promise<ArtifactActionResult>;
}

export type ArtifactRegistrationResult =
  | {
      readonly success: true;
      readonly status: 'registered';
      readonly providerId: string;
      /** Idempotent: repeated calls after the first are no-ops. */
      readonly dispose: () => void;
    }
  | {
      readonly success: false;
      readonly status: 'invalid' | 'conflict';
      readonly providerId: string;
      readonly message: string;
      /** Present on every result so callers never branch before disposing. */
      readonly dispose: () => void;
    };

/**
 * Outcome of attaching an artifact to a thread. Structured rather than thrown,
 * following the `mcp.register` precedent: a peer branches on `status` instead
 * of pattern-matching an exception.
 */
export type ArtifactAttachResult =
  | { readonly success: true; readonly status: 'attached' | 'updated'; readonly artifactId: string }
  | {
      readonly success: false;
      readonly status: 'invalid' | 'conflict' | 'unknown-provider' | 'thread-not-found' | 'unavailable';
      readonly artifactId: string;
      readonly message: string;
    };

/** Outcome of updating or detaching an already-attached artifact. */
export type ArtifactMutationResult =
  | { readonly success: true; readonly status: 'updated' | 'detached'; readonly artifactId: string }
  | {
      readonly success: false;
      readonly status: 'invalid' | 'conflict' | 'unknown-provider' | 'thread-not-found' | 'artifact-not-found' | 'unavailable';
      readonly artifactId: string;
      readonly message: string;
    };

/** Patch a peer may apply to its own artifact. Host-owned identity is not in it. */
export interface ArtifactPatch {
  readonly title?: string;
  readonly data?: unknown;
  readonly storageRoot?: string;
}

/**
 * Host-owned artifact persistence, behind the public `artifacts` namespace.
 * Implemented by `createArtifactStore`; absent when the host cannot persist
 * artifacts at all, which `attach` reports as `unavailable`.
 */
export interface ArtifactStoreHost {
  /** Records for a thread, or `null` when no such thread exists. */
  list(threadId: string): readonly ThreadArtifactRecord[] | null;
  /** Validates a peer-supplied storage root against the vault artifact root. */
  resolveStorageRoot(candidate: unknown): StorageRootResolution;
  /** Inserts, or updates in place when an artifact with the same id exists. */
  put(threadId: string, record: ThreadArtifactRecord): Promise<'attached' | 'updated' | 'thread-not-found'>;
  detach(threadId: string, artifactId: string): Promise<'detached' | 'artifact-not-found' | 'thread-not-found'>;
  /**
   * Runs an action on exactly the path a card click takes. Deliberately takes
   * ids rather than a ref, so both callers resolve the artifact identically
   * and the two paths cannot drift.
   */
  invokeAction(threadId: string, artifactId: string, actionId: string): Promise<ArtifactActionResult>;
}

/** Outcome of asking the registry to describe an artifact. */
export type ArtifactPresentationResult =
  | { readonly status: 'ok'; readonly presentation: ArtifactPresentation }
  | { readonly status: 'missing-provider'; readonly providerId: string }
  | { readonly status: 'failed'; readonly providerId: string; readonly message: string };

/** Namespaced: `<publisher>.<capability>`, lowercase, hyphen-separated. */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

const MAX_PLUGIN_ID_LENGTH = 128;
const MAX_PROVIDER_ID_LENGTH = 128;
const MAX_KINDS = 32;

/** Provider callbacks are bounded so one peer cannot stall thread execution. */
export const DEFAULT_INVOKE_TIMEOUT_MS = 60_000;

/**
 * Compatibility shim for artifacts persisted before providers existed.
 * ADR-0010 keeps this in the host deliberately, so removing the Design plugin
 * never orphans work a user already produced. Nothing is rewritten on disk.
 */
const LEGACY_PROVIDER_IDS_BY_KIND: Readonly<Record<string, string>> = Object.freeze({
  'design-static': 'agent-threads.design',
});

/** Shown when a stored artifact names a provider nothing has registered. */
export const UNKNOWN_PROVIDER_ID = 'unknown.provider';

/**
 * Adapts a persisted record to a `ThreadArtifactRef` at read time. Legacy
 * records carry no `providerId`/`schemaVersion`; both are defaulted here.
 */
export function toArtifactRef(record: ThreadArtifactRecord): ThreadArtifactRef {
  const providerId = record.providerId ?? LEGACY_PROVIDER_IDS_BY_KIND[record.kind] ?? UNKNOWN_PROVIDER_ID;
  return Object.freeze({
    providerId,
    kind: record.kind,
    schemaVersion: record.schemaVersion ?? 1,
    id: record.id,
    title: record.title,
    storageRoot: record.storageRoot,
    // A copy, so a provider can never mutate persisted state behind the
    // host's back. Writes go through ArtifactActionHost.updateArtifact.
    data: Object.freeze({ ...record }),
  });
}

/**
 * Record fields whose value the host owns. A provider may never write them,
 * whether through `ArtifactActionHost.updateArtifact` or `artifacts.update`:
 * identity must stay stable, and `storageRoot` is only ever set by the host
 * after `resolveStorageRoot` has accepted it.
 */
export const HOST_OWNED_ARTIFACT_FIELDS: readonly string[] = Object.freeze([
  'id', 'kind', 'providerId', 'schemaVersion', 'createdAt', 'storageRoot',
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RegistryEntry {
  readonly owner: PeerIdentity;
  readonly contribution: ArtifactContribution;
}

export interface ArtifactProviderRegistryOptions {
  readonly invokeTimeoutMs?: number;
}

/**
 * Host-owned registry of artifact providers. Registration is rejected with a
 * structured result rather than a throw, duplicate provider ids fail loudly,
 * and every provider callback is isolated so a faulty peer degrades its own
 * card instead of breaking thread rendering.
 */
export class ArtifactProviderRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly invokeTimeoutMs: number;

  constructor(options: ArtifactProviderRegistryOptions = {}) {
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
  }

  register(owner: PeerIdentity, contribution: ArtifactContribution): ArtifactRegistrationResult {
    const providerId = typeof contribution?.providerId === 'string' ? contribution.providerId.trim() : '';
    const invalid = (message: string): ArtifactRegistrationResult =>
      Object.freeze({ success: false as const, status: 'invalid' as const, providerId, message, dispose: () => {} });

    const pluginId = typeof owner?.pluginId === 'string' ? owner.pluginId.trim() : '';
    if (!pluginId || pluginId.length > MAX_PLUGIN_ID_LENGTH) {
      return invalid('owner.pluginId must be a non-empty string.');
    }
    if (!providerId || providerId.length > MAX_PROVIDER_ID_LENGTH || !PROVIDER_ID_PATTERN.test(providerId)) {
      return invalid('providerId must be namespaced, e.g. "my-plugin.artifacts".');
    }
    if (!Array.isArray(contribution.kinds) || contribution.kinds.length === 0 || contribution.kinds.length > MAX_KINDS
      || contribution.kinds.some(kind => typeof kind !== 'string' || !kind.trim())) {
      return invalid('kinds must be a non-empty array of non-empty strings.');
    }
    if (typeof contribution.present !== 'function' || typeof contribution.invoke !== 'function') {
      return invalid('contribution must implement present() and invoke().');
    }
    if (this.entries.has(providerId)) {
      // Last-writer-wins would silently swap a user's artifact actions, so the
      // existing registration is kept and the newcomer is told why (ADR-0010).
      return Object.freeze({
        success: false as const, status: 'conflict' as const, providerId,
        message: `An artifact provider is already registered for "${providerId}".`,
        dispose: () => {},
      });
    }

    const entry: RegistryEntry = { owner: Object.freeze({ ...owner, pluginId }), contribution };
    this.entries.set(providerId, entry);
    let disposed = false;
    return Object.freeze({
      success: true as const, status: 'registered' as const, providerId,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        // Only retract our own registration — a later re-registration by
        // someone else must survive a stale dispose.
        if (this.entries.get(providerId) === entry) this.entries.delete(providerId);
      },
    });
  }

  has(providerId: string): boolean {
    return this.entries.has(providerId);
  }

  /**
   * The plugin that registered `providerId`, if any. This is what makes
   * artifact ownership enforceable: a peer attaching under a provider id it
   * does not own is rejected rather than silently writing into another
   * plugin's namespace.
   */
  ownerOf(providerId: string): PeerIdentity | undefined {
    return this.entries.get(providerId)?.owner;
  }

  /** Artifact kinds `providerId` declared at registration. */
  kindsOf(providerId: string): readonly string[] | undefined {
    const kinds = this.entries.get(providerId)?.contribution.kinds;
    return kinds ? Object.freeze([...kinds]) : undefined;
  }

  /** Registered provider ids, in registration order. */
  providerIds(): readonly string[] {
    return Object.freeze([...this.entries.keys()]);
  }

  /** Drops every registration. Called when the public API stops. */
  clear(): void {
    this.entries.clear();
  }

  /** Never throws: a broken provider degrades to a placeholder card. */
  present(ref: ThreadArtifactRef): ArtifactPresentationResult {
    const entry = this.entries.get(ref.providerId);
    if (!entry) return { status: 'missing-provider', providerId: ref.providerId };
    try {
      const presentation = entry.contribution.present(ref);
      if (!presentation || typeof presentation.title !== 'string' || !Array.isArray(presentation.actions)) {
        return { status: 'failed', providerId: ref.providerId, message: 'The provider returned an invalid presentation.' };
      }
      return { status: 'ok', presentation };
    } catch (error) {
      console.error(`[ClaudeThreads] Artifact provider "${ref.providerId}" failed to present:`, error);
      return { status: 'failed', providerId: ref.providerId, message: errorMessage(error) };
    }
  }

  /** Never throws and never hangs: faults become an `error` result. */
  async invoke(actionId: string, ref: ThreadArtifactRef, host: ArtifactActionHost): Promise<ArtifactActionResult> {
    const entry = this.entries.get(ref.providerId);
    if (!entry) {
      return { status: 'error', message: `No artifact provider is registered for "${ref.providerId}".` };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<ArtifactActionResult>(resolve => {
        timer = setTimeout(
          () => resolve({ status: 'error', message: `"${actionId}" timed out after ${this.invokeTimeoutMs}ms.` }),
          this.invokeTimeoutMs,
        );
      });
      const result = await Promise.race([
        Promise.resolve().then(() => entry.contribution.invoke(actionId, ref, host)),
        timeout,
      ]);
      if (!result || typeof result.status !== 'string') {
        return { status: 'error', message: `"${actionId}" returned an invalid result.` };
      }
      return result;
    } catch (error) {
      console.error(`[ClaudeThreads] Artifact provider "${ref.providerId}" failed on "${actionId}":`, error);
      return { status: 'error', message: errorMessage(error) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

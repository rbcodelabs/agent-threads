/**
 * Public + internal types of the pluggable help system (ADR: pluggable-help-tool).
 *
 * Pure (no `obsidian`, no DOM): the registry, the tool and the tests import it directly.
 * The `Help*` shapes that peers see are mirrored in api/public-api-v1.d.ts.
 */
import type { PeerIdentity } from '../ArtifactContributions';

export type HelpHost = 'geode' | 'obsidian';

export interface HelpQuery {
  readonly text: string;
  readonly limit: number;
  readonly harness?: 'claude' | 'codex';
  readonly host: HelpHost;
}
export interface HelpHit {
  readonly docId: string;
  readonly title: string;
  readonly snippet: string;
  /** 0..1, provider-local; the host re-ranks, so scores need not be comparable across providers. */
  readonly score?: number;
}
export interface HelpDoc {
  readonly title: string;
  readonly text: string;
  readonly totalChars: number;
}
export interface HelpTopic {
  readonly docId: string;
  readonly title: string;
}

export interface HelpProviderContribution {
  readonly providerId: string;
  readonly title: string;
  readonly summary?: string;
  /** Absolute directories of `.md` files the host indexes. Restricted to the owner's plugin directory and the vault. */
  readonly docRoots?: readonly string[];
  search?(query: HelpQuery, signal: AbortSignal): Promise<readonly HelpHit[]>;
  get?(docId: string, options: { offset: number; maxChars: number }, signal: AbortSignal): Promise<HelpDoc | null>;
  topics?(): Promise<readonly HelpTopic[]>;
}

export type HelpProviderRegistrationResult =
  | { readonly success: true; readonly status: 'registered'; readonly providerId: string; readonly dispose: () => void }
  | { readonly success: false; readonly status: 'invalid' | 'conflict' | 'unavailable'; readonly providerId: string; readonly message: string; readonly dispose: () => void };

/** Host-enforced limits. Providers are never trusted to honor them. */
export const HELP_LIMITS = Object.freeze({
  defaultHits: 8,
  maxHits: 20,
  snippetChars: 240,
  titleChars: 200,
  summaryChars: 200,
  getPageChars: 16_000,
  totalResponseChars: 40_000,
  hitsAcceptedPerProvider: 500,
  maxProviders: 64,
  searchTimeoutMs: 2_000,
  getTimeoutMs: 5_000,
  docRootMaxFileBytes: 2 * 1024 * 1024,
  docRootMaxFiles: 2_000,
});

export interface RegisteredHelpProvider {
  readonly providerId: string;
  readonly owner: PeerIdentity;
  readonly title: string;
  readonly summary?: string;
}

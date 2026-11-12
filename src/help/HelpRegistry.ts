/**
 * Host-owned registry of help providers and the fan-out/ranking logic behind the `agent_threads_help` tool.
 *
 * Mirrors AgentToolRegistry: structured registration results, no shadowing (a duplicate providerId is a
 * `conflict` and the incumbent wins), stale `dispose()` cannot retract a later registration, and every provider
 * callback is isolated, time-bounded and size-capped by the HOST (providers are never trusted to honor limits).
 *
 * Unlike agent tools, providers are resolved on every call, not frozen at session construction.
 */
import type { PeerIdentity } from '../ArtifactContributions';
import { tokenizeQuery } from '../searchUtils';
import { DocCorpus, FsDocCorpusCache, resolveDocRoot } from './docIndex';
import {
  HELP_LIMITS, type HelpDoc, type HelpHit, type HelpHost, type HelpProviderContribution,
  type HelpProviderRegistrationResult, type HelpQuery, type HelpTopic, type RegisteredHelpProvider,
} from './types';

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const MAX_PROVIDER_ID_LENGTH = 64;
const MAX_PLUGIN_ID_LENGTH = 128;
const MAX_DOC_ID_LENGTH = 500;
/** providerId prefix -> predicate on the owner. `agent-threads.` is Agent Threads itself; `geode.` is Geode. */
const RESERVED_PREFIXES: ReadonlyArray<{ prefix: string; owns: (pluginId: string) => boolean }> = [
  { prefix: 'agent-threads.', owns: (id) => id === 'claude-threads' || id === 'agent-threads' },
  { prefix: 'geode.', owns: (id) => id === 'geode' || id.startsWith('geode.') || id.startsWith('geode-') },
];

export const BUILT_IN_DOCS_PROVIDER_ID = 'agent-threads.docs';
const BUILT_IN_OWNER: PeerIdentity = Object.freeze({ pluginId: 'claude-threads', displayName: 'Agent Threads' });

interface ResolvedProvider {
  readonly providerId: string;
  readonly owner: PeerIdentity;
  readonly title: string;
  readonly summary?: string;
  /** 0 Agent Threads, 1 Geode, 2 everyone else (ties then fall to providerId). */
  readonly rank: number;
  search(query: HelpQuery, signal: AbortSignal): Promise<readonly HelpHit[]>;
  get(docId: string, options: { offset: number; maxChars: number }, signal: AbortSignal): Promise<HelpDoc | null>;
  topics(): Promise<readonly HelpTopic[]>;
}

export interface HelpRegistryOptions {
  /** Directories a peer's `docRoots` may live in: the owner's own plugin directory and the vault. Read lazily. */
  readonly allowedRootBases?: (owner: PeerIdentity) => readonly string[];
  readonly host?: () => HelpHost;
  readonly searchTimeoutMs?: number;
  readonly getTimeoutMs?: number;
}

export interface RankedHit {
  /** `<providerId>:<docId>`, the value `get` takes. */
  readonly id: string;
  readonly provider: string;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
}
export interface ProviderFailure { readonly providerId: string; readonly reason: string }

export type HelpGetResult =
  | { readonly ok: true; readonly id: string; readonly provider: RegisteredHelpProvider; readonly title: string; readonly text: string; readonly totalChars: number; readonly offset: number; readonly nextOffset?: number }
  | { readonly ok: false; readonly error: string };

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

async function bounded<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`timed out after ${timeoutMs} ms`)); }, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sanitizeHits(raw: unknown): HelpHit[] {
  if (!Array.isArray(raw)) throw new Error('search() must return an array');
  const out: HelpHit[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, HELP_LIMITS.hitsAcceptedPerProvider)) {
    if (!item || typeof item !== 'object') continue;
    const h = item as Record<string, unknown>;
    if (typeof h.docId !== 'string' || !h.docId || h.docId.length > MAX_DOC_ID_LENGTH || /[\r\n]/.test(h.docId)) continue;
    if (typeof h.title !== 'string' || seen.has(h.docId)) continue;
    seen.add(h.docId);
    out.push({
      docId: h.docId,
      title: h.title.replace(/\s+/g, ' ').trim().slice(0, HELP_LIMITS.titleChars),
      snippet: (typeof h.snippet === 'string' ? h.snippet : '').replace(/\s+/g, ' ').trim().slice(0, HELP_LIMITS.snippetChars),
      ...(typeof h.score === 'number' && Number.isFinite(h.score) ? { score: clamp01(h.score) } : {}),
    });
  }
  return out;
}

function sanitizeTopics(raw: unknown): HelpTopic[] {
  if (!Array.isArray(raw)) throw new Error('topics() must return an array');
  const out: HelpTopic[] = [];
  for (const item of raw.slice(0, HELP_LIMITS.hitsAcceptedPerProvider)) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    if (typeof t.docId !== 'string' || !t.docId || t.docId.length > MAX_DOC_ID_LENGTH || typeof t.title !== 'string') continue;
    out.push({ docId: t.docId, title: t.title.replace(/\s+/g, ' ').trim().slice(0, HELP_LIMITS.titleChars) });
  }
  return out;
}

function sanitizeDoc(raw: unknown, offset: number, maxChars: number): HelpDoc | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') throw new Error('get() must return a document or null');
  const d = raw as Record<string, unknown>;
  if (typeof d.text !== 'string' || typeof d.title !== 'string') throw new Error('get() returned a malformed document');
  const text = d.text.slice(0, maxChars);
  const total = typeof d.totalChars === 'number' && Number.isFinite(d.totalChars) && d.totalChars >= offset + text.length ? Math.floor(d.totalChars) : offset + text.length;
  return { title: d.title.slice(0, HELP_LIMITS.titleChars), text, totalChars: total };
}

export class HelpProviderRegistry {
  private readonly entries = new Map<string, ResolvedProvider>();

  constructor(private readonly options: HelpRegistryOptions = {}) {}

  // ── registration ───────────────────────────────────────────────────────────

  register(owner: PeerIdentity, contribution: HelpProviderContribution): HelpProviderRegistrationResult {
    const providerId = typeof contribution?.providerId === 'string' ? contribution.providerId.trim() : '';
    const fail = (status: 'invalid' | 'conflict', message: string): HelpProviderRegistrationResult =>
      Object.freeze({ success: false as const, status, providerId, message, dispose: () => {} });

    const pluginId = typeof owner?.pluginId === 'string' ? owner.pluginId.trim() : '';
    if (!pluginId || pluginId.length > MAX_PLUGIN_ID_LENGTH) return fail('invalid', 'owner.pluginId must be a non-empty string.');
    if (!providerId || providerId.length > MAX_PROVIDER_ID_LENGTH || !PROVIDER_ID_PATTERN.test(providerId)) {
      return fail('invalid', `providerId must look like "<publisher>.<capability>" (${PROVIDER_ID_PATTERN}, at most ${MAX_PROVIDER_ID_LENGTH} characters).`);
    }
    for (const { prefix, owns } of RESERVED_PREFIXES) {
      if (providerId.startsWith(prefix) && !owns(pluginId)) return fail('invalid', `"${prefix}*" provider ids are reserved for their publisher.`);
    }
    const title = typeof contribution.title === 'string' ? contribution.title.replace(/\s+/g, ' ').trim() : '';
    if (!title || title.length > HELP_LIMITS.titleChars) return fail('invalid', `title must contain 1-${HELP_LIMITS.titleChars} characters.`);
    if (contribution.summary !== undefined && (typeof contribution.summary !== 'string' || contribution.summary.length > HELP_LIMITS.summaryChars)) {
      return fail('invalid', `summary must be a string of at most ${HELP_LIMITS.summaryChars} characters.`);
    }
    const hasCallbacks = typeof contribution.search === 'function' && typeof contribution.get === 'function';
    if ((contribution.search === undefined) !== (contribution.get === undefined) || (contribution.search !== undefined && !hasCallbacks)) {
      return fail('invalid', 'search() and get() must be provided together as functions.');
    }
    if (contribution.topics !== undefined && typeof contribution.topics !== 'function') return fail('invalid', 'topics must be a function.');
    if (contribution.docRoots !== undefined && !Array.isArray(contribution.docRoots)) return fail('invalid', 'docRoots must be an array of absolute paths.');
    const docRoots = contribution.docRoots ?? [];
    if (!hasCallbacks && docRoots.length === 0) return fail('invalid', 'a provider needs docRoots or search()+get().');
    if (docRoots.length > 8) return fail('invalid', 'at most 8 docRoots are allowed.');

    const realRoots: string[] = [];
    if (docRoots.length) {
      const bases = this.options.allowedRootBases?.(owner) ?? [];
      for (const root of docRoots) {
        const resolved = resolveDocRoot(root, bases);
        if (!resolved.ok) return fail('invalid', resolved.error);
        realRoots.push(resolved.real);
      }
    }

    const existing = this.entries.get(providerId);
    if (existing) return fail('conflict', `"${providerId}" is already registered by "${existing.owner.pluginId}".`);
    if (this.entries.size >= HELP_LIMITS.maxProviders) return fail('invalid', `at most ${HELP_LIMITS.maxProviders} help providers can be registered.`);

    const cache = realRoots.length ? new FsDocCorpusCache(realRoots) : null;
    const entry = this.resolve({
      providerId, owner: Object.freeze({ ...owner, pluginId }), title, summary: contribution.summary,
      rank: providerId.startsWith('geode.') ? 1 : 2,
      search: contribution.search?.bind(contribution), get: contribution.get?.bind(contribution), topics: contribution.topics?.bind(contribution),
      corpus: cache ? () => cache.get() : undefined,
    });
    return this.install(entry);
  }

  /** The built-in Agent Threads docs provider: a host-internal corpus, not subject to peer root restrictions. */
  registerBuiltInDocs(loadCorpus: () => Promise<DocCorpus>): { dispose: () => void } {
    const entry = this.resolve({
      providerId: BUILT_IN_DOCS_PROVIDER_ID, owner: BUILT_IN_OWNER, title: 'Agent Threads',
      summary: 'How Agent Threads works: features, settings, tools, remote daemons and the peer plugin API.',
      rank: 0, corpus: loadCorpus,
    });
    const result = this.install(entry);
    return { dispose: result.dispose };
  }

  private resolve(spec: {
    providerId: string; owner: PeerIdentity; title: string; summary?: string; rank: number;
    search?: HelpProviderContribution['search']; get?: HelpProviderContribution['get']; topics?: HelpProviderContribution['topics'];
    corpus?: () => Promise<DocCorpus>;
  }): ResolvedProvider {
    const { corpus } = spec;
    return {
      providerId: spec.providerId, owner: spec.owner, title: spec.title, summary: spec.summary, rank: spec.rank,
      async search(query, signal) {
        const hits: HelpHit[] = [];
        if (spec.search) hits.push(...sanitizeHits(await spec.search(query, signal)));
        if (corpus) hits.push(...(await corpus()).search(query.text, query.limit));
        return hits;
      },
      async get(docId, options, signal) {
        if (spec.get) {
          const doc = sanitizeDoc(await spec.get(docId, options, signal), options.offset, options.maxChars);
          if (doc) return doc;
        }
        return corpus ? (await corpus()).get(docId, options.offset, options.maxChars) : null;
      },
      async topics() {
        const topics: HelpTopic[] = [];
        if (spec.topics) topics.push(...sanitizeTopics(await spec.topics()));
        if (corpus) topics.push(...(await corpus()).topics());
        return topics;
      },
    };
  }

  private install(entry: ResolvedProvider): HelpProviderRegistrationResult {
    const existing = this.entries.get(entry.providerId);
    if (existing) {
      return Object.freeze({ success: false as const, status: 'conflict' as const, providerId: entry.providerId, message: `"${entry.providerId}" is already registered by "${existing.owner.pluginId}".`, dispose: () => {} });
    }
    this.entries.set(entry.providerId, entry);
    let disposed = false;
    return Object.freeze({
      success: true as const, status: 'registered' as const, providerId: entry.providerId,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        // Only retract our own registration: a later one under the same id must survive a stale dispose.
        if (this.entries.get(entry.providerId) === entry) this.entries.delete(entry.providerId);
      },
    });
  }

  has(providerId: string): boolean { return this.entries.has(providerId); }

  list(): readonly RegisteredHelpProvider[] {
    return Object.freeze(this.sorted().map((p) => ({ providerId: p.providerId, owner: p.owner, title: p.title, ...(p.summary ? { summary: p.summary } : {}) })));
  }

  /** Drops every registration. Called when the public API stops. */
  clear(): void { this.entries.clear(); }

  private sorted(): ResolvedProvider[] {
    return [...this.entries.values()].sort((a, b) => a.rank - b.rank || a.providerId.localeCompare(b.providerId));
  }

  private select(provider: string | undefined): { providers: ResolvedProvider[] } | { error: string } {
    if (!provider) return { providers: this.sorted() };
    const found = this.entries.get(provider);
    if (!found) return { error: `Unknown help provider "${provider}". Known providers: ${this.sorted().map((p) => p.providerId).join(', ') || '(none)'}.` };
    return { providers: [found] };
  }

  // ── operations ─────────────────────────────────────────────────────────────

  async search(input: { text: string; limit?: number; provider?: string; harness?: 'claude' | 'codex' }):
    Promise<{ hits: RankedHit[]; failures: ProviderFailure[] } | { error: string }> {
    const selected = this.select(input.provider);
    if ('error' in selected) return selected;
    const limit = Math.max(1, Math.min(HELP_LIMITS.maxHits, Math.floor(input.limit ?? HELP_LIMITS.defaultHits)));
    const query: HelpQuery = { text: input.text, limit, host: this.options.host?.() ?? 'obsidian', ...(input.harness ? { harness: input.harness } : {}) };
    const terms = tokenizeQuery(input.text);
    const timeout = this.options.searchTimeoutMs ?? HELP_LIMITS.searchTimeoutMs;
    const failures: ProviderFailure[] = [];

    const perProvider = await Promise.all(selected.providers.map(async (provider) => {
      try {
        const hits = (await bounded(timeout, (signal) => provider.search(query, signal))) as HelpHit[];
        // Corpus hits are already sane; peer hits were sanitized in resolve(). Dedupe across both sources.
        const seen = new Set<string>();
        const unique = hits.filter((h) => !seen.has(h.docId) && !!seen.add(h.docId)).slice(0, HELP_LIMITS.hitsAcceptedPerProvider);
        const n = unique.length;
        const ranked = unique.map((h, i) => {
          const base = h.score !== undefined ? h.score : (n <= 1 ? 1 : 1 - i / n);
          const titleLower = h.title.toLowerCase();
          const boost = terms.some((t) => titleLower.includes(t)) ? 0.25 : 0;
          return { provider, hit: h, score: base + boost };
        });
        ranked.sort((a, b) => b.score - a.score || a.hit.docId.localeCompare(b.hit.docId));
        return ranked.slice(0, limit);
      } catch (error) {
        failures.push({ providerId: provider.providerId, reason: errorText(error) });
        return [];
      }
    }));

    // Round-robin so one chatty provider cannot fill the page. Providers take turns ordered by their best
    // adjusted score, then Agent Threads, Geode, peers by providerId, which makes the result deterministic.
    const lanes = perProvider.filter((l) => l.length > 0).sort((a, b) =>
      b[0].score - a[0].score || a[0].provider.rank - b[0].provider.rank || a[0].provider.providerId.localeCompare(b[0].provider.providerId));
    const hits: RankedHit[] = [];
    for (let round = 0; hits.length < limit && lanes.some((l) => l.length > round); round++) {
      for (const lane of lanes) {
        const item = lane[round];
        if (!item || hits.length >= limit) continue;
        hits.push({
          id: `${item.provider.providerId}:${item.hit.docId}`, provider: item.provider.providerId,
          title: item.hit.title, snippet: item.hit.snippet, score: Math.round(item.score * 1000) / 1000,
        });
      }
    }
    failures.sort((a, b) => a.providerId.localeCompare(b.providerId));
    return { hits, failures };
  }

  async get(id: string, offset = 0, provider?: string): Promise<HelpGetResult> {
    const colon = id.indexOf(':');
    if (colon <= 0 || colon === id.length - 1) return { ok: false, error: `Invalid id "${id}". Expected "<providerId>:<docId>" as returned by search or topics.` };
    const providerId = id.slice(0, colon);
    const docId = id.slice(colon + 1);
    if (provider && provider !== providerId) return { ok: false, error: `id "${id}" belongs to provider "${providerId}", not "${provider}".` };
    const entry = this.entries.get(providerId);
    if (!entry) return { ok: false, error: `Unknown help provider "${providerId}". Known providers: ${this.sorted().map((p) => p.providerId).join(', ') || '(none)'}.` };
    const start = Math.max(0, Math.floor(offset));
    const maxChars = HELP_LIMITS.getPageChars;
    try {
      const doc = await bounded(this.options.getTimeoutMs ?? HELP_LIMITS.getTimeoutMs, (signal) => entry.get(docId, { offset: start, maxChars }, signal));
      if (!doc) return { ok: false, error: `No document "${docId}" in provider "${providerId}".` };
      const end = start + doc.text.length;
      return {
        ok: true, id, provider: { providerId, owner: entry.owner, title: entry.title }, title: doc.title,
        text: doc.text, totalChars: doc.totalChars, offset: start, ...(end < doc.totalChars ? { nextOffset: end } : {}),
      };
    } catch (error) {
      return { ok: false, error: `Help provider "${providerId}" is unavailable: ${errorText(error)}` };
    }
  }

  /** With no `provider`: the providers only (cheap first call). With one: its top-level docs, paged. */
  async topics(input: { provider?: string; limit?: number; offset?: number }):
    Promise<{ kind: 'providers'; providers: readonly RegisteredHelpProvider[] } | { kind: 'docs'; provider: RegisteredHelpProvider; topics: Array<{ id: string; title: string }>; total: number; nextOffset?: number } | { error: string }> {
    const selected = this.select(input.provider);
    if ('error' in selected) return selected;
    if (!input.provider) return { kind: 'providers', providers: this.list().slice(0, HELP_LIMITS.maxProviders) };
    const entry = selected.providers[0];
    const limit = Math.max(1, Math.min(HELP_LIMITS.maxHits, Math.floor(input.limit ?? HELP_LIMITS.defaultHits)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    try {
      const all = await bounded(this.options.getTimeoutMs ?? HELP_LIMITS.getTimeoutMs, () => entry.topics());
      const page = all.slice(offset, offset + limit).map((t) => ({ id: `${entry.providerId}:${t.docId}`, title: t.title }));
      return {
        kind: 'docs', provider: { providerId: entry.providerId, owner: entry.owner, title: entry.title, ...(entry.summary ? { summary: entry.summary } : {}) },
        topics: page, total: all.length, ...(offset + limit < all.length ? { nextOffset: offset + limit } : {}),
      };
    } catch (error) {
      return { error: `Help provider "${entry.providerId}" is unavailable: ${errorText(error)}` };
    }
  }
}

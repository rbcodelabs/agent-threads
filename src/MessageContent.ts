/** Portable, declarative transcript content. No Node, Obsidian or DOM dependencies. */
import { PROVIDER_ID_PATTERN } from './ArtifactContributions';
import type { ArtifactAction, ArtifactActionResult, ArtifactViewPlacement, PeerIdentity } from './ArtifactContributions';
import { scanBalancedObject } from './visualizeMarker';

export type MessageContentJson = null | boolean | number | string | readonly MessageContentJson[] | { readonly [key: string]: MessageContentJson };
export interface MessageContentRef {
  readonly providerId: string;
  readonly id: string;
  readonly schemaVersion: number;
  readonly title: string;
  readonly data: Readonly<Record<string, MessageContentJson>>;
}
export interface MessageContentContext { readonly threadId: string; readonly messageId: string; readonly signal: AbortSignal }
interface PresentationBase { readonly title: string; readonly subtitle?: string; readonly icon?: string; readonly actions?: readonly ArtifactAction[] }
export type MessageContentPresentation =
  | (PresentationBase & { readonly kind: 'card'; readonly body?: string })
  | (PresentationBase & { readonly kind: 'image'; readonly src: string; readonly alt: string })
  | (PresentationBase & { readonly kind: 'document'; readonly html: string; readonly height?: number });
export interface MessageContentActionHost {
  readonly signal: AbortSignal;
  openView(state: { type: string; state?: Record<string, unknown> }): Promise<ArtifactViewPlacement>;
}
export interface MessageContentContribution {
  readonly providerId: string;
  present(ref: MessageContentRef, context: MessageContentContext): MessageContentPresentation | Promise<MessageContentPresentation>;
  invoke?(actionId: string, ref: MessageContentRef, context: MessageContentContext, host: MessageContentActionHost): Promise<ArtifactActionResult>;
}
export type MessageContentRegistrationResult =
  | { readonly success: true; readonly status: 'registered'; readonly providerId: string; readonly dispose: () => void }
  | { readonly success: false; readonly status: 'invalid' | 'conflict' | 'unavailable'; readonly providerId: string; readonly message: string; readonly dispose: () => void };

const MAX_REFERENCE = 32_768;
const MAX_DOCUMENT = 1_000_000;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const bounded = (value: unknown, limit: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= limit;

/** Reject values JSON.stringify silently changes; clone and recursively freeze accepted data. */
function jsonCopy(value: unknown, depth = 0, seen = new Set<object>()): MessageContentJson {
  if (depth > 20) throw new Error('JSON is too deeply nested.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || !value || seen.has(value)) throw new Error('Expected plain JSON.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map(item => jsonCopy(item, depth + 1, seen)));
    if (!plain(value)) throw new Error('Expected plain JSON.');
    const copy: Record<string, MessageContentJson> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype' || !('value' in descriptor)) throw new Error('Unsafe JSON key.');
      copy[key] = jsonCopy(descriptor.value, depth + 1, seen);
    }
    return Object.freeze(copy);
  } finally { seen.delete(value); }
}

export function validateMessageContentRef(value: unknown): MessageContentRef | null {
  try {
    if (!plain(value) || !bounded(value.providerId, 128) || !PROVIDER_ID_PATTERN.test(value.providerId)
      || !bounded(value.id, 256) || !bounded(value.title, 512)
      || !Number.isSafeInteger(value.schemaVersion) || Number(value.schemaVersion) < 1 || !plain(value.data)
      || Object.keys(value).some(key => !['providerId', 'id', 'schemaVersion', 'title', 'data'].includes(key))) return null;
    const ref = Object.freeze({ providerId: value.providerId, id: value.id, schemaVersion: value.schemaVersion as number, title: value.title, data: jsonCopy(value.data) as Readonly<Record<string, MessageContentJson>> });
    return JSON.stringify(ref).length <= MAX_REFERENCE ? ref : null;
  } catch { return null; }
}

export function formatMessageContentReference(value: MessageContentRef): string {
  const ref = validateMessageContentRef(value);
  if (!ref) throw new Error('Invalid message content reference: expected bounded plain JSON and a namespaced providerId.');
  // Prevent line separators and raw HTML from becoming markdown syntax.
  return `agent-content${JSON.stringify(ref).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}`;
}

export interface MessageContentMarker { readonly token: string; readonly ref: MessageContentRef }
export function extractMessageContent(source: string, options: { streaming?: boolean } = {}): { text: string; markers: MessageContentMarker[] } {
  const markers: MessageContentMarker[] = [];
  let fence: string | undefined;
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(?: {4}|\t)/.test(line)) continue;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
      continue;
    }
    if (fence) continue;
    const body = line.trimStart();
    if (options.streaming && i === lines.length - 1 && body && 'agent-content'.startsWith(body)) { lines[i] = ''; continue; }
    if (!body.startsWith('agent-content{')) continue;
    const end = scanBalancedObject(body, 13);
    if (end === -1) {
      if (options.streaming && i === lines.length - 1) lines[i] = '';
      continue;
    }
    if (end > MAX_REFERENCE + 13 || body.slice(end).trim()) continue;
    let ref: MessageContentRef | null;
    try { ref = validateMessageContentRef(JSON.parse(body.slice(13, end))); } catch { continue; }
    if (!ref || markers.length >= 32) continue;
    // Unpredictable per-render tokens prevent user-authored HTML from impersonating a slot.
    const token = crypto.randomUUID();
    markers.push({ token, ref });
    lines[i] = `<a class="ct-message-content-slot" data-ct-content="${token}" href="#">${escapeMessageContentHtml(ref.title)}</a>`;
  }
  return { text: lines.join('\n'), markers };
}

export function escapeMessageContentHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

export function isSafeMessageImage(src: string): boolean {
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/]+={0,2}$/.test(src)) return src.length <= 2_000_000;
  try { const url = new URL(src); return url.protocol === 'https:' && !url.username && !url.password && src.length <= 8192; } catch { return false; }
}

function presentationCopy(value: MessageContentPresentation): MessageContentPresentation | null {
  if (!plain(value) || !bounded(value.title, 512)) return null;
  if (value.subtitle !== undefined && (typeof value.subtitle !== 'string' || value.subtitle.length > 2048)) return null;
  if (value.icon !== undefined && (!bounded(value.icon, 64) || !/^[a-z0-9-]+$/.test(value.icon))) return null;
  const actions: ArtifactAction[] = [];
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions) || value.actions.length > 8) return null;
    for (const action of value.actions) {
      if (!plain(action) || !bounded(action.id, 128) || !bounded(action.label, 256) || actions.some(existing => existing.id === action.id)) return null;
      if (action.variant !== undefined && action.variant !== 'primary' && action.variant !== 'secondary') return null;
      actions.push(Object.freeze({ id: action.id, label: action.label, variant: action.variant as ArtifactAction['variant'] }));
    }
  }
  const base = { title: value.title, subtitle: value.subtitle, icon: value.icon, actions: Object.freeze(actions) };
  if (value.kind === 'card' && (value.body === undefined || (typeof value.body === 'string' && value.body.length <= 32_768))) return Object.freeze({ ...base, kind: 'card', body: value.body });
  if (value.kind === 'image' && typeof value.src === 'string' && isSafeMessageImage(value.src) && typeof value.alt === 'string' && value.alt.length <= 2048) return Object.freeze({ ...base, kind: 'image', src: value.src, alt: value.alt });
  if (value.kind === 'document' && typeof value.html === 'string' && value.html.length <= MAX_DOCUMENT && (value.height === undefined || (typeof value.height === 'number' && Number.isFinite(value.height)))) return Object.freeze({ ...base, kind: 'document', html: value.html, height: Math.max(160, Math.min(800, value.height ?? 360)) });
  return null;
}

interface Entry { readonly contribution: MessageContentContribution; readonly controller: AbortController }
/** Fault-isolated registration; generation-specific callbacks never survive disposal. */
export class MessageContentProviderRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly timeoutMs: number;
  constructor(options: { timeoutMs?: number } = {}) { this.timeoutMs = options.timeoutMs ?? 15_000; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { for (const listener of this.listeners) { try { listener(); } catch { /* One view cannot disrupt another. */ } } }
  register(owner: PeerIdentity, contribution: MessageContentContribution): MessageContentRegistrationResult {
    const providerId = typeof contribution?.providerId === 'string' ? contribution.providerId : '';
    const failure = (status: 'invalid' | 'conflict', message: string): MessageContentRegistrationResult => Object.freeze({ success: false, status, providerId, message, dispose: () => {} });
    if (!bounded(owner?.pluginId, 128) || !bounded(providerId, 128) || !PROVIDER_ID_PATTERN.test(providerId) || typeof contribution.present !== 'function' || (contribution.invoke !== undefined && typeof contribution.invoke !== 'function')) return failure('invalid', 'Expected a namespaced providerId, plugin identity and present callback.');
    if (this.entries.has(providerId)) return failure('conflict', 'A provider with this id is already registered.');
    const entry: Entry = { contribution: Object.freeze({ providerId, present: contribution.present.bind(contribution), invoke: contribution.invoke?.bind(contribution) }), controller: new AbortController() };
    this.entries.set(providerId, entry); this.changed();
    return Object.freeze({ success: true, status: 'registered', providerId, dispose: () => {
      if (this.entries.get(providerId) !== entry) return;
      this.entries.delete(providerId); entry.controller.abort(); this.changed();
    } });
  }
  clear(): void { for (const entry of this.entries.values()) entry.controller.abort(); this.entries.clear(); this.changed(); }
  private async call<T>(entry: Entry, context: MessageContentContext, callback: (context: MessageContentContext) => T | Promise<T>): Promise<T | null> {
    if (context.signal.aborted || entry.controller.signal.aborted) return null;
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal.addEventListener('abort', abort, { once: true });
    entry.controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      return await Promise.race([
        Promise.resolve().then(() => controller.signal.aborted ? null : callback(Object.freeze({ threadId: context.threadId, messageId: context.messageId, signal: controller.signal }))),
        new Promise<null>(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true })),
      ]);
    } catch { return null; }
    finally { clearTimeout(timer); context.signal.removeEventListener('abort', abort); entry.controller.signal.removeEventListener('abort', abort); controller.abort(); }
  }
  async present(reference: MessageContentRef, context: MessageContentContext): Promise<MessageContentPresentation | null> {
    const ref = validateMessageContentRef(reference);
    const entry = ref && this.entries.get(ref.providerId);
    if (!ref || !entry) return null;
    const result = await this.call(entry, context, ctx => entry.contribution.present(ref, ctx));
    if (!result || this.entries.get(ref.providerId) !== entry || context.signal.aborted) return null;
    try { return presentationCopy(result); } catch { return null; }
  }
  async invoke(actionId: string, reference: MessageContentRef, context: MessageContentContext, host: Omit<MessageContentActionHost, 'signal'>): Promise<ArtifactActionResult> {
    const ref = validateMessageContentRef(reference);
    const entry = ref && this.entries.get(ref.providerId);
    const error = { status: 'error' as const, message: 'This content action is unavailable.' };
    if (!entry?.contribution.invoke || !ref) return error;
    // Revalidate the named action against the current provider generation.
    const presentation = await this.present(ref, context);
    if (!presentation?.actions?.some(action => action.id === actionId) || this.entries.get(ref.providerId) !== entry) return error;
    const result = await this.call(entry, context, ctx => entry.contribution.invoke!(actionId, ref, ctx, Object.freeze({ signal: ctx.signal, openView: async (state: { type: string; state?: Record<string, unknown> }) => {
      if (ctx.signal.aborted || context.signal.aborted || this.entries.get(ref.providerId) !== entry || !bounded(state?.type, 256)) return 'unavailable';
      return host.openView(state);
    } })));
    if (!result || !['ok', 'warning', 'error'].includes(result.status) || (result.message !== undefined && (typeof result.message !== 'string' || result.message.length > 4096))) return error;
    return Object.freeze({ status: result.status, message: result.message }) as ArtifactActionResult;
  }
}

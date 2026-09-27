import type { AgentHarness } from './types';
import type { PeerIdentity } from './ArtifactContributions';

export type SlashCommandScope = 'thread' | 'dispatch';
export interface SlashCommandContext {
  readonly surface: SlashCommandScope;
  readonly text: string;
  readonly args: string;
  readonly threadId?: string;
  readonly agentHarness?: AgentHarness;
  readonly projectId?: string;
  readonly hasImages: boolean;
  readonly hasAttachment: boolean;
}
export interface SlashCommandHost {
  readonly signal: AbortSignal;
  report(message: string, isError?: boolean): void;
}
export interface SlashCommandResult {
  readonly status: 'ok' | 'error';
  readonly message?: string;
}
export interface SlashCommandHandler {
  readonly description: string;
  invoke(context: Readonly<SlashCommandContext>, host: SlashCommandHost): Promise<SlashCommandResult>;
  /**
   * Optional argument-completion suggestions offered in the composer's arg
   * dropdown once this command's name has been typed (e.g. "/board "),
   * matching the shape of the host's own built-in argCompletions. Capped at
   * 20 entries; each name ≤64 characters and description ≤256 characters.
   */
  readonly argCompletions?: readonly { name: string; description: string }[];
}
export interface SlashCommandContribution {
  readonly name: string;
  readonly thread?: SlashCommandHandler;
  readonly dispatch?: SlashCommandHandler;
}
export type SlashCommandRegistrationResult =
  | { readonly success: true; readonly status: 'registered'; readonly name: string; readonly dispose: () => void }
  | { readonly success: false; readonly status: 'invalid' | 'conflict' | 'unavailable'; readonly name: string; readonly message: string; readonly dispose: () => void };
export interface SlashCommandRegistryOptions {
  /** Read on every operation so host settings changes take priority immediately. */
  readonly reservedNames?: () => readonly string[];
  readonly timeoutMs?: number;
}

export const DEFAULT_SLASH_COMMAND_TIMEOUT_MS = 60_000;

interface RegistryEntry {
  readonly ownerId: string;
  readonly name: string;
  readonly handlers: Partial<Record<SlashCommandScope, SlashCommandHandler>>;
  readonly pending: Set<AbortController>;
}

const failure = (message: string): SlashCommandResult => ({ status: 'error', message });

/** Host-owned discovery, matching, and bounded execution for peer commands. */
export class SlashCommandRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly reservedNames: () => readonly string[];
  private readonly timeoutMs: number;

  constructor(options: SlashCommandRegistryOptions = {}) {
    this.reservedNames = options.reservedNames ?? (() => []);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SLASH_COMMAND_TIMEOUT_MS;
  }

  register(owner: PeerIdentity, contribution: SlashCommandContribution): SlashCommandRegistrationResult {
    const name = typeof contribution?.name === 'string' ? contribution.name.trim() : '';
    const reject = (status: 'invalid' | 'conflict', message: string): SlashCommandRegistrationResult =>
      Object.freeze({ success: false, status, name, message, dispose() {} });
    const ownerId = typeof owner?.pluginId === 'string' ? owner.pluginId.trim() : '';
    if (!ownerId || ownerId.length > 128) return reject('invalid', 'owner.pluginId must contain 1-128 characters.');
    if (!/^[a-z][a-z0-9-]*$/.test(name) || name.length > 64) return reject('invalid', 'name must be a lowercase command token of 1-64 characters.');
    const handlers: RegistryEntry['handlers'] = {};
    for (const scope of ['thread', 'dispatch'] as const) {
      const handler = contribution[scope];
      if (handler === undefined) continue;
      const description = typeof handler?.description === 'string' ? handler.description.trim() : '';
      if (!description || description.length > 4096 || typeof handler?.invoke !== 'function') {
        return reject('invalid', `${scope} must have a description of 1-4096 characters and invoke().`);
      }
      const rawArgCompletions = handler?.argCompletions;
      let argCompletions: readonly { name: string; description: string }[] | undefined;
      if (rawArgCompletions !== undefined) {
        if (!Array.isArray(rawArgCompletions) || rawArgCompletions.length > 20) {
          return reject('invalid', `${scope}.argCompletions must be an array of at most 20 entries.`);
        }
        const validated: { name: string; description: string }[] = [];
        for (const entry of rawArgCompletions) {
          const entryName = typeof entry?.name === 'string' ? entry.name.trim() : '';
          const entryDescription = typeof entry?.description === 'string' ? entry.description.trim() : '';
          if (!entryName || entryName.length > 64 || !entryDescription || entryDescription.length > 256) {
            return reject('invalid', `${scope}.argCompletions entries must have a name of 1-64 characters and a description of 1-256 characters.`);
          }
          validated.push({ name: entryName, description: entryDescription });
        }
        argCompletions = Object.freeze(validated);
      }
      handlers[scope] = Object.freeze({
        description,
        invoke: handler.invoke.bind(handler),
        ...(argCompletions ? { argCompletions } : {}),
      });
    }
    if (!handlers.thread && !handlers.dispatch) return reject('invalid', 'At least one command handler is required.');
    if (this.isReserved(name)) return reject('conflict', `"${name}" is reserved by the host.`);
    const existing = this.entries.get(name);
    if (existing) return reject('conflict', `"${name}" is already contributed by "${existing.ownerId}".`);
    const entry: RegistryEntry = { name, ownerId, handlers: Object.freeze(handlers), pending: new Set() };
    this.entries.set(name, entry);
    this.notify();
    return Object.freeze({
      success: true, status: 'registered', name,
      dispose: () => {
        if (this.entries.get(name) !== entry) return;
        this.entries.delete(name);
        for (const controller of entry.pending) controller.abort();
        this.notify();
      },
    });
  }

  list(scope: SlashCommandScope): { name: string; description: string }[] {
    return [...this.entries.values()].flatMap(entry => {
      const handler = entry.handlers[scope];
      return handler && !this.isReserved(entry.name) ? [{ name: entry.name, description: handler.description }] : [];
    });
  }

  match(text: string, scope: SlashCommandScope): boolean {
    return this.resolve(text, scope) !== null;
  }

  /**
   * Argument-completion suggestions a peer registered for `name` in `scope`,
   * or undefined when the command, scope, or field doesn't exist. Respects
   * the same reserved-name/existence rules as list().
   */
  argCompletionsFor(name: string, scope: SlashCommandScope): readonly { name: string; description: string }[] | undefined {
    const trimmed = typeof name === 'string' ? name.trim().toLowerCase() : '';
    if (!trimmed || this.isReserved(trimmed)) return undefined;
    const entry = this.entries.get(trimmed);
    return entry?.handlers[scope]?.argCompletions;
  }

  async invoke(context: Omit<SlashCommandContext, 'args'>, report?: (message: string, isError?: boolean) => void): Promise<SlashCommandResult | null> {
    const resolved = this.resolve(context.text, context.surface);
    if (!resolved) return null;
    const { entry, handler, args } = resolved;
    const controller = new AbortController();
    entry.pending.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let timedOut = false;
    const active = () => !controller.signal.aborted && this.entries.get(entry.name) === entry;
    const host: SlashCommandHost = Object.freeze({
      signal: controller.signal,
      report: (message: string, isError?: boolean) => {
        if (!active() || typeof message !== 'string') return;
        // UI listeners must not turn an otherwise valid peer invocation into a failure.
        try { report?.(message, isError); } catch (error) { console.error('[ClaudeThreads] Slash command feedback failed:', error); }
      },
    });
    const captured = Object.freeze({ ...context, args });
    try {
      const cancelled = new Promise<SlashCommandResult>(resolve => {
        abortListener = () => resolve(failure(timedOut
          ? `"${entry.name}" timed out after ${this.timeoutMs}ms.`
          : `"${entry.name}" is no longer registered.`));
        controller.signal.addEventListener('abort', abortListener, { once: true });
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
      });
      const running = Promise.resolve().then(() => active()
        ? handler.invoke(captured, host)
        : failure(`"${entry.name}" is no longer registered.`));
      const result = await Promise.race([running, cancelled]);
      if (!result || (result.status !== 'ok' && result.status !== 'error') || (result.message !== undefined && typeof result.message !== 'string')) {
        controller.abort();
        return failure(`"${entry.name}" returned an invalid command result.`);
      }
      return Object.freeze({ status: result.status, ...(result.message !== undefined ? { message: result.message } : {}) });
    } catch (error) {
      controller.abort();
      return failure(error instanceof Error ? error.message : String(error));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      entry.pending.delete(controller);
      // Completed operations may report later send errors. Generation identity
      // revokes that capability without retaining every completed invocation.
      // Abort is cooperative: arbitrary provider side effects cannot be undone.
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  clear(): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) for (const controller of entry.pending) controller.abort();
    if (entries.length) this.notify();
  }

  private isReserved(name: string): boolean {
    return this.reservedNames().some(reserved => reserved.trim().replace(/^\//, '').toLowerCase() === name);
  }

  private resolve(text: string, scope: SlashCommandScope): { entry: RegistryEntry; handler: SlashCommandHandler; args: string } | null {
    const parsed = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (!parsed) return null;
    const name = parsed[1].toLowerCase();
    if (this.isReserved(name)) return null;
    const entry = this.entries.get(name);
    const handler = entry?.handlers[scope];
    return entry && handler ? { entry, handler, args: (parsed[2] ?? '').trim() } : null;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch (error) { console.error('[ClaudeThreads] Slash command discovery listener failed:', error); }
    }
  }
}

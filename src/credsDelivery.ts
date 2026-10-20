/**
 * Transport-agnostic delivery of a session environment as a pushed credential kind (`creds push` / `creds.push`).
 *
 * The local container (`localDaemon/credsPusher.ts`, a `container exec` with the values on stdin) and a remote daemon
 * (`remote/secretPush.ts`, a `creds.push` frame over the authenticated socket) differ only in HOW a kind reaches the
 * daemon. Everything else is shared here: which variables may leave this computer, the kind's name, change detection
 * by hash, and refreshing a kind before its TTL runs out. Values are never logged by anything in this file.
 */
import { sha256Hex } from './remote/sha256';

/** Where pushed credential kinds go. Implementations throw an error whose text has the values redacted. */
export interface CredsSink {
  /** Stores `fields` under `kind` for `ttlSec` seconds, replacing what the kind held. */
  push(kind: string, fields: Record<string, string>, ttlSec: number): Promise<void>;
  /** Deletes a kind. Best effort: the daemon may be away, and the TTL covers that. Never throws. */
  remove(kind: string): Promise<void>;
}

// ── what may be forwarded, and the kind's name ───────────────────────────────

/** Variables never forwarded: they describe THIS Mac's shell and would break a process on the daemon. */
const NOT_FORWARDED = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|PWD|OLDPWD|TERM|LANG|LC_[A-Z_]+|SHLVL|_|(DYLD|LD)_[A-Z_]+)$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The variables that may go to a daemon: valid names, none of the Mac shell's own, non-empty values. */
export function forwardableEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || v === '' || !NAME.test(k) || NOT_FORWARDED.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export const SESSION_ENV_KIND_PREFIX = 'sessenv-';

/** Name of the credential kind holding a project's session environment; always matches `SESSION_ENV_KIND_PATTERN`. */
export function sessionEnvKind(projectId: string | undefined): string {
  const id = (projectId ?? 'none').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '').slice(0, 48) || 'none';
  return `${SESSION_ENV_KIND_PREFIX}${id}`;
}

// ── change detection and refresh ─────────────────────────────────────────────

export interface EnvKindDeliveryOptions {
  /** Push again when what is stored is older than this, even if unchanged (so the TTL never lapses mid-use). */
  refreshMs: number;
  now?: () => number;
}

/** Remembers what each kind was last given, so unchanged environments are not pushed again until they are old. */
export class EnvKindDelivery {
  private readonly pushed = new Map<string, { hash: string; at: number }>();
  private readonly now: () => number;

  constructor(private readonly sink: CredsSink, private readonly opts: EnvKindDeliveryOptions) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Makes `kind` hold exactly `env`. An empty `env` deletes the kind. Returns whether the kind exists afterwards.
   * Throws (redacted by the sink) when a needed push fails; nothing is recorded then, so the next call tries again.
   */
  async deliver(kind: string, env: Readonly<Record<string, string>>, ttlSec: number): Promise<boolean> {
    if (Object.keys(env).length === 0) {
      if (this.pushed.delete(kind)) await this.sink.remove(kind);
      return false;
    }
    const hash = sha256Hex(JSON.stringify(Object.entries(env).sort()));
    const prev = this.pushed.get(kind);
    if (!prev || prev.hash !== hash || this.now() - prev.at > this.opts.refreshMs) {
      await this.sink.push(kind, { ...env }, ttlSec);
      this.pushed.set(kind, { hash, at: this.now() });
    }
    return true;
  }

  /** Deletes one kind that this object pushed. */
  async remove(kind: string): Promise<void> {
    if (this.pushed.delete(kind)) await this.sink.remove(kind);
  }

  /** Deletes everything pushed, best effort. */
  async stop(): Promise<void> {
    for (const kind of [...this.pushed.keys()]) {
      try { await this.sink.remove(kind); } catch { /* the TTL covers it */ }
    }
    this.pushed.clear();
  }

  /** Forget what was pushed without deleting it (the store behind the sink was reset). */
  clear(): void {
    this.pushed.clear();
  }

  kinds(): string[] {
    return [...this.pushed.keys()];
  }
}

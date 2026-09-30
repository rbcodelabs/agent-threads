/**
 * githubCredentials.ts — Agent Threads' side of Geode's GitHub connection.
 *
 * Geode (>= 0.25.0) owns GitHub sign-in: device-flow GitHub App auth, encrypted
 * token storage and refresh, exposed to the renderer as `window.geode.githubAuth`.
 * This module is the only place Agent Threads talks to that bridge. It is
 * dependency-free (no Obsidian, no Node) so every rule below is unit-testable.
 *
 * ## What the token is — and is not
 *
 * `getToken()` returns a GitHub App **user-to-server** token (`ghu_…`), valid
 * ~8h. It is NOT scoped to one repository: it reaches every repository in every
 * installation of the Geode App that the user can access, limited by the App's
 * permissions (Contents rw, Pull requests rw, Actions r, Metadata r). We cannot
 * narrow it; we can only limit where it is written and for how long. So:
 *
 *   - the token is never put in an env var, prompt, log, tool result, git
 *     config, image, or the bind-mounted worktree;
 *   - it reaches git through a credential helper and `gh` through a wrapper,
 *     both of which read a short-lived mode-0600 file;
 *   - the file is rewritten on a timer (Geode refreshes when < 5 min remain)
 *     and deleted on stop, disconnect, or any failure to obtain a token.
 *
 * Commit identity is deliberately separate from authentication: it comes from
 * the GitHub profile (`/user`), defaulting to the privacy-preserving noreply
 * address, and is applied only where the user has not configured their own.
 */

// ── Bridge (subset of window.geode.githubAuth) ────────────────────────────────

export type GithubIpcResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export interface GithubRepo { id: number; fullName: string; private: boolean }
export interface GithubInstallation { id: number; account: string; repositories: GithubRepo[] }
export interface GithubRepoCoverage { covered: boolean; installationId: number | null; installUrl: string | null }

export type GithubBridgeStatus =
  | { state: 'disconnected'; encryptionAvailable: boolean }
  | { state: 'pending'; userCode: string; verificationUri: string; expiresAt: number }
  | { state: 'connected'; login: string | null }
  | { state: 'reauth_required'; message: string }
  | { state: 'error'; message: string };

export interface GithubAuthBridge {
  status(): Promise<GithubBridgeStatus>;
  listAccess(): Promise<GithubIpcResult<GithubInstallation[]>>;
  checkRepo(repo: string): Promise<GithubIpcResult<GithubRepoCoverage>>;
  getToken(): Promise<GithubIpcResult<string>>;
}

/** Picks the bridge off a host window; undefined on Obsidian or older Geode. */
export function resolveGithubBridge(hostWindow: { geode?: { githubAuth?: unknown } } | undefined): GithubAuthBridge | undefined {
  const bridge = hostWindow?.geode?.githubAuth as Partial<GithubAuthBridge> | undefined;
  if (!bridge || typeof bridge.getToken !== 'function' || typeof bridge.status !== 'function') return undefined;
  return bridge as GithubAuthBridge;
}

// ── Actionable errors ─────────────────────────────────────────────────────────

export type GithubErrorCode =
  | 'unavailable' // no Geode bridge (Obsidian / old Geode)
  | 'not_connected' // Geode has no GitHub connection (never connected, or disconnected)
  | 'reauth_required' // token expired / revoked / refresh rejected
  | 'keychain_unavailable' // Geode cannot store tokens on this machine
  | 'repo_not_granted' // connected, but the App is not installed on the repo
  | 'request_failed'; // anything else (network, GitHub 5xx)

export const GITHUB_SETTINGS_HINT = 'Open Geode → Settings → GitHub';

export class GithubConnectionError extends Error {
  constructor(
    readonly code: GithubErrorCode,
    message: string,
    readonly installUrl?: string,
  ) {
    super(message);
    this.name = 'GithubConnectionError';
  }
}

const MESSAGES: Record<Exclude<GithubErrorCode, 'repo_not_granted' | 'request_failed'>, string> = {
  unavailable:
    'The Geode GitHub connection is not available in this host (it needs Geode ≥ 0.25.0). '
    + 'Set GH_TOKEN / GITHUB_TOKEN yourself, or use a personal access token.',
  not_connected: `GitHub is not connected. ${GITHUB_SETTINGS_HINT} and choose Connect, then retry.`,
  reauth_required: `GitHub authorization expired or was revoked. ${GITHUB_SETTINGS_HINT} and reconnect, then retry.`,
  keychain_unavailable:
    'Geode cannot store GitHub tokens because no OS keychain is available, so the connection cannot be used.',
};

export function unavailableError(): GithubConnectionError {
  return new GithubConnectionError('unavailable', MESSAGES.unavailable);
}

export function repoNotGrantedError(repo: string, installUrl: string | null): GithubConnectionError {
  const where = installUrl ?? 'https://github.com/settings/installations';
  return new GithubConnectionError(
    'repo_not_granted',
    `The Geode GitHub App cannot access ${repo}. Grant it access at ${where}, then retry.`,
    installUrl ?? undefined,
  );
}

// ── Broker ────────────────────────────────────────────────────────────────────

export interface GithubProfile { id: number; login: string; name: string | null }
export type GithubProfileFetcher = (token: string) => Promise<GithubProfile>;

export interface GithubCredentialBrokerDeps {
  bridge: GithubAuthBridge | undefined;
  /** GET https://api.github.com/user, used only for commit identity. */
  fetchProfile?: GithubProfileFetcher;
  now?: () => number;
}

const PROFILE_TTL_MS = 60 * 60 * 1000;

export class GithubCredentialBroker {
  private readonly now: () => number;
  private profile: { value: GithubProfile; at: number } | null = null;

  constructor(private readonly deps: GithubCredentialBrokerDeps) {
    this.now = deps.now ?? Date.now;
  }

  get available(): boolean {
    return this.deps.bridge !== undefined;
  }

  private requireBridge(): GithubAuthBridge {
    if (!this.deps.bridge) throw unavailableError();
    return this.deps.bridge;
  }

  /** Turns a failed IPC result into the right actionable error. */
  private async toError(code: string, message: string): Promise<GithubConnectionError> {
    let status: GithubBridgeStatus | undefined;
    try { status = await this.requireBridge().status(); } catch { /* fall through */ }
    if (status?.state === 'disconnected') {
      return status.encryptionAvailable
        ? new GithubConnectionError('not_connected', MESSAGES.not_connected)
        : new GithubConnectionError('keychain_unavailable', MESSAGES.keychain_unavailable);
    }
    if (status?.state === 'reauth_required' || code === 'reauth_required') {
      return new GithubConnectionError('reauth_required', MESSAGES.reauth_required);
    }
    return new GithubConnectionError('request_failed', `GitHub request failed: ${message}`);
  }

  /** Bridge status, or null when there is no bridge. Never throws. */
  async status(): Promise<GithubBridgeStatus | null> {
    if (!this.deps.bridge) return null;
    try { return await this.deps.bridge.status(); } catch { return null; }
  }

  /**
   * A fresh token from Geode (which refreshes it when < 5 minutes remain).
   * Callers must hand it straight to a credential sink; never log or return it
   * to the model.
   */
  async getToken(): Promise<string> {
    const result = await this.requireBridge().getToken();
    if (!result.ok) throw await this.toError(result.code, result.message);
    return result.value;
  }

  async listAccess(): Promise<GithubInstallation[]> {
    const result = await this.requireBridge().listAccess();
    if (!result.ok) throw await this.toError(result.code, result.message);
    return result.value;
  }

  /** Resolves when `owner/repo` is reachable; throws `repo_not_granted` with the install URL otherwise. */
  async requireRepo(repo: string): Promise<GithubRepoCoverage> {
    const result = await this.requireBridge().checkRepo(repo);
    if (!result.ok) throw await this.toError(result.code, result.message);
    if (!result.value.covered) throw repoNotGrantedError(repo, result.value.installUrl);
    return result.value;
  }

  /**
   * The connected account's profile, cached for an hour. Uses the token only to
   * call GET /user; nothing about it is retained beyond id/login/name.
   */
  async getProfile(force = false): Promise<GithubProfile> {
    if (!force && this.profile && this.now() - this.profile.at < PROFILE_TTL_MS) return this.profile.value;
    if (!this.deps.fetchProfile) throw new GithubConnectionError('request_failed', 'No GitHub profile fetcher configured.');
    const value = await this.deps.fetchProfile(await this.getToken());
    this.profile = { value, at: this.now() };
    return value;
  }

  /** Synchronous view of the cached profile, for session-start paths that cannot await. */
  cachedProfile(): GithubProfile | null {
    return this.profile?.value ?? null;
  }

  /** Drops cached identity (on disconnect / account change). */
  forget(): void {
    this.profile = null;
  }
}

// ── Commit identity ───────────────────────────────────────────────────────────

export interface CommitIdentity { name: string; email: string }

/** GitHub's privacy-preserving address: `<id>+<login>@users.noreply.github.com`. */
export function noreplyEmail(profile: Pick<GithubProfile, 'id' | 'login'>): string {
  return `${profile.id}+${profile.login}@users.noreply.github.com`;
}

/**
 * Commit identity for the connected user. The name is the profile display name
 * (falling back to the login). The email is the noreply address unless the user
 * configured an override — the App has no permission to read private emails, so
 * the noreply address is the only one guaranteed to be attributable and private.
 */
export function resolveCommitIdentity(profile: GithubProfile, emailOverride?: string | null): CommitIdentity {
  const override = emailOverride?.trim();
  return {
    name: profile.name?.trim() || profile.login,
    email: override && /^[^\s@]+@[^\s@]+$/.test(override) ? override : noreplyEmail(profile),
  };
}

// ── Token publishing / refresh ────────────────────────────────────────────────

/** Where a token is written for the helper to read (container tmpfs file, host 0600 file). */
export interface TokenSink {
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

export type PublishState = { ok: true } | { ok: false; error: GithubConnectionError };

export interface TokenPublisherDeps {
  broker: Pick<GithubCredentialBroker, 'getToken'>;
  sink: TokenSink;
  /** Re-publish this often. Geode refreshes at < 5 min left, so 4 min is always inside the validity window. */
  intervalMs?: number;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export const DEFAULT_REFRESH_INTERVAL_MS = 4 * 60 * 1000;

/**
 * Keeps a sink populated with a valid token. On any failure to get a token the
 * sink is cleared (a revoked or disconnected connection must not leave a stale
 * credential behind), but the timer keeps running so reconnecting recovers.
 */
export class GithubTokenPublisher {
  private timer: unknown = null;
  private lastWriteAt = 0;
  private lastError: GithubConnectionError | null = null;
  private inflight: Promise<PublishState> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: TokenPublisherDeps) {
    this.now = deps.now ?? Date.now;
  }

  get error(): GithubConnectionError | null {
    return this.lastError;
  }

  /** Publishes immediately and starts the refresh timer. Idempotent. */
  async start(): Promise<PublishState> {
    const state = await this.refresh();
    if (this.timer === null) {
      const setIv = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
      this.timer = setIv(() => { void this.refresh(); }, this.deps.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);
      // Never keep the process alive for a credential refresh.
      (this.timer as { unref?: () => void } | null)?.unref?.();
    }
    return state;
  }

  /** Re-publishes if the last write is older than `maxAgeMs`; cheap enough to call before every command. */
  async ensureFresh(maxAgeMs = 60_000): Promise<PublishState> {
    if (this.lastError === null && this.lastWriteAt > 0 && this.now() - this.lastWriteAt < maxAgeMs) return { ok: true };
    return this.refresh();
  }

  refresh(): Promise<PublishState> {
    // Single-flight: the timer and a pre-exec check must not race two writes.
    this.inflight ??= this.doRefresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async doRefresh(): Promise<PublishState> {
    try {
      const token = await this.deps.broker.getToken();
      await this.deps.sink.write(token);
      this.lastWriteAt = this.now();
      this.lastError = null;
      return { ok: true };
    } catch (err) {
      const error = err instanceof GithubConnectionError
        ? err
        : new GithubConnectionError('request_failed', `GitHub credential handoff failed: ${err instanceof Error ? err.message : String(err)}`);
      this.lastError = error;
      this.lastWriteAt = 0;
      try { await this.deps.sink.clear(); } catch { /* best effort */ }
      return { ok: false, error };
    }
  }

  /** Stops the timer and deletes the published token. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      (this.deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)))(this.timer);
      this.timer = null;
    }
    this.lastWriteAt = 0;
    try { await this.deps.sink.clear(); } catch { /* best effort */ }
  }
}

// ── Redaction ─────────────────────────────────────────────────────────────────

/** Token shapes GitHub issues: ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_. */
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

/**
 * Defense in depth for tool results: masks any GitHub-token-shaped string and
 * any exact known secret. The design never puts the token in output; this
 * catches the case where a command echoes one anyway (e.g. `git remote -v` with
 * an embedded credential, or `gh auth token`).
 */
export function redactGithubSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 8) out = out.split(secret).join('[REDACTED]');
  }
  return out.replace(GITHUB_TOKEN_PATTERN, '[REDACTED]');
}

// ── Access summaries for tools ────────────────────────────────────────────────

/** Repo names only: this is what the model sees, never the token. */
export function summarizeAccess(installations: GithubInstallation[]): Array<{ account: string; repositories: string[] }> {
  return installations.map((i) => ({ account: i.account, repositories: i.repositories.map((r) => r.fullName) }));
}

export function isValidRepoFullName(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(value);
}

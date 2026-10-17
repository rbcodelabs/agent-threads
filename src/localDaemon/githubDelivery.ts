/**
 * Local daemon: delivers the Geode GitHub connection to the daemon container so
 * `git` over HTTPS and `gh` work for threads that run there.
 *
 * The daemon already knows what to do with a pushed credential: `creds push`
 * kind `github`, field `GH_TOKEN` is handed to git through an askpass script and
 * to the agent's process as `GH_TOKEN` (daemon/repos.ts). This module is the
 * missing producer, and it reuses the same pieces as host delivery:
 *
 *   GithubCredentialBroker  ->  GithubTokenPublisher  ->  sink  ->  `agent-threads creds push`
 *
 * The push runs INSIDE the container (`container exec -i`), as the daemon user:
 *
 *   - The token travels on the exec's stdin as JSON, never in argv, an env var
 *     or a log line, and is redacted from any error.
 *   - `creds push` needs an admin-scope token. It is minted inside the container
 *     and saved as `<data dir>/cli-token`, which the CLI picks up by itself, so
 *     the admin token never reaches Geode or the keychain. Whoever can read it
 *     can already read the daemon's journals and credentials (same uid).
 *   - The pushed credential expires after 15 minutes ({@link GITHUB_CREDS_TTL_SEC})
 *     and is refreshed every few minutes, so quitting Geode leaves nothing
 *     long-lived behind. It is deleted explicitly on disable and on unload.
 *   - The commit identity (name and noreply email of the connected account) is
 *     written to the daemon user's global git config, so a repository's own
 *     `user.name` / `user.email` still wins, exactly like host delivery.
 *
 * A daemon session reads the credential when it starts. A turn that outlives the
 * token's own validity (about an hour) keeps the token it started with.
 */

import {
  GithubConnectionError,
  GithubTokenPublisher,
  redactGithubSecrets,
  resolveCommitIdentity,
  type GithubCredentialBroker,
  type PublishState,
  type TokenSink,
} from '../githubCredentials';
import type { VmCommandRunner } from '../containerCli';
import { parseTokenList, tail } from './parse';
import {
  CREDS_TOKEN_NAME,
  GITHUB_CREDS_KIND,
  GITHUB_CREDS_TTL_SEC,
  GITHUB_TOKEN_FIELD,
  cliTokenCreateArgs,
  cliTokenPresentArgs,
  containerNameFor,
  credsPushArgs,
  credsRemoveArgs,
  gitConfigSetArgs,
  tokenListArgs,
  tokenRevokeArgs,
} from './spec';

const EXEC_TIMEOUT_MS = 30_000;

export interface LocalDaemonGithubDeps {
  broker: Pick<GithubCredentialBroker, 'available' | 'getToken' | 'getProfile'>;
  /** The "Use Geode GitHub connection" setting. */
  isEnabled(): boolean;
  /** Absolute vault path (it names the container), or null where there is none. */
  vaultPath(): string | null;
  /** Built lazily so it finds the managed `container` binary once the runtime is installed. */
  runner(): VmCommandRunner;
  /** The "GitHub commit email" setting. */
  getEmailOverride?(): string | undefined;
  log?(message: string): void;
  /** Test seams, forwarded to the publisher. */
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export type LocalDaemonGithubState = 'skipped' | PublishState;

export class LocalDaemonGithubDelivery {
  private publisher: GithubTokenPublisher | null = null;
  /** Something is stored in the daemon that `stop()` must remove. */
  private wrote = false;
  /** Containers whose admin token for `creds push` is known to exist. */
  private readonly cliTokenReady = new Set<string>();
  private lastIdentity = '';

  constructor(private readonly deps: LocalDaemonGithubDeps) {}

  private get active(): boolean {
    return this.deps.broker.available && this.deps.isEnabled() && this.deps.vaultPath() !== null;
  }

  /**
   * Makes sure the daemon holds a fresh GitHub token. Cheap to call before every
   * send (it only talks to the container when the last push is older than a
   * minute). Never throws: GitHub access is a convenience, not a precondition.
   */
  async ensureFresh(): Promise<LocalDaemonGithubState> {
    if (!this.active) {
      await this.stop();
      return 'skipped';
    }
    try {
      if (!this.publisher) {
        this.publisher = new GithubTokenPublisher({
          broker: this.deps.broker,
          sink: this.sink(),
          ...(this.deps.now ? { now: this.deps.now } : {}),
          ...(this.deps.setInterval ? { setInterval: this.deps.setInterval } : {}),
          ...(this.deps.clearInterval ? { clearInterval: this.deps.clearInterval } : {}),
        });
        return await this.report(await this.publisher.start());
      }
      return await this.report(await this.publisher.ensureFresh());
    } catch (err) {
      this.deps.log?.(`[local-daemon] GitHub delivery failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: new GithubConnectionError('request_failed', `GitHub credential handoff failed: ${err instanceof Error ? err.message : String(err)}`) };
    }
  }

  /** Stops refreshing and removes the credential from the daemon (best effort). */
  async stop(): Promise<void> {
    const publisher = this.publisher;
    this.publisher = null;
    try { await publisher?.stop(); } catch { /* best effort */ }
    // Covers the case where the publisher never existed in this session but a push did.
    if (!publisher && this.wrote) await this.removeCredential();
  }

  private async report(state: PublishState): Promise<PublishState> {
    if (!state.ok) this.deps.log?.(`[local-daemon] GitHub token not delivered: ${state.error.message}`);
    return state;
  }

  private sink(): TokenSink {
    return {
      write: (token) => this.push(token),
      clear: () => this.removeCredential(),
    };
  }

  private containerName(): string {
    const vault = this.deps.vaultPath();
    if (!vault) throw new Error('No vault folder, so there is no local daemon.');
    return containerNameFor(vault);
  }

  private async push(token: string): Promise<void> {
    const name = this.containerName();
    const run = this.deps.runner();
    for (let attempt = 0; ; attempt++) {
      await this.ensureCliToken(name);
      const r = await run(credsPushArgs(name, GITHUB_CREDS_KIND, GITHUB_CREDS_TTL_SEC), {
        timeoutMs: EXEC_TIMEOUT_MS,
        input: JSON.stringify({ [GITHUB_TOKEN_FIELD]: token }),
      });
      if (r.exitCode === 0) break;
      // The data volume may have been reset, taking cli-token with it: mint a new one and retry once.
      this.cliTokenReady.delete(name);
      if (attempt >= 1) {
        const detail = redactGithubSecrets(tail(`${r.stderr}\n${r.stdout}`.trim()), [token]);
        throw new Error(`pushing the token to the local daemon failed (exit ${r.exitCode}): ${detail}`);
      }
    }
    this.wrote = true;
    await this.applyIdentity(name);
  }

  private async removeCredential(): Promise<void> {
    if (!this.wrote) return;
    this.wrote = false;
    try {
      const name = this.containerName();
      await this.deps.runner()(credsRemoveArgs(name, GITHUB_CREDS_KIND), { timeoutMs: EXEC_TIMEOUT_MS });
    } catch { /* the daemon may be stopped: the 15 minute expiry covers it */ }
  }

  /** Mints and saves the admin token `creds push` authenticates with. Idempotent. */
  private async ensureCliToken(name: string): Promise<void> {
    if (this.cliTokenReady.has(name)) return;
    const run = this.deps.runner();
    if ((await run(cliTokenPresentArgs(name), { timeoutMs: EXEC_TIMEOUT_MS })).exitCode === 0) {
      this.cliTokenReady.add(name);
      return;
    }
    // No saved token means a fresh or reset data volume: its git config is gone too.
    this.lastIdentity = '';
    // Revoke any earlier token of ours (its plaintext copy is gone) before minting the replacement.
    const list = await run(tokenListArgs(name), { timeoutMs: EXEC_TIMEOUT_MS });
    if (list.exitCode !== 0) throw new Error('The local daemon container is not running.');
    for (const t of parseTokenList(list.stdout)) {
      if (t.name === CREDS_TOKEN_NAME && !t.revoked) await run(tokenRevokeArgs(name, t.id), { timeoutMs: EXEC_TIMEOUT_MS });
    }
    const create = await run(cliTokenCreateArgs(name), { timeoutMs: EXEC_TIMEOUT_MS });
    if (create.exitCode !== 0) {
      // `--save` prints no token, but stay safe: show only the tail of stderr.
      throw new Error(`creating the daemon's credential-push token failed (exit ${create.exitCode}): ${tail(create.stderr)}`);
    }
    this.cliTokenReady.add(name);
  }

  /** Writes the connected account's commit identity to the daemon user's global git config, once per change. */
  private async applyIdentity(name: string): Promise<void> {
    try {
      const identity = resolveCommitIdentity(await this.deps.broker.getProfile(), this.deps.getEmailOverride?.());
      const key = `${name}\n${identity.name}\n${identity.email}`;
      if (key === this.lastIdentity) return;
      const run = this.deps.runner();
      const a = await run(gitConfigSetArgs(name, 'user.name', identity.name), { timeoutMs: EXEC_TIMEOUT_MS });
      const b = await run(gitConfigSetArgs(name, 'user.email', identity.email), { timeoutMs: EXEC_TIMEOUT_MS });
      if (a.exitCode === 0 && b.exitCode === 0) this.lastIdentity = key;
    } catch (err) {
      // Authentication works without an identity; commits then fall back to whatever the repository configures.
      this.deps.log?.(`[local-daemon] commit identity not applied: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

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
  resolveCommitIdentity,
  type GithubCredentialBroker,
  type PublishState,
  type TokenSink,
} from '../githubCredentials';
import type { VmCommandRunner } from '../containerCli';
import { CredsPusher } from './credsPusher';
import { GITHUB_CREDS_KIND, GITHUB_CREDS_TTL_SEC, GITHUB_TOKEN_FIELD, gitConfigSetArgs } from './spec';

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
  private lastIdentity = '';
  private readonly pusher: CredsPusher;

  constructor(private readonly deps: LocalDaemonGithubDeps) {
    this.pusher = new CredsPusher({ vaultPath: deps.vaultPath, runner: deps.runner, onFreshVolume: () => { this.lastIdentity = ''; } });
  }

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

  private async push(token: string): Promise<void> {
    await this.pusher.push(GITHUB_CREDS_KIND, { [GITHUB_TOKEN_FIELD]: token }, GITHUB_CREDS_TTL_SEC);
    this.wrote = true;
    await this.applyIdentity(this.pusher.containerName());
  }

  private async removeCredential(): Promise<void> {
    if (!this.wrote) return;
    this.wrote = false;
    await this.pusher.remove(GITHUB_CREDS_KIND);
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

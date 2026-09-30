/**
 * githubHostDelivery.ts — the Geode GitHub connection for host-side thread
 * sessions (Claude / Codex / OpenCode subprocesses and the Bash tool).
 *
 * Desktop only: Node's `fs`/`os`/`path`/`child_process` are required lazily so
 * importing this file is inert on mobile.
 *
 * On `start()` a per-process 0700 directory is created holding the same helper
 * and `gh` wrapper the container uses, plus a 0600 token file that a
 * `GithubTokenPublisher` keeps fresh. `resolveEnv()` (synchronous, called at
 * session start) returns environment additions:
 *
 *   - GIT_CONFIG_* adding the credential helper. `credential.helper` is
 *     multi-valued and ours is appended last, so the user's existing helpers
 *     (osxkeychain, gh, store, …) are consulted first and keep working.
 *   - PATH with the `gh` wrapper first. The wrapper yields to GH_TOKEN /
 *     GITHUB_TOKEN and to an existing `gh auth login`.
 *   - user.name / user.email via GIT_CONFIG_*, ONLY when the repo has none
 *     configured (environment config would otherwise override the user's own).
 *
 * The token itself is never placed in the environment. It reaches the helper
 * through the file, which is deleted on `stop()`, on disconnect, and whenever a
 * token cannot be obtained.
 */
import {
  GithubTokenPublisher,
  resolveCommitIdentity,
  type CommitIdentity,
  type GithubCredentialBroker,
  type PublishState,
  type TokenSink,
} from './githubCredentials';
import {
  buildGhWrapperScript,
  buildGitHelperScript,
  buildHostGitEnv,
  GIT_HELPER_NAME,
} from './githubCredentialHelper';

/** The slice of Node used here, injectable for tests. */
export interface HostFs {
  mkdtemp(prefix: string): string;
  mkdirp(dir: string): void;
  writeFile(path: string, data: string, mode: number): void;
  rename(from: string, to: string): void;
  rm(path: string): void;
  rmdir(path: string): void;
}

export interface GithubHostDeliveryDeps {
  broker: GithubCredentialBroker;
  isEnabled: () => boolean;
  getEmailOverride?: () => string | undefined;
  /** `git config --get <key>` in `cwd`; undefined when unset. */
  gitConfigGet?: (cwd: string, key: string) => string | undefined;
  fs?: HostFs;
  tmpdir?: () => string;
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  now?: () => number;
}

export function createNodeHostFs(): HostFs {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require('fs') as typeof import('fs');
  return {
    mkdtemp: (prefix) => fs.mkdtempSync(prefix),
    mkdirp: (dir) => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); },
    writeFile: (path, data, mode) => { fs.writeFileSync(path, data, { mode }); fs.chmodSync(path, mode); },
    rename: (from, to) => fs.renameSync(from, to),
    rm: (path) => fs.rmSync(path, { force: true }),
    rmdir: (path) => fs.rmSync(path, { recursive: true, force: true }),
  };
  /* eslint-enable @typescript-eslint/no-require-imports */
}

export function createNodeGitConfigGet(): (cwd: string, key: string) => string | undefined {
  return (cwd, key) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execFileSync } = require('child_process') as typeof import('child_process');
      const out = execFileSync('git', ['-C', cwd, 'config', '--get', key], {
        encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out || undefined;
    } catch {
      return undefined; // exit 1 = unset; missing git = also "not configured"
    }
  };
}

export class GithubHostDelivery {
  private dir: string | null = null;
  private publisher: GithubTokenPublisher | null = null;
  private readonly fs: HostFs;

  constructor(private readonly deps: GithubHostDeliveryDeps) {
    this.fs = deps.fs ?? createNodeHostFs();
  }

  get running(): boolean {
    return this.dir !== null;
  }

  get runtimeDir(): string | null {
    return this.dir;
  }

  /** Creates the runtime dir and starts publishing. No-op when disabled or there is no Geode bridge. */
  async start(): Promise<PublishState | null> {
    if (this.dir || !this.deps.isEnabled() || !this.deps.broker.available) return null;
    const base = (this.deps.tmpdir ?? (() => (require('os') as typeof import('os')).tmpdir()))();
    const dir = this.fs.mkdtemp(`${base.replace(/\/$/, '')}/claude-threads-github-`);
    this.fs.mkdirp(`${dir}/bin`);
    this.fs.writeFile(`${dir}/${GIT_HELPER_NAME}`, buildGitHelperScript(dir), 0o700);
    this.fs.writeFile(`${dir}/bin/gh`, buildGhWrapperScript(dir, true), 0o700);
    this.dir = dir;

    const sink: TokenSink = {
      write: async (token) => {
        // Write-then-rename so a reader never sees a partial token.
        this.fs.writeFile(`${dir}/token.tmp`, token, 0o600);
        this.fs.rename(`${dir}/token.tmp`, `${dir}/token`);
      },
      clear: async () => { this.fs.rm(`${dir}/token`); this.fs.rm(`${dir}/token.tmp`); },
    };
    this.publisher = new GithubTokenPublisher({
      broker: this.deps.broker,
      sink,
      intervalMs: this.deps.intervalMs,
      now: this.deps.now,
      setInterval: this.deps.setInterval,
      clearInterval: this.deps.clearInterval,
    });
    const state = await this.publisher.start();
    // Prefetch identity so the synchronous resolveEnv() can use it. Best effort.
    if (state.ok) await this.deps.broker.getProfile().catch(() => undefined);
    return state;
  }

  /** Deletes the token and the runtime dir. Called on plugin unload. */
  async stop(): Promise<void> {
    await this.publisher?.stop();
    if (this.dir) this.fs.rmdir(this.dir);
    this.publisher = null;
    this.dir = null;
  }

  /** Last publishing problem, for surfacing in settings. */
  get error() {
    return this.publisher?.error ?? null;
  }

  /** Commit identity for `cwd`, or null when the repo already has one configured (or none is known). */
  private identityFor(cwd: string): Partial<CommitIdentity> | null {
    const profile = this.deps.broker.cachedProfile();
    if (!profile) return null;
    const get = this.deps.gitConfigGet ?? createNodeGitConfigGet();
    const identity = resolveCommitIdentity(profile, this.deps.getEmailOverride?.());
    // Never override what the user configured: env-scope config beats file config,
    // so each field is supplied only when the repo has no value for it.
    const out: Partial<CommitIdentity> = {};
    if (!get(cwd, 'user.name')) out.name = identity.name;
    if (!get(cwd, 'user.email')) out.email = identity.email;
    return out;
  }

  /** Synchronous env additions for a session starting in `cwd`. Empty when not running or disabled. */
  resolveEnv(cwd: string, baseEnv: Record<string, string | undefined>): Record<string, string> {
    if (!this.dir || !this.deps.isEnabled()) return {};
    return buildHostGitEnv({ dir: this.dir, baseEnv, identity: this.identityFor(cwd) });
  }
}

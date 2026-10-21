/**
 * Local daemon: everything a session on the managed daemon needs from this Mac, prepared right before it starts.
 *
 * The removed per-thread sandbox VM got these from the host process that owned it; the daemon is a separate long-lived
 * machine, so each one is carried over a channel the daemon already trusts:
 *
 *   environment    Extra environment variables (AWS_PROFILE, CLAUDE_CODE_USE_BEDROCK, ...) and the project's keychain
 *                  secrets are pushed as a credential kind `sessenv-<project>` with `creds push` (stdin, TTL). The
 *                  session spec carries only the kind's NAME; the daemon reads the values when the session starts, so
 *                  they are never in the spec, a journal, `config.json` or a log.
 *   skills         Skill plugin directories and `~/.claude/skills|agents` are copied into the data volume; the spec
 *                  carries the guest paths of the plugin directories.
 *   AWS            a trimmed `~/.aws/config` and the SSO token file(s) of the allowed profiles are copied into the
 *                  daemon user's home (see awsCopy.ts).
 *
 * `prepare()` never throws: a failure of any one part is logged and reported in `warnings`, and the session still
 * starts without it (exactly as a missing GitHub token does).
 */

import type { VmCommandRunner } from '../containerCli';
import { planAwsCopy, daemonAwsEnv, type AwsCopyFs } from './awsCopy';
import {
  copyFilesToContainer,
  listDirArgs,
  loadTree,
  scanTree,
  removeDirArgs,
  shortHash,
  type FsLike,
} from './containerFiles';
import { EnvKindDelivery, forwardableEnv, sessionEnvKind } from '../credsDelivery';
import { CredsPusher } from './credsPusher';
import {
  AWS_HOME_DIR,
  CLAUDE_HOME_DIR,
  SESSION_ENV_TTL_SEC,
  SKILLS_DIR,
} from './spec';

export { forwardableEnv };

export interface SessionExtras {
  /** Name of the credential kind holding the session environment; absent when there is none to send. */
  envKind?: string;
  /** Guest paths of the skill plugin directories. */
  pluginPaths: string[];
  warnings: string[];
}

export interface SessionPrepDeps {
  vaultPath(): string | null;
  runner(): VmCommandRunner;
  /** Extra environment variables plus the keychain secrets visible to `projectId`, as the host would give a session. */
  resolveEnv(projectId: string | undefined): Record<string, string>;
  /** Skill plugin directories (host paths) a session on the host would load. */
  skillPlugins(): Array<{ type: 'local'; path: string }>;
  homeDir(): string;
  /** Profiles to expose (see `resolveDaemonAwsProfiles`); empty disables AWS delivery. */
  awsProfiles(): string[];
  hostAwsConfigPath?(): string | undefined;
  fs: FsLike;
  awsFs: AwsCopyFs;
  now?: () => number;
  log?(message: string): void;
}

const ENV_REFRESH_MS = 6 * 60 * 60_000;
const AWS_REFRESH_MS = 5 * 60_000;

export class LocalDaemonSessionPrep {
  private readonly pusher: CredsPusher;
  private readonly now: () => number;
  /** Change detection and TTL refresh of the pushed session environment (shared with remote daemons). */
  private readonly env: EnvKindDelivery;
  private awsState: { hash: string; at: number } | null = null;
  private userSkills = new Map<string, string>();
  private readonly skillDirs = new Set<string>();

  constructor(private readonly deps: SessionPrepDeps) {
    this.now = deps.now ?? Date.now;
    this.pusher = new CredsPusher({
      vaultPath: deps.vaultPath,
      runner: deps.runner,
      // A fresh data volume has none of what we copied or pushed before.
      onFreshVolume: () => { this.env.clear(); this.awsState = null; this.userSkills.clear(); this.skillDirs.clear(); },
    });
    this.env = new EnvKindDelivery(this.pusher, { refreshMs: ENV_REFRESH_MS, now: this.now });
  }

  async prepare(projectId: string | undefined): Promise<SessionExtras> {
    const extras: SessionExtras = { pluginPaths: [], warnings: [] };
    if (!this.deps.vaultPath()) return extras;
    const attempt = async (what: string, fn: () => Promise<void>): Promise<void> => {
      try { await fn(); } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        extras.warnings.push(`${what}: ${message}`);
        this.deps.log?.(`[local-daemon] ${what} not delivered: ${message}`);
      }
    };
    await attempt('data volume check', () => this.pusher.verifyVolume());
    await attempt('session environment', async () => { extras.envKind = await this.deliverEnv(projectId); });
    await attempt('skills', async () => { extras.pluginPaths = await this.deliverSkills(); });
    await attempt('AWS credentials', async () => { await this.deliverAws(extras.warnings); });
    return extras;
  }

  /** Removes what was pushed or copied, best effort. */
  async stop(): Promise<void> {
    await this.env.stop();
    if (this.awsState) {
      this.awsState = null;
      try { await this.deps.runner()(removeDirArgs(this.pusher.containerName(), AWS_HOME_DIR), { timeoutMs: 30_000 }); } catch { /* best effort */ }
    }
  }

  // ── environment ──────────────────────────────────────────────────────────

  private async deliverEnv(projectId: string | undefined): Promise<string | undefined> {
    const kind = sessionEnvKind(projectId);
    const base = forwardableEnv(this.deps.resolveEnv(projectId));
    const profiles = this.deps.awsProfiles();
    const env = { ...base, ...daemonAwsEnv(profiles.length > 0, base) };
    return (await this.env.deliver(kind, env, SESSION_ENV_TTL_SEC)) ? kind : undefined;
  }

  // ── skills ───────────────────────────────────────────────────────────────

  private async deliverSkills(): Promise<string[]> {
    const name = this.pusher.containerName();
    const run = this.deps.runner();
    const existing = new Set((await run(listDirArgs(name, SKILLS_DIR), { timeoutMs: 20_000 })).stdout.split('\n').map((l) => l.trim()).filter(Boolean));
    const pluginPaths: string[] = [];
    const seen = new Set<string>();
    for (const plugin of this.deps.skillPlugins()) {
      let real: string;
      try { real = this.deps.fs.realpath(plugin.path); } catch { continue; }
      if (seen.has(real)) continue;
      seen.add(real);
      const tree = scanTree(this.deps.fs, real);
      if (tree.entries.length === 0) continue;
      const base = real.split('/').filter(Boolean).slice(-2).join('-').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'skills';
      // The fingerprint is part of the name: an existing directory of that name is already up to date.
      const dir = `${base}-${shortHash(`${real}\n${tree.fingerprint}`)}`;
      const dest = `${SKILLS_DIR}/${dir}`;
      if (!existing.has(dir) && !this.skillDirs.has(dir)) {
        await copyFilesToContainer(run, name, dest, loadTree(this.deps.fs, tree), { clean: true });
        this.skillDirs.add(dir);
      }
      pluginPaths.push(dest);
    }
    await this.syncUserDir('skills', `${this.deps.homeDir().replace(/\/+$/, '')}/.claude/skills`, name, run);
    await this.syncUserDir('agents', `${this.deps.homeDir().replace(/\/+$/, '')}/.claude/agents`, name, run);
    return pluginPaths;
  }

  /** `~/.claude/skills` and `~/.claude/agents` are read by the CLI from $HOME, so they go to the daemon user's home. */
  private async syncUserDir(kind: 'skills' | 'agents', hostDir: string, name: string, run: VmCommandRunner): Promise<void> {
    let real: string;
    try { real = this.deps.fs.realpath(hostDir); } catch { return; }
    const tree = scanTree(this.deps.fs, real);
    if (tree.entries.length === 0) return;
    if (this.userSkills.get(kind) === tree.fingerprint) return;
    await copyFilesToContainer(run, name, `${CLAUDE_HOME_DIR}/${kind}`, loadTree(this.deps.fs, tree), { clean: true });
    this.userSkills.set(kind, tree.fingerprint);
  }

  // ── AWS ──────────────────────────────────────────────────────────────────

  private async deliverAws(warnings: string[]): Promise<void> {
    const profiles = this.deps.awsProfiles();
    const plan = profiles.length === 0 ? null : planAwsCopy({
      profiles,
      homeDir: this.deps.homeDir(),
      ...(this.deps.hostAwsConfigPath?.() ? { hostConfigPath: this.deps.hostAwsConfigPath()! } : {}),
      fs: this.deps.awsFs,
    });
    if (!plan || plan.files.length === 0) {
      if (plan) warnings.push(...plan.warnings);
      if (this.awsState) {
        this.awsState = null;
        await this.deps.runner()(removeDirArgs(this.pusher.containerName(), AWS_HOME_DIR), { timeoutMs: 30_000 });
      }
      return;
    }
    warnings.push(...plan.warnings);
    const hash = shortHash(JSON.stringify(plan.files.map((f) => [f.p, f.b])));
    if (this.awsState && this.awsState.hash === hash && this.now() - this.awsState.at < AWS_REFRESH_MS) return;
    await copyFilesToContainer(this.deps.runner(), this.pusher.containerName(), AWS_HOME_DIR, plan.files, { clean: true });
    this.awsState = { hash, at: this.now() };
  }
}

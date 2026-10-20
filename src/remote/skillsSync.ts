/**
 * Delivers the skill plugin directories Threads controls (`buildHostSkillPlugins()`) to a plain remote daemon over its
 * WebSocket (`skills.sync` / `skills.put` / `skills.commit`, see src/protocol/skills.ts and docs/remote-daemon.md).
 *
 * The managed local-container daemon keeps its own path (`container exec`, src/localDaemon/sessionPrep.ts); this is for
 * every other daemon. Nothing user-level is sent: no `~/.claude/skills` or `~/.claude/agents`, and the daemon writes
 * nothing under `~/.claude`.
 *
 * `prepare()` never throws and never blocks a send for long: any failure becomes a notice for the thread and the
 * session starts with whatever trees did land. Pure apart from the injected `fs` and `sha256`.
 */
import {
  SKILL_LIMITS,
  SKILLS_SYNC_CAPABILITY,
  normalizeSkillMode,
  skillDirName,
  skillTreeHash,
  type Sha256Like,
  type SkillTreeManifest,
  type SkillWireFile,
} from '../protocol/skills';
import { loadTree, scanTree, type FsLike } from '../localDaemon/containerFiles';
import type { RemoteDaemonConfig } from '../types';
import { DaemonCommandError } from './DaemonClient';
import type { RemoteDaemonResolver } from './DaemonRegistry';

export type SkillsSyncMode = 'auto' | 'off' | 'n/a';

/**
 * The one place the setting is read. Missing = automatic; an unrecognised value (a newer build's mode) fails closed;
 * the managed local-container daemon is not handled here.
 */
export function resolveSkillsSyncMode(daemon: Pick<RemoteDaemonConfig, 'managed'> & { skillsSync?: unknown } | undefined): SkillsSyncMode {
  if (!daemon || daemon.managed === 'local-container') return 'n/a';
  if (daemon.skillsSync === undefined || daemon.skillsSync === 'auto') return 'auto';
  return 'off';
}

/** Whole sync, including a daemon that has to be reached first. */
export const SKILLS_SYNC_BUDGET_MS = 30_000;
/** A single file travels in one frame (the 16 MiB frame cap, after base64). */
export const MAX_SKILL_FILE_BYTES = 8 * 1024 * 1024;

export interface SkillsSyncResult {
  /** Absolute paths on the daemon for the session spec; only trees that are present there. */
  pluginPaths: string[];
  /** One line each, for the thread. Empty when nothing is worth saying. */
  notices: string[];
}

export interface RemoteSkillsSyncDeps {
  resolver: Pick<RemoteDaemonResolver, 'clientFor' | 'nameOf' | 'warm'>;
  skillPlugins: () => Array<{ path: string }>;
  fs: FsLike;
  sha256: () => Sha256Like;
  newUploadId?: () => string;
  now?: () => number;
  log?: (message: string) => void;
}

interface Manifest extends SkillTreeManifest {
  fingerprint: string;
  real: string;
}

export class RemoteSkillsSync {
  /** Source path -> manifest, valid while the cheap fingerprint (names, sizes, mtimes) is unchanged. */
  private readonly manifests = new Map<string, Manifest>();
  /** `daemonId|epoch` pairs already told that the daemon predates skill sync. */
  private readonly toldNoCapability = new Set<string>();

  constructor(private readonly deps: RemoteSkillsSyncDeps) {}

  async prepare(daemon: RemoteDaemonConfig | undefined): Promise<SkillsSyncResult> {
    const result: SkillsSyncResult = { pluginPaths: [], notices: [] };
    if (!daemon || resolveSkillsSyncMode(daemon) !== 'auto') return result;
    const now = this.deps.now ?? Date.now;
    const deadline = now() + SKILLS_SYNC_BUDGET_MS;
    const name = this.deps.resolver.nameOf(daemon.id) || daemon.name;
    const fail = (reason: string): SkillsSyncResult => {
      result.notices.push(`Skills not synced to ${name}: ${reason}`);
      this.deps.log?.(`[skills-sync] ${daemon.id}: ${reason}`);
      return result;
    };
    try {
      const client = this.deps.resolver.clientFor(daemon.id);
      if (!client) return fail('this daemon is no longer configured');
      const trees = this.manifestsFor(result.notices, name);
      if (trees.length === 0) return result;
      await this.deps.resolver.warm?.(daemon.id, Math.min(4000, Math.max(0, deadline - now())));
      const info = client.daemonInfo;
      if (!info) return fail('the daemon is not reachable');
      if (!info.capabilities.includes(SKILLS_SYNC_CAPABILITY)) {
        const key = `${daemon.id}|${info.epoch}`;
        if (!this.toldNoCapability.has(key)) {
          this.toldNoCapability.add(key);
          result.notices.push(`Skills not synced to ${name}: this daemon predates skill sync. Update the daemon.`);
        }
        return result;
      }
      const left = (): number => {
        const ms = deadline - now();
        if (ms <= 0) throw new DaemonCommandError('timeout', 'timed out');
        return ms;
      };
      // The daemon rejects more than SKILL_LIMITS.maxTrees per call; sync() is stateless, so batch and merge.
      let root = '';
      const have = new Set<string>();
      for (let i = 0; i < trees.length; i += SKILL_LIMITS.maxTrees) {
        const batch = trees.slice(i, i + SKILL_LIMITS.maxTrees).map(({ dir, hash, files, bytes }) => ({ dir, hash, files, bytes }));
        const plan = await client.command('skills.sync', { trees: batch }, { timeoutMs: left() });
        const batchRoot = typeof plan.root === 'string' && plan.root.startsWith('/') ? plan.root.replace(/\/+$/, '') : '';
        if (!batchRoot || (root && batchRoot !== root)) return fail('the daemon sent no skills directory');
        root = batchRoot;
        if (Array.isArray(plan.have)) for (const d of plan.have as unknown[]) if (typeof d === 'string') have.add(d);
      }
      let uploaded = 0;
      const problems: string[] = [];
      for (const tree of trees) {
        if (!have.has(tree.dir)) {
          try {
            await this.upload(client, tree, left);
            uploaded++;
          } catch (err) {
            problems.push(`${tree.dir.replace(/-[0-9a-f]{12}$/, '')}: ${describeError(err)}`);
            continue;
          }
        }
        result.pluginPaths.push(`${root}/${tree.dir}`);
      }
      if (problems.length) {
        result.notices.push(`Skills not synced to ${name}: ${problems.join('; ')}`);
        this.deps.log?.(`[skills-sync] ${daemon.id}: ${problems.join('; ')}`);
      }
      if (uploaded > 0) result.notices.push(`Synced ${uploaded} skill folder${uploaded === 1 ? '' : 's'} to ${name}.`);
      return result;
    } catch (err) {
      result.pluginPaths = [];
      return fail(describeError(err));
    }
  }

  /** Manifests of every skill tree that can be sent; the rest are left out with a notice. */
  private manifestsFor(notices: string[], daemonName: string): Manifest[] {
    const { fs, sha256 } = this.deps;
    const out: Manifest[] = [];
    const seen = new Set<string>();
    const skippedNames: string[] = [];
    for (const plugin of this.deps.skillPlugins()) {
      let real: string;
      try { real = fs.realpath(plugin.path); } catch { continue; }
      if (seen.has(real)) continue;
      seen.add(real);
      const scan = scanTree(fs, real);
      if (scan.entries.length === 0 && scan.skipped.length === 0) continue;
      const label = real.split('/').filter(Boolean).pop() ?? real;
      if (scan.skipped.length > 0 || scan.entries.some((e) => e.size > MAX_SKILL_FILE_BYTES)) { skippedNames.push(label); continue; }
      const cached = this.manifests.get(real);
      if (cached && cached.fingerprint === scan.fingerprint) { out.push(cached); continue; }
      const files = loadTree(fs, scan);
      const data = files.map((f) => ({ p: f.p, m: f.m ?? 0o644, data: decodeBase64(f.b) }));
      if (data.length === 0) continue;
      const hash = skillTreeHash(data, sha256());
      const bytes = data.reduce((n, f) => n + f.data.length, 0);
      const manifest: Manifest = { dir: skillDirName(real, hash), hash, files: files.length, bytes, fingerprint: scan.fingerprint, real };
      this.manifests.set(real, manifest);
      out.push(manifest);
    }
    if (skippedNames.length) notices.push(`Skills not synced to ${daemonName}: ${skippedNames.join(', ')} ${skippedNames.length === 1 ? 'is' : 'are'} over the size limits (${SKILL_LIMITS.maxFiles} files, ${SKILL_LIMITS.maxBytes / 1048576} MiB).`);
    return out;
  }

  private async upload(client: NonNullable<ReturnType<RemoteDaemonResolver['clientFor']>>, tree: Manifest, left: () => number): Promise<void> {
    const { fs, sha256 } = this.deps;
    const scan = scanTree(fs, tree.real);
    const loaded = loadTree(fs, scan);
    const files = loaded.map((f) => ({ p: f.p, m: normalizeSkillMode(f.m ?? 0o644), b64: f.b, size: decodeBase64(f.b).length }));
    if (skillTreeHash(loaded.map((f) => ({ p: f.p, m: f.m ?? 0o644, data: decodeBase64(f.b) })), sha256()) !== tree.hash) {
      this.manifests.delete(tree.real);
      throw new Error('changed while syncing; it will sync on the next session');
    }
    const upload = this.deps.newUploadId?.() ?? randomId();
    let seq = 0;
    for (const chunk of chunkFiles(files)) {
      await client.command('skills.put', { upload, dir: tree.dir, seq: seq++, files: chunk }, { timeoutMs: left() });
    }
    await client.command('skills.commit', { upload, dir: tree.dir, hash: tree.hash, files: tree.files, bytes: tree.bytes }, { timeoutMs: left() });
  }
}

/** Groups files into frames of at most `chunkBytes` of content (one oversized file travels alone). */
export function chunkFiles(files: ReadonlyArray<SkillWireFile & { size: number }>, chunkBytes: number = SKILL_LIMITS.chunkBytes): SkillWireFile[][] {
  const chunks: SkillWireFile[][] = [];
  let current: SkillWireFile[] = [];
  let used = 0;
  for (const f of files) {
    if (current.length > 0 && used + f.size > chunkBytes) { chunks.push(current); current = []; used = 0; }
    current.push({ p: f.p, m: f.m, b64: f.b64 });
    used += f.size;
  }
  if (current.length > 0) chunks.push(current);
  // An empty tree still needs its staging directory to exist before commit.
  return chunks.length ? chunks : [[]];
}

function decodeBase64(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

function randomId(): string {
  return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
}

function describeError(err: unknown): string {
  if (err instanceof DaemonCommandError) {
    if (err.code === 'forbidden') return 'syncing skills needs an admin token for this daemon';
    if (err.code === 'unknown_command') return 'this daemon predates skill sync. Update the daemon.';
    if (err.code === 'timeout') return 'timed out';
    if (err.code === 'unreachable' || err.code === 'closed') return 'the daemon is not reachable';
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

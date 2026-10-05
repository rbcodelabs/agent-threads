/**
 * skillMounts.ts — makes skills visible to a VM-routed Claude harness (ADR-0015).
 *
 * `buildSkillPlugins` returns HOST absolute paths, and the CLI also reads
 * `$HOME/.claude/skills`. A containerized `claude` only sees the thread cwd at
 * /work, so both silently vanish. This module plans extra READ-ONLY bind
 * mounts and the host->guest path mapping used to rewrite `opts.plugins`.
 *
 * Pure: no Obsidian imports, and the filesystem is injected (`MountFs`) so it
 * is unit-testable without a real disk or a `container` runtime. Host-local
 * (non-routed) sessions never call into this module.
 *
 * Guest path scheme (deterministic, so a resumed session sees the same paths):
 *   - plugin roots           -> /skills/<basename>-<10 hex of FNV-1a(realpath)>
 *   - ~/.claude/skills|agents -> /home/node/.claude/skills|agents
 *   - symlink targets that escape a mounted root are mounted where the link
 *     resolves inside the guest (relative link) or at the identical path
 *     (absolute link), restricted to /skills, /home/node and the host home
 *     directory so a hostile link can never shadow system paths.
 */
import * as nodePath from 'path';

export const SKILLS_GUEST_ROOT = '/skills';
/** Home of the non-root `node` user in the harness image (sandbox/Dockerfile.harness). */
export const GUEST_HOME = '/home/node';

/**
 * One bind mount. Read-only unless `readWrite` is set; the only read-write
 * mount today is the vault at /vault (see `resolveVaultMount`).
 */
export interface VmExtraMount {
  hostPath: string;
  guestPath: string;
  /** Mount writable. Omitted/false means `:ro`. */
  readWrite?: boolean;
}

export interface SkillMountPlan {
  mounts: VmExtraMount[];
  /** host plugin path (as given to `plugins`) -> guest path of its mounted real directory. */
  pluginGuestPaths: Record<string, string>;
}

export interface LocalPlugin { type: 'local'; path: string }

export interface MountFs {
  /** Fully resolved path, or null when the path does not exist. */
  realpath(p: string): string | null;
  isDirectory(p: string): boolean;
  /** Immediate children of `dir` that are symlinks, with their raw link text. Empty when unreadable. */
  childSymlinks(dir: string): Array<{ name: string; linkText: string }>;
}

/** Real-disk implementation. `fs` is required lazily so merely importing this module stays cheap. */
export function nodeMountFs(): MountFs {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  return {
    realpath: (p) => { try { return fs.realpathSync(p); } catch { return null; } },
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    childSymlinks: (dir) => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isSymbolicLink())
          .map((e) => ({ name: e.name, linkText: fs.readlinkSync(nodePath.join(dir, e.name)) }));
      } catch { return []; }
    },
  };
}

/** Two independently seeded 32-bit FNV-1a hashes, hex. Not cryptographic — just a stable path tag. */
function fnv1a64Hex(input: string): string {
  const hash = (seed: number): string => {
    let h = seed >>> 0;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return hash(0x811c9dc5) + hash(0x9747b28c);
}

function safeBasename(p: string): string {
  const base = nodePath.posix.basename(p).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return base || 'plugin';
}

function isWithin(child: string, parent: string): boolean {
  const rel = nodePath.posix.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !nodePath.posix.isAbsolute(rel));
}

/** Rejects the volume delimiter and anything that is not a clean absolute path. */
function mountablePath(p: string): boolean {
  return nodePath.posix.isAbsolute(p) && !p.includes(':') && !p.includes('\0') && !p.split('/').includes('..');
}

export function planSkillMounts(input: {
  plugins: readonly LocalPlugin[];
  homeDir: string;
  fs: MountFs;
}): SkillMountPlan {
  const { fs, homeDir } = input;
  const byGuest = new Map<string, VmExtraMount>();
  const pluginGuestPaths: Record<string, string> = {};
  const allowedSymlinkTargetRoots = [SKILLS_GUEST_ROOT, GUEST_HOME, homeDir.replace(/\/+$/, '')].filter(Boolean);

  /** Returns false if the pair was rejected or collides with a different host path. */
  const addMount = (hostPath: string, guestPath: string): boolean => {
    if (!mountablePath(hostPath) || !mountablePath(guestPath)) return false;
    const existing = byGuest.get(guestPath);
    if (existing) return existing.hostPath === hostPath;
    // Nesting a mount inside another read-only mount cannot work (the runtime
    // would have to create the mount point inside a read-only tree).
    for (const m of byGuest.values()) {
      if (isWithin(guestPath, m.guestPath) || isWithin(m.guestPath, guestPath)) return false;
    }
    byGuest.set(guestPath, { hostPath, guestPath });
    return true;
  };

  /** Mount links that escape `realRoot` so they resolve inside the guest. `guestDir` is where `dir` lives in the guest. */
  const addEscapingSymlinks = (dir: string, realRoot: string, guestDir: string, guestRoot: string): void => {
    for (const { name, linkText } of fs.childSymlinks(dir)) {
      const target = fs.realpath(nodePath.posix.join(dir, name));
      if (!target || !fs.isDirectory(target)) continue;
      if (isWithin(target, realRoot)) continue; // already visible through the root's own mount
      const guestTarget = nodePath.posix.isAbsolute(linkText)
        ? nodePath.posix.normalize(linkText)
        : nodePath.posix.resolve(guestDir, linkText);
      if (isWithin(guestTarget, guestRoot)) continue;
      if (!allowedSymlinkTargetRoots.some((root) => isWithin(guestTarget, root))) continue;
      addMount(target, guestTarget);
    }
  };

  // ~/.claude/skills and ~/.claude/agents: the CLI reads these from $HOME itself.
  for (const sub of ['skills', 'agents'] as const) {
    const host = nodePath.posix.join(homeDir, '.claude', sub);
    const real = fs.realpath(host);
    if (!real || !fs.isDirectory(real)) continue;
    const guest = `${GUEST_HOME}/.claude/${sub}`;
    if (!addMount(real, guest)) continue;
    // Agents are files, not skill dirs; only skills hold escaping directory links.
    if (sub === 'skills') addEscapingSymlinks(host, real, guest, guest);
  }

  for (const plugin of input.plugins) {
    const real = fs.realpath(plugin.path);
    if (!real || !fs.isDirectory(real)) continue;
    const guest = `${SKILLS_GUEST_ROOT}/${safeBasename(real)}-${fnv1a64Hex(real).slice(0, 10)}`;
    if (!addMount(real, guest)) continue;
    pluginGuestPaths[plugin.path] = guest;
    // A plugin may itself be a skill dir, or a root holding `skills/`.
    addEscapingSymlinks(real, real, guest, guest);
    const skillsSub = nodePath.posix.join(real, 'skills');
    if (fs.isDirectory(skillsSub)) addEscapingSymlinks(skillsSub, real, `${guest}/skills`, guest);
  }

  const mounts = [...byGuest.values()].sort((a, b) => (a.guestPath < b.guestPath ? -1 : a.guestPath > b.guestPath ? 1 : 0));
  return { mounts, pluginGuestPaths };
}

/**
 * Stable string identifying a mount set; stored as a container label so a
 * later session can tell whether an existing container has what it needs.
 * Empty string means "no extra mounts".
 */
export function mountSignature(mounts: readonly VmExtraMount[]): string {
  if (mounts.length === 0) return '';
  const sorted = [...mounts].sort((a, b) => (a.guestPath < b.guestPath ? -1 : a.guestPath > b.guestPath ? 1 : 0));
  // Read-only entries keep the original 2-tuple so labels written before
  // readWrite existed still compare equal; rw adds a third 'rw' element.
  return JSON.stringify(sorted.map((m) => (m.readWrite ? [m.hostPath, m.guestPath, 'rw'] : [m.hostPath, m.guestPath])));
}

/** Inverse of {@link mountSignature}; null when the value is not a signature this module produced. */
export function parseMountSignature(signature: string): VmExtraMount[] | null {
  if (signature === '') return [];
  try {
    const parsed: unknown = JSON.parse(signature);
    if (!Array.isArray(parsed)) return null;
    const out: VmExtraMount[] = [];
    for (const entry of parsed) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') return null;
      out.push({ hostPath: entry[0], guestPath: entry[1], ...(entry[2] === 'rw' ? { readWrite: true } : {}) });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Rewrites host plugin paths to guest paths for a VM-routed session. Plugins
 * with no mapping, or whose guest path is not in `mounted` (the container was
 * created earlier with a different set), are dropped: a plugin pointing at a
 * path the guest cannot see would only fail silently.
 */
export function rewritePluginsForGuest<P extends LocalPlugin>(
  plugins: readonly P[],
  plan: Pick<SkillMountPlan, 'pluginGuestPaths'>,
  mounted: readonly VmExtraMount[],
): P[] {
  const mountedGuest = new Set(mounted.map((m) => m.guestPath));
  const out: P[] = [];
  for (const plugin of plugins) {
    const guest = plan.pluginGuestPaths[plugin.path];
    if (guest && mountedGuest.has(guest)) out.push({ ...plugin, path: guest });
  }
  return out;
}

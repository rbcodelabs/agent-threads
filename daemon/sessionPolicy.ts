/**
 * What the daemon refuses to run, decided before any process is spawned
 * (design 5.2): the cwd must sit under an allowlisted workspace root,
 * `bypassPermissions` needs an explicit operator opt-in, only the Claude
 * harness exists yet, the permission mode must be one the daemon knows, and a
 * client cannot choose the agent's environment: `extraEnvRaw` is ignored unless
 * the operator lists the variable names a client may set (`allowedClientEnv`).
 */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { RemoteSessionSpec } from '../src/protocol';

export interface SessionPolicy {
  /** Folders sessions may run in (read-write). */
  workspaces: string[];
  /**
   * Folders sessions may run in but not edit through the harness (for example a
   * synced vault mirror you only want read). Also allowed as cwd; the most
   * specific root that contains a path decides whether it is read-only.
   */
  readOnlyWorkspaces?: string[];
  allowBypass: boolean;
  /**
   * Variable names a client may set through `extraEnvRaw`. Empty or absent (the default) = the client's
   * environment is ignored. An allowlist is the only safe shape: a denylist cannot enumerate every
   * variable that redirects traffic or code (HTTPS_PROXY, NODE_EXTRA_CA_CERTS, NODE_TLS_REJECT_UNAUTHORIZED,
   * BASH_ENV, GIT_SSH_COMMAND, CLAUDE_CODE_USE_*, ANTHROPIC_*_BASE_URL, ...).
   */
  allowedClientEnv?: string[];
}

export class PolicyError extends Error {
  constructor(readonly code: 'forbidden' | 'bad_frame', message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export function realOrResolved(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/**
 * Like `realpath`, for a path that may not exist yet (a worktree about to be created): the nearest existing ancestor
 * is resolved through symlinks and the missing tail is appended. Without this, a workspace reached through a symlink
 * (`/var` -> `/private/var`) would never contain a path that does not exist yet.
 */
export function realpathLoose(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try { return join(realpathSync(cur), ...tail.reverse()); } catch { /* keep climbing, but only past components that really do not exist */ }
    // A component that exists (lstat works) yet cannot be resolved is a dangling symlink, a loop or an unreadable
    // directory. Climbing past it would judge the path by its parent and let a link to a not-yet-created location
    // outside the workspace (mkdir later makes it real) stand for a path inside it.
    let exists = true;
    try { lstatSync(cur); } catch (err) { exists = (err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR'; }
    if (exists) throw new Error(`cannot resolve ${cur}: a dangling symlink, a loop or an unreadable folder`);
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.push(basename(cur));
    cur = parent;
  }
}

export function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve `path` and require it to be an existing directory inside one of the
 * roots. Symlinks are followed before the comparison, so a link inside a
 * workspace that points outside it is refused.
 */
export function assertWithinWorkspaces(path: string, workspaces: readonly string[], what = 'cwd'): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new PolicyError('bad_frame', `${what} must be an absolute path`);
  const resolved = resolve(path);
  let real: string;
  try {
    real = realpathSync(resolved);
    if (!statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new PolicyError('bad_frame', `${what} ${resolved} does not exist or is not a directory`);
  }
  const roots = workspaces.map(realOrResolved);
  if (!roots.some((root) => isWithin(root, real))) {
    throw new PolicyError('forbidden', `${what} ${resolved} is outside the daemon's workspaces (${workspaces.join(', ') || 'none configured'})`);
  }
  return resolved;
}

/** Every root a session may use: read-write first, then read-only. */
export function allWorkspaceRoots(policy: SessionPolicy): string[] {
  return [...policy.workspaces, ...(policy.readOnlyWorkspaces ?? [])];
}

/**
 * Modes that cannot auto-approve an edit. `acceptEdits`, `bypassPermissions` and
 * `auto` can, so they are refused in a read-only workspace; `default` asks,
 * `plan` cannot edit, `dontAsk` denies anything not pre-approved.
 */
export const READ_ONLY_PERMISSION_MODES: ReadonlySet<string> = new Set(['default', 'plan', 'dontAsk']);
/** The harness's file-editing tools, denied in a read-only workspace. Shell commands are NOT covered (see docs). */
export const READ_ONLY_DENIED_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'] as const;

/**
 * Is `realPath` (already symlink-resolved) read-only under `policy`? The most
 * specific root containing it wins, so a read-write workspace nested inside a
 * read-only one stays writable.
 */
export function isReadOnlyPath(realPath: string, policy: SessionPolicy): boolean {
  let best: { depth: number; readOnly: boolean } | undefined;
  const consider = (roots: readonly string[], readOnly: boolean): void => {
    for (const root of roots.map(realOrResolved)) {
      if (!isWithin(root, realPath)) continue;
      const depth = root.length;
      // Ties go to read-only: a path listed both ways is treated as the safer one.
      if (!best || depth > best.depth || (depth === best.depth && readOnly)) best = { depth, readOnly };
    }
  };
  consider(policy.workspaces, false);
  consider(policy.readOnlyWorkspaces ?? [], true);
  return best?.readOnly ?? false;
}

export interface PathAccess {
  allowed: boolean;
  exists: boolean;
  isDirectory: boolean;
  readOnly: boolean;
}

/**
 * What `path.check` reports. Never throws. A path outside every workspace
 * reveals nothing about the disk beyond `allowed:false`.
 */
export function describePathAccess(path: string, policy: SessionPolicy): PathAccess {
  const none: PathAccess = { allowed: false, exists: false, isDirectory: false, readOnly: false };
  if (typeof path !== 'string' || !isAbsolute(path)) return none;
  const resolved = resolve(path);
  const roots = allWorkspaceRoots(policy).map(realOrResolved);
  let real: string;
  try { real = realpathSync(resolved); } catch {
    // Missing: it may still be inside a workspace (a useful answer), judged lexically.
    let loose: string;
    try { loose = realpathLoose(resolved); } catch { return none; }
    const inside = roots.some((r) => isWithin(r, loose));
    return inside ? { allowed: true, exists: false, isDirectory: false, readOnly: isReadOnlyPath(loose, policy) } : none;
  }
  if (!roots.some((r) => isWithin(r, real))) return none;
  let isDirectory = false;
  try { isDirectory = statSync(real).isDirectory(); } catch { /* raced away */ }
  return { allowed: true, exists: true, isDirectory, readOnly: isReadOnlyPath(real, policy) };
}

/** Every permission mode the plugin can send. Anything else is refused rather than passed to the harness. */
export const KNOWN_PERMISSION_MODES: ReadonlySet<string> = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']);

export function assertPermissionModeAllowed(mode: string, policy: SessionPolicy, opts: { readOnly?: boolean } = {}): void {
  if (typeof mode !== 'string' || !KNOWN_PERMISSION_MODES.has(mode)) {
    throw new PolicyError('bad_frame', `unknown permission mode ${JSON.stringify(String(mode).slice(0, 40))}; expected one of ${[...KNOWN_PERMISSION_MODES].join(', ')}`);
  }
  if (mode === 'bypassPermissions' && !policy.allowBypass) {
    throw new PolicyError('forbidden', 'bypassPermissions is disabled on this daemon (set allowBypass in config.json to enable it)');
  }
  if (opts.readOnly && !READ_ONLY_PERMISSION_MODES.has(mode)) {
    throw new PolicyError('forbidden', `permission mode "${mode}" is refused in a read-only workspace on this daemon; use default, plan or dontAsk`);
  }
}

/**
 * Variables that stay unsettable even if an operator lists them in `allowedClientEnv`: they carry the
 * daemon's credentials or change how it runs. (Defence in depth; the allowlist is the real control.)
 */
const PROTECTED_ENV = new Set([
  'HOME', 'PATH', 'USER', 'SHELL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
]);

/** Drop `KEY=value` lines naming a protected variable. */
export function sanitizeExtraEnv(raw: string): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    const key = eq > 0 && !trimmed.startsWith('#') ? trimmed.slice(0, eq).trim() : '';
    if (key && PROTECTED_ENV.has(key.toUpperCase())) dropped.push(key);
    else kept.push(line);
  }
  return { text: kept.join('\n'), dropped };
}

/**
 * Keep only `KEY=value` lines whose KEY the operator allowed (and that is not protected). With no
 * allowlist this returns nothing: client-supplied environment is ignored.
 */
export function filterClientEnv(raw: string, allowed: readonly string[] | undefined): { text: string; dropped: string[] } {
  if (!raw.trim()) return { text: '', dropped: [] };
  const allow = new Set(allowed ?? []);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    const key = eq > 0 ? trimmed.slice(0, eq).trim() : '';
    if (key && allow.has(key) && !PROTECTED_ENV.has(key.toUpperCase())) kept.push(line);
    else dropped.push(key || trimmed.slice(0, 20));
  }
  return { text: kept.join('\n'), dropped };
}

/** Throws `PolicyError`; returns the spec to run (extra env sanitised, paths resolved). */
export function validateSpec(spec: RemoteSessionSpec, policy: SessionPolicy): RemoteSessionSpec {
  if (!spec || typeof spec !== 'object') throw new PolicyError('bad_frame', 'spec is required');
  if (spec.harness !== 'claude') {
    throw new PolicyError('bad_frame', `harness "${String(spec.harness)}" is not supported by this daemon build (claude only)`);
  }
  const roots = allWorkspaceRoots(policy);
  const cwd = assertWithinWorkspaces(spec.cwd, roots, 'cwd');
  const additionalDirectories = (spec.additionalDirectories ?? []).map((d) =>
    assertWithinWorkspaces(d, roots, 'additionalDirectories entry'));
  // One read-only directory makes the whole session read-only: the edit tools are not per-directory.
  const readOnly = specIsReadOnly({ cwd, additionalDirectories }, policy);
  assertPermissionModeAllowed(spec.permissionMode, policy, { readOnly });
  const disallowedTools = readOnly
    ? [...new Set([...(spec.disallowedTools ?? []), ...READ_ONLY_DENIED_TOOLS])]
    : spec.disallowedTools;
  return {
    ...spec,
    cwd,
    ...(disallowedTools ? { disallowedTools } : {}),
    ...(additionalDirectories.length ? { additionalDirectories } : { additionalDirectories: undefined }),
    extraEnvRaw: filterClientEnv(spec.extraEnvRaw ?? '', policy.allowedClientEnv).text,
  };
}

/** True when the session's cwd or any additional directory is in a read-only workspace. */
export function specIsReadOnly(spec: Pick<RemoteSessionSpec, 'cwd' | 'additionalDirectories'>, policy: SessionPolicy): boolean {
  if (!(policy.readOnlyWorkspaces?.length)) return false;
  return [spec.cwd, ...(spec.additionalDirectories ?? [])].some((d) => isReadOnlyPath(realOrResolved(d), policy));
}

/**
 * Throws when `path` is not inside a configured workspace, or is inside a read-only one. Used for every directory a
 * local tool would adopt or write beside (set_working_directory, a worktree's target, the repo and git root it is
 * made from): a read-only workspace is not somewhere a tool may move the session or add a worktree.
 */
export function assertCwdAllowed(path: string, policy: SessionPolicy): void {
  const access = describePathAccess(path, policy);
  if (!access.allowed) {
    throw new Error(`Working directory is outside the folders this daemon allows sessions in: ${path}`);
  }
  if (access.readOnly) {
    throw new Error(`Working directory is in a read-only workspace on this daemon, so a tool cannot move the session or add a worktree there: ${path}`);
  }
}

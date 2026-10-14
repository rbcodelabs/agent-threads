/**
 * What the daemon refuses to run, decided before any process is spawned
 * (design 5.2): the cwd must sit under an allowlisted workspace root,
 * `bypassPermissions` needs an explicit operator opt-in, only the Claude
 * harness exists yet, and a client cannot override the variables that carry
 * the daemon's own credentials or redirect its process environment.
 */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
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
    const inside = roots.some((r) => isWithin(r, resolved));
    return inside ? { allowed: true, exists: false, isDirectory: false, readOnly: isReadOnlyPath(resolved, policy) } : none;
  }
  if (!roots.some((r) => isWithin(r, real))) return none;
  let isDirectory = false;
  try { isDirectory = statSync(real).isDirectory(); } catch { /* raced away */ }
  return { allowed: true, exists: true, isDirectory, readOnly: isReadOnlyPath(real, policy) };
}

export function assertPermissionModeAllowed(mode: string, policy: SessionPolicy, opts: { readOnly?: boolean } = {}): void {
  if (mode === 'bypassPermissions' && !policy.allowBypass) {
    throw new PolicyError('forbidden', 'bypassPermissions is disabled on this daemon (set allowBypass in config.json to enable it)');
  }
  if (opts.readOnly && !READ_ONLY_PERMISSION_MODES.has(mode)) {
    throw new PolicyError('forbidden', `permission mode "${mode}" is refused in a read-only workspace on this daemon; use default, plan or dontAsk`);
  }
}

/** Variables a client may not set: they carry the daemon's credentials or change how it runs. */
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
    extraEnvRaw: sanitizeExtraEnv(spec.extraEnvRaw ?? '').text,
  };
}

/** True when the session's cwd or any additional directory is in a read-only workspace. */
export function specIsReadOnly(spec: Pick<RemoteSessionSpec, 'cwd' | 'additionalDirectories'>, policy: SessionPolicy): boolean {
  if (!(policy.readOnlyWorkspaces?.length)) return false;
  return [spec.cwd, ...(spec.additionalDirectories ?? [])].some((d) => isReadOnlyPath(realOrResolved(d), policy));
}

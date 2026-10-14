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
  workspaces: string[];
  allowBypass: boolean;
}

export class PolicyError extends Error {
  constructor(readonly code: 'forbidden' | 'bad_frame', message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

function realOrResolved(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function isWithin(root: string, target: string): boolean {
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

export function assertPermissionModeAllowed(mode: string, policy: SessionPolicy): void {
  if (mode === 'bypassPermissions' && !policy.allowBypass) {
    throw new PolicyError('forbidden', 'bypassPermissions is disabled on this daemon (set allowBypass in config.json to enable it)');
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
  assertPermissionModeAllowed(spec.permissionMode, policy);
  const cwd = assertWithinWorkspaces(spec.cwd, policy.workspaces, 'cwd');
  const additionalDirectories = (spec.additionalDirectories ?? []).map((d) =>
    assertWithinWorkspaces(d, policy.workspaces, 'additionalDirectories entry'));
  return {
    ...spec,
    cwd,
    ...(additionalDirectories.length ? { additionalDirectories } : { additionalDirectories: undefined }),
    extraEnvRaw: sanitizeExtraEnv(spec.extraEnvRaw ?? '').text,
  };
}

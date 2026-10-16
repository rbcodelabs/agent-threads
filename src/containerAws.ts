/**
 * containerAws.ts — "Container AWS credentials": lets a harness container
 * (ADR-0015) use the host's AWS SSO login without ever seeing the host's
 * home directory or environment.
 *
 * Two read-only mounts, planned here and attached through `mergeExtraMounts`:
 *
 *   - the host SSO token cache  (~/.aws/sso/cache)  ->  /aws/sso-cache
 *   - a GENERATED, trimmed AWS config               ->  /aws/config
 *
 * and one env var, `AWS_CONFIG_FILE=/aws/config`, set on the harness exec
 * (see {@link containerAwsEnv}). The AWS SDK always reads the token cache from
 * `$HOME/.aws/sso/cache` (no env override), so the image (sandbox/
 * Dockerfile.harness-aws) symlinks that path to /aws/sso-cache.
 *
 * Why the token cache is mounted as a DIRECTORY, not per-file: the host
 * rewrites a token with write-temp-then-rename (awsSsoLogin.writeToken), so a
 * single-file bind mount would keep pointing at the old inode after a refresh,
 * and a file that does not exist yet (not signed in) cannot be mounted at all.
 * The exposure is documented in docs/sandbox-vms.md.
 *
 * The generated config carries only the allowed profiles (plus the
 * sso-session / source_profile blocks they reference) and only keys on an
 * allowlist, so static keys, session tokens and `credential_process` (which
 * would run a host command) can never be copied into the container.
 */
import { parseAwsIni } from './awsSsoLogin';
import { extractAwsProfile } from './dashboardUtils';
import type { VmExtraMount } from './skillMounts';

export const AWS_GUEST_SSO_CACHE = '/aws/sso-cache';
export const AWS_GUEST_CONFIG = '/aws/config';

/** Config keys that may be copied into the container. Anything else (notably secrets) is dropped. */
const ALLOWED_CONFIG_KEYS = new Set([
  'region', 'output', 'sso_session', 'sso_start_url', 'sso_region', 'sso_account_id',
  'sso_role_name', 'sso_registration_scopes', 'role_arn', 'source_profile', 'role_session_name',
  'external_id', 'duration_seconds',
]);

/** Splits a newline/comma separated list into unique, non-empty names. */
export function parseProfileList(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(/[\n,]/)) {
    const name = part.trim();
    if (name && !/[\]\[\0]/.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Profiles exposed to containers: the `AWS_PROFILE` from Extra environment
 * variables (what the session itself uses) plus anything the user listed in
 * the setting. Returns `[]` when AWS credentials are not relevant (not Bedrock
 * and nothing listed), which disables the feature entirely.
 */
export function resolveContainerAwsProfiles(opts: {
  provider: string | undefined;
  settingValue: string | undefined;
  extraEnv: string;
}): string[] {
  const listed = parseProfileList(opts.settingValue);
  if (opts.provider !== 'bedrock' && listed.length === 0) return [];
  const profiles: string[] = [];
  const fromEnv = extractAwsProfile(opts.extraEnv);
  if (fromEnv) profiles.push(fromEnv);
  for (const p of listed) if (!profiles.includes(p)) profiles.push(p);
  return profiles;
}

/**
 * Renders a trimmed config containing only `profiles`, the profiles they chain
 * to via `source_profile`, and the `sso-session` blocks any of them reference.
 */
export function buildContainerAwsConfig(
  iniText: string,
  profiles: readonly string[],
): { text: string; included: string[]; missing: string[] } {
  const ini = parseAwsIni(iniText);
  const wanted = new Map<string, string>(); // section -> display header
  const missing: string[] = [];
  const queue = [...profiles];
  const seen = new Set<string>();
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const candidates = name === 'default' ? ['default', 'profile default'] : [`profile ${name}`];
    const section = candidates.find((c) => c in ini) ?? null;
    if (!section) { if (profiles.includes(name)) missing.push(name); continue; }
    wanted.set(section, section);
    const data = ini[section];
    if (data.sso_session) {
      const s = `sso-session ${data.sso_session}`;
      if (ini[s]) wanted.set(s, s);
    }
    if (data.source_profile) queue.push(data.source_profile);
  }
  const blocks: string[] = [];
  for (const [section, header] of wanted) {
    const lines = Object.entries(ini[section])
      .filter(([k]) => ALLOWED_CONFIG_KEYS.has(k))
      .map(([k, v]) => `${k} = ${v}`);
    blocks.push(`[${header}]\n${lines.join('\n')}\n`);
  }
  const included = [...wanted.keys()].filter((s) => !s.startsWith('sso-session ')).map((s) => s.replace(/^profile /, ''));
  return { text: blocks.join('\n'), included, missing };
}

/** Everything the planner touches on the host, injectable for tests. */
export interface ContainerAwsFs {
  readFile(path: string): string | null;
  /** Creates the directory (recursively, owner-only) if missing; false when it cannot exist. */
  ensureDir(path: string): boolean;
  /** Overwrites IN PLACE (same inode) so a running container's file mount sees the update. */
  writeFile(path: string, content: string): void;
}

export interface ContainerAwsPlan {
  mounts: VmExtraMount[];
  profiles: string[];
  /** User-facing problems (e.g. a listed profile is not in the host config). Never fatal. */
  warnings: string[];
}

/**
 * Plans the two mounts and writes the generated config. Returns null when
 * there is nothing to expose or the host has no usable AWS config; the thread
 * then runs exactly as it did before this feature existed.
 */
export function planContainerAwsMounts(opts: {
  profiles: readonly string[];
  homeDir: string;
  /** Host `AWS_CONFIG_FILE`, if set; defaults to ~/.aws/config. */
  hostConfigPath?: string;
  /** Plugin-owned directory the generated config is written under. Empty disables the feature. */
  dataDir: string;
  fs: ContainerAwsFs;
}): ContainerAwsPlan | null {
  if (opts.profiles.length === 0 || !opts.dataDir || !opts.homeDir.startsWith('/')) return null;
  const home = opts.homeDir.replace(/\/+$/, '');
  const hostConfig = opts.hostConfigPath || `${home}/.aws/config`;
  const iniText = opts.fs.readFile(hostConfig);
  if (iniText === null) return null;

  const { text, included, missing } = buildContainerAwsConfig(iniText, opts.profiles);
  const warnings = missing.map((p) => `AWS profile "${p}" is not in ${hostConfig}, so it is not available in containers.`);
  if (included.length === 0) return { mounts: [], profiles: [], warnings };

  const generatedDir = `${opts.dataDir.replace(/\/+$/, '')}/container-aws`;
  const cacheDir = `${home}/.aws/sso/cache`;
  if (!opts.fs.ensureDir(generatedDir) || !opts.fs.ensureDir(cacheDir)) return null;
  const generated = `${generatedDir}/config`;
  opts.fs.writeFile(generated, text);

  return {
    mounts: [
      { hostPath: cacheDir, guestPath: AWS_GUEST_SSO_CACHE },
      { hostPath: generated, guestPath: AWS_GUEST_CONFIG },
    ],
    profiles: included,
    warnings,
  };
}

/**
 * Env for the containerized harness. AWS_CONFIG_FILE is derived from the mounts
 * the container REALLY has (an older kept container may lack them), so we never
 * point it at a file that is not there.
 *
 * AWS_EC2_METADATA_DISABLED is set whenever AWS is in play (mounts present, or
 * the session is on Bedrock). Without it, a container with no usable profile
 * falls through to the instance-metadata probe, which has no answer on a
 * container network: the CLI then retries "Request timed out" for many minutes
 * with no output, and never emits the "Could not load AWS credentials" error
 * that awsAuthRecovery keys on. With it, the same situation fails at once with
 * that error, so the existing sign-in card appears (verified against the CLI).
 */
export function containerAwsEnv(
  mountedExtra: readonly VmExtraMount[] | undefined,
  sessionEnv: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const hasConfig = (mountedExtra ?? []).some((m) => m.guestPath === AWS_GUEST_CONFIG);
  const onBedrock = sessionEnv.CLAUDE_CODE_USE_BEDROCK === '1';
  return {
    ...(hasConfig ? { AWS_CONFIG_FILE: AWS_GUEST_CONFIG } : {}),
    ...(hasConfig || onBedrock ? { AWS_EC2_METADATA_DISABLED: 'true' } : {}),
  };
}

/** Node-backed {@link ContainerAwsFs}. */
export function nodeContainerAwsFs(): ContainerAwsFs {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  return {
    readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
    ensureDir: (p) => { try { fs.mkdirSync(p, { recursive: true, mode: 0o700 }); return fs.statSync(p).isDirectory(); } catch { return false; } },
    // 'w' truncates the existing inode rather than replacing it.
    writeFile: (p, c) => fs.writeFileSync(p, c, { mode: 0o600 }),
  };
}

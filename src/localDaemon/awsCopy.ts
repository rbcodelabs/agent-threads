/**
 * Local daemon: AWS (Amazon Bedrock, deploys) credentials for sessions in the daemon container.
 *
 * Ported from the removed per-thread sandbox VM ("Container AWS credentials"). The VM bind-mounted the host's whole
 * SSO token cache read-only. The daemon has no bind mount to change, so the files are COPIED into the daemon user's
 * home (`~/.aws`, where the AWS SDK looks by default, so no `AWS_CONFIG_FILE` override is needed) before a session
 * starts and again whenever it is refreshed:
 *
 *   - a GENERATED, trimmed config: only the allowed profiles, the `source_profile`s they chain to and the
 *     `sso-session` blocks they use, with an allowlist of keys, so static keys, session tokens and
 *     `credential_process` (which would run a command) never reach the container;
 *   - the ONE token file per SSO session those profiles use (`sha1(<session name or start URL>).json`), not the whole
 *     cache directory (narrower than the VM, which exposed every session's token).
 *
 * `AWS_EC2_METADATA_DISABLED=true` is sent with the session environment whenever AWS is in play: without it a
 * container with no usable profile falls through to the instance-metadata probe, which has no answer, and the CLI
 * retries "Request timed out" for minutes instead of failing with "Could not load AWS credentials" (which is what
 * triggers the sign-in card).
 *
 * Pure builders plus an injectable fs; no Node built-in at module scope.
 */
import { parseAwsIni, resolveSsoProfile } from '../awsSsoLogin';
import { extractAwsProfile } from '../dashboardUtils';
import type { FileToCopy } from './containerFiles';

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
 * Profiles exposed to the daemon: the `AWS_PROFILE` from Extra environment variables (what the session itself uses)
 * plus anything the user listed in the setting. Returns `[]` when AWS credentials are not relevant (not Bedrock and
 * nothing listed), which disables the feature entirely.
 */
export function resolveDaemonAwsProfiles(opts: {
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
 * Renders a trimmed config containing only `profiles`, the profiles they chain to via `source_profile`, and the
 * `sso-session` blocks any of them reference.
 */
export function buildDaemonAwsConfig(
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

/** What the planner reads on the host, injectable for tests. */
export interface AwsCopyFs {
  readFile(path: string): string | null;
  sha1Hex(text: string): string;
}

export interface AwsCopyPlan {
  /** Relative to the daemon user's `~/.aws`: `config` and `sso/cache/<sha1>.json`. */
  files: FileToCopy[];
  profiles: string[];
  /** User-facing problems (a listed profile is not in the host config; not signed in). Never fatal. */
  warnings: string[];
}

/**
 * Plans the files to copy. Returns null when there is nothing to expose or the host has no usable AWS config; the
 * session then runs exactly as it would without this feature.
 */
export function planAwsCopy(opts: {
  profiles: readonly string[];
  homeDir: string;
  /** Host `AWS_CONFIG_FILE`, if set; defaults to ~/.aws/config. */
  hostConfigPath?: string;
  fs: AwsCopyFs;
}): AwsCopyPlan | null {
  if (opts.profiles.length === 0 || !opts.homeDir.startsWith('/')) return null;
  const home = opts.homeDir.replace(/\/+$/, '');
  const hostConfig = opts.hostConfigPath || `${home}/.aws/config`;
  const iniText = opts.fs.readFile(hostConfig);
  if (iniText === null) return null;

  const { text, included, missing } = buildDaemonAwsConfig(iniText, opts.profiles);
  const warnings = missing.map((p) => `AWS profile "${p}" is not in ${hostConfig}, so it is not available in the local daemon.`);
  if (included.length === 0) return { files: [], profiles: [], warnings };

  const files: FileToCopy[] = [{ p: 'config', b: Buffer.from(text, 'utf8').toString('base64') }];
  const copied = new Set<string>();
  for (const profile of included) {
    const sso = resolveSsoProfile(iniText, profile);
    if (!sso.ok) continue; // not an SSO profile (static keys are deliberately never copied), nothing to carry
    const name = `${opts.fs.sha1Hex(sso.value.cacheKey)}.json`;
    if (copied.has(name)) continue;
    copied.add(name);
    const token = opts.fs.readFile(`${home}/.aws/sso/cache/${name}`);
    if (token === null) {
      warnings.push(`AWS profile "${profile}" has no SSO token on this Mac yet. Sign in to AWS, then send again.`);
      continue;
    }
    files.push({ p: `sso/cache/${name}`, b: Buffer.from(token, 'utf8').toString('base64') });
  }
  return { files, profiles: included, warnings };
}

/**
 * Environment sent with the session whenever AWS is in play: the profile is relevant (files were planned) or the
 * session is on Bedrock. See the file header for why metadata lookups are switched off.
 */
export function daemonAwsEnv(
  planned: boolean,
  sessionEnv: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const onBedrock = sessionEnv.CLAUDE_CODE_USE_BEDROCK === '1';
  return planned || onBedrock ? { AWS_EC2_METADATA_DISABLED: 'true' } : {};
}

/** Node-backed {@link AwsCopyFs}. */
export function nodeAwsCopyFs(): AwsCopyFs {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto') as typeof import('crypto');
  return {
    readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
    sha1Hex: (t) => crypto.createHash('sha1').update(t).digest('hex'),
  };
}

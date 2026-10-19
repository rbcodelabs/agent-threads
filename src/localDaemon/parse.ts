/**
 * Local daemon: parsers for `container` CLI output and error classification.
 * Pure. Parsers return null / a typed "unknown" for anything unrecognised
 * rather than throwing, so a CLI output change degrades to "unknown", never a crash.
 */

import { parseContainerLabels } from '../containerCli';

export type ContainerState = 'running' | 'stopped' | 'unknown';

export interface InspectedContainer {
  state: ContainerState;
  labels: Record<string, string>;
}

/** `container inspect <name>` JSON. Only a positively reported `running` counts as running. */
export function parseInspectedContainer(stdout: string): InspectedContainer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const entry = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | undefined;
  if (!entry || typeof entry !== 'object') return null;
  const status = entry.status;
  const raw = (typeof status === 'object' && status !== null ? (status as Record<string, unknown>).state : status)
    ?? entry.state ?? (entry.State as Record<string, unknown> | undefined)?.Status;
  const text = typeof raw === 'string' ? raw.toLowerCase() : '';
  const state: ContainerState = text === 'running' ? 'running' : text ? 'stopped' : 'unknown';
  return { state, labels: parseContainerLabels(stdout) ?? {} };
}

export interface CreatedToken {
  id: string;
  name: string;
  scope: string;
  token: string;
}

/** `agent-threads token create --json`: one JSON line `{id,name,scope,token}`. Finds it among any other output. */
export function parseTokenCreate(stdout: string): CreatedToken | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof o.id === 'string' && typeof o.token === 'string' && o.token.length > 0) {
        return { id: o.id, name: typeof o.name === 'string' ? o.name : '', scope: typeof o.scope === 'string' ? o.scope : '', token: o.token };
      }
    } catch { /* not the JSON line */ }
  }
  return null;
}

export interface ListedToken {
  id: string;
  name: string;
  revoked: boolean;
}

/** `agent-threads token list --json`: NDJSON, one object per line. */
export function parseTokenList(stdout: string): ListedToken[] {
  const out: ListedToken[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof o.id === 'string' && typeof o.name === 'string') out.push({ id: o.id, name: o.name, revoked: typeof o.revokedAt === 'number' });
    } catch { /* skip */ }
  }
  return out;
}

export type PullFailure = 'denied' | 'not-found' | 'network' | 'disk' | 'unknown';

/** Classifies `container image pull` stderr. Order matters: a denied pull often also says "not found". */
export function classifyPullError(text: string): PullFailure {
  const t = text.toLowerCase();
  if (/denied|unauthorized|forbidden|\b40[13]\b|requires authentication|authentication required/.test(t)) return 'denied';
  if (/no space left|not enough (disk )?space|disk full|enospc/.test(t)) return 'disk';
  if (/manifest unknown|not found|\b404\b|name unknown|no such manifest/.test(t)) return 'not-found';
  if (/could not resolve|dial tcp|connection refused|timed out|timeout|network is unreachable|no route to host|temporary failure|tls|eof/.test(t)) return 'network';
  return 'unknown';
}

/** Text fit for a user, per classification. Never includes the raw output (callers append a tail if they want it). */
export function describePullFailure(kind: PullFailure, ref: string, version: string): string {
  switch (kind) {
    case 'denied':
      return `${ref} is not publicly pullable. The maintainer must set the GHCR package visibility to Public; until then the local daemon cannot be set up.`;
    case 'not-found':
      return `The daemon image for v${version} is not published yet (${ref} was not found). Try again in a few minutes, or keep using the version you have.`;
    case 'network':
      return 'Could not reach ghcr.io to download the daemon image. Check your connection and try again; partial downloads are kept.';
    case 'disk':
      return 'There is not enough free disk space to download the daemon image. Free some space and try again.';
    default:
      return `Downloading ${ref} failed.`;
  }
}

/** `/healthz` body: `{"ok":true,"protocol":1}`. */
export function parseHealthz(body: string): { ok: boolean; protocol?: number } {
  try {
    const o = JSON.parse(body) as Record<string, unknown>;
    return { ok: o.ok === true, ...(typeof o.protocol === 'number' ? { protocol: o.protocol } : {}) };
  } catch {
    return { ok: false };
  }
}

/** Replaces every occurrence of each secret in `text`. Content-match, never positional. */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('<redacted>');
  return out;
}

/** Last `lines` non-empty lines of `text`. */
export function tail(text: string, lines = 15): string {
  const t = text.trim();
  if (!t) return '(no output)';
  return t.split('\n').slice(-lines).join('\n');
}

// ── Per-harness probe and device-code login output ───────────────────────────

export interface HarnessProbe {
  /** The CLI is in the image. */
  cli: boolean;
  /** A login left a credential file in the persisted HOME (Claude is not probed here: see `credentialInVolume`). */
  signedIn: boolean;
}

export type HarnessProbeResult = Partial<Record<'claude' | 'codex' | 'opencode', HarnessProbe>>;

/** Parse `HARNESS_PROBE_SCRIPT` output. Unknown lines are ignored; null when nothing was recognised. */
export function parseHarnessProbe(stdout: string): HarnessProbeResult | null {
  const out: HarnessProbeResult = {};
  let seen = false;
  for (const line of stdout.split('\n')) {
    const m = /^(claude|codex|opencode)\.(cli|auth)=([01])\s*$/.exec(line.trim());
    if (!m) continue;
    seen = true;
    const h = m[1] as 'claude' | 'codex' | 'opencode';
    const entry = out[h] ?? { cli: false, signedIn: false };
    if (m[2] === 'cli') entry.cli = m[3] === '1'; else entry.signedIn = m[3] === '1';
    out[h] = entry;
  }
  return seen ? out : null;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * What `codex login --device-auth` prints: a verification URL and a one-time code (`ABCD-12345`). Either may be
 * absent while the CLI is still starting; the caller keeps feeding output until both are found.
 */
export function parseDeviceLogin(output: string): { url?: string; code?: string } {
  const text = output.replace(ANSI, '');
  const url = /https:\/\/[^\s)'"]+/.exec(text)?.[0];
  const code = /\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/.exec(text)?.[0];
  return { ...(url ? { url } : {}), ...(code ? { code } : {}) };
}

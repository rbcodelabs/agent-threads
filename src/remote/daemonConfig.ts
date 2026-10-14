/**
 * Pure helpers behind Settings -> Remote daemons: id/secret naming, input
 * validation and the wording of "Test connection" results. Kept out of the
 * Settings class so they are unit-testable and the screenshot harness can
 * reuse the exact strings.
 */
import type { RemoteDaemonConfig, RemoteVaultMapping } from '../types';
import type { ProbePathCheck, ProbeResult, ProbeWorkspaces } from './DaemonClient';
import { normalizePosixPath } from './vaultMapping';

export function slugifyDaemonName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'daemon';
}

/** A stable id derived from the name, made unique against the ones already configured. */
export function uniqueDaemonId(name: string, existing: readonly RemoteDaemonConfig[]): string {
  const base = slugifyDaemonName(name);
  const taken = new Set(existing.map((d) => d.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Env-var style name for the keychain entry; `secretStorageKey()` normalises it further. */
export function tokenSecretNameFor(id: string): string {
  return `AGENT_THREADS_DAEMON_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TOKEN`;
}

export type DaemonInputCheck = { ok: true; url: string } | { ok: false; field: 'name' | 'url' | 'token'; reason: string };

/** Accepts ws://, wss://, http://, https:// (and bare host:port, treated as ws://). */
export function checkDaemonInput(
  input: { name: string; url: string; token?: string; requireToken?: boolean },
  others: readonly RemoteDaemonConfig[],
  selfId?: string,
): DaemonInputCheck {
  const name = input.name.trim();
  if (!name) return { ok: false, field: 'name', reason: 'Give the daemon a name (it is shown on threads that run there).' };
  if (others.some((d) => d.id !== selfId && d.name.trim().toLowerCase() === name.toLowerCase())) {
    return { ok: false, field: 'name', reason: 'Another daemon already has that name.' };
  }
  const raw = input.url.trim();
  if (!raw) return { ok: false, field: 'url', reason: 'Enter the daemon address, for example wss://my-server.tailnet-name.ts.net:8443.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `ws://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, field: 'url', reason: 'That is not a valid address.' };
  }
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, field: 'url', reason: 'Use a ws://, wss://, http:// or https:// address.' };
  }
  if (parsed.username || parsed.password || parsed.search) {
    return { ok: false, field: 'url', reason: 'Do not put credentials in the address; the token goes in its own field.' };
  }
  if (input.requireToken && !(input.token ?? '').trim()) {
    return { ok: false, field: 'token', reason: 'Paste an access token created with `agent-threads token create`.' };
  }
  return { ok: true, url: withScheme.replace(/\/+$/, '') };
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** `*.ts.net` (MagicDNS), 100.64.0.0/10 (Tailscale IPv4) or fd7a:115c:a1e0::/48 (Tailscale IPv6). */
function isTailnetHost(host: string): boolean {
  if (host.endsWith('.ts.net')) return true;
  const v4 = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) return Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
  return host.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

/**
 * A warning for an address that sends the access token and every message in the clear to a host that is not
 * known to be on this machine or inside a Tailscale tunnel. `undefined` for wss/https and for loopback / tailnet
 * hosts. (A bare machine name could be a tailnet name; it cannot be told apart from a LAN name, so it is warned.)
 */
export function plainTransportWarning(rawUrl: string): string | undefined {
  const raw = rawUrl.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `ws://${raw}`);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'http:') return undefined;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isLoopbackHost(host) || isTailnetHost(host)) return undefined;
  return 'This address is plain ws://, so the access token and every message cross the network unencrypted. Use wss:// (for example through `tailscale serve`) unless this machine is only reachable over a VPN such as Tailscale.';
}

/** What the Edit/Add dialog gets back from Test connection. */
export interface DaemonTestOutcome {
  tone: 'ok' | 'error';
  text: string;
  /** What the daemon advertised (`workspaces.list`), when the connection worked. */
  discovery?: ProbeWorkspaces;
}

/** One line for the Test connection button. */
export function describeProbe(result: ProbeResult): { tone: 'ok' | 'error'; text: string } {
  if (result.ok) {
    const i = result.info;
    return { tone: 'ok', text: `Connected: agent-threads ${i.daemonVersion}, protocol ${i.protocol}` };
  }
  switch (result.status) {
    case 'unauthorized': return { tone: 'error', text: 'The daemon rejected this token. Create one with `agent-threads token create` on that machine.' };
    case 'incompatible': return { tone: 'error', text: `Incompatible: ${result.detail}` };
    default: return { tone: 'error', text: `Could not connect: ${result.detail}` };
  }
}

export type VaultMappingCheck =
  | { ok: true; mapping: RemoteVaultMapping | undefined }
  | { ok: false; field: 'localRoot' | 'remoteRoot'; reason: string };

/**
 * Validate the "Vault on this daemon" fields. Both blank = no mapping. The
 * remote root must be a real absolute folder (not "/", no `..`); the local
 * root is optional and defaults to this vault's root at use time.
 */
export function checkVaultMappingInput(input: { localRoot?: string; remoteRoot?: string }): VaultMappingCheck {
  const remoteRaw = (input.remoteRoot ?? '').trim();
  const localRaw = (input.localRoot ?? '').trim();
  if (!remoteRaw && !localRaw) return { ok: true, mapping: undefined };
  if (!remoteRaw) return { ok: false, field: 'remoteRoot', reason: 'Enter the vault folder on the daemon machine, or clear the local folder too.' };
  if (/(^|\/)\.\.(\/|$)/.test(remoteRaw)) return { ok: false, field: 'remoteRoot', reason: 'The vault folder on the daemon cannot contain "..".' };
  const remoteRoot = normalizePosixPath(remoteRaw);
  if (remoteRoot === undefined) return { ok: false, field: 'remoteRoot', reason: 'Use an absolute path on the daemon machine (it starts with "/"), for example /home/user/vault.' };
  if (remoteRoot === '/') return { ok: false, field: 'remoteRoot', reason: 'That is the whole disk. Use the vault folder itself, for example /home/user/vault.' };
  let localRoot: string | undefined;
  if (localRaw) {
    if (/(^|\/)\.\.(\/|$)/.test(localRaw)) return { ok: false, field: 'localRoot', reason: 'The local folder cannot contain "..".' };
    localRoot = normalizePosixPath(localRaw);
    if (localRoot === undefined) return { ok: false, field: 'localRoot', reason: 'Use an absolute path on this computer, or leave it blank to use this vault.' };
    if (localRoot === '/') return { ok: false, field: 'localRoot', reason: 'That is the whole disk. Leave it blank to use this vault.' };
  }
  return { ok: true, mapping: { remoteRoot, ...(localRoot ? { localRoot } : {}) } };
}

/** Wording for the vault-folder part of Test connection. */
export function describePathCheck(path: string, reply: ProbePathCheck): { tone: 'ok' | 'error'; text: string } {
  if ('failed' in reply) return { tone: 'error', text: `Connected, but checking ${path} failed: ${reply.failed}` };
  if ('unsupported' in reply) {
    return { tone: 'error', text: `Connected, but this daemon is too old to check folders. Update it, or just try a thread in ${path}.` };
  }
  if (!reply.allowed) {
    return { tone: 'error', text: `${path} is not inside a folder this daemon may use. Start it with --workspace ${path} (see docs/remote-daemon.md, "Working in the vault").` };
  }
  if (!reply.exists || !reply.isDirectory) {
    return { tone: 'error', text: `${path} does not exist on the daemon machine (or is not a folder).` };
  }
  return { tone: 'ok', text: `${path} is allowed on the daemon${reply.readOnly ? ' (read-only: edits are refused there)' : ''}.` };
}

/**
 * Test connection wording: the connection line, plus (when a vault folder is
 * configured and the daemon answered) whether that folder is usable. A bad
 * folder makes the whole test read as an error even though the socket is fine,
 * because a thread started there would be refused.
 */
export function describeTest(result: ProbeResult, remoteRoot?: string): { tone: 'ok' | 'error'; text: string } {
  const connection = describeProbe(result);
  if (!result.ok || !remoteRoot || !result.pathCheck) return connection;
  const folder = describePathCheck(remoteRoot, result.pathCheck);
  return { tone: folder.tone, text: `${connection.text}. ${folder.text}` };
}

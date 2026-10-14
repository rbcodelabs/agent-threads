/**
 * Pure helpers behind Settings -> Remote daemons: id/secret naming, input
 * validation and the wording of "Test connection" results. Kept out of the
 * Settings class so they are unit-testable and the screenshot harness can
 * reuse the exact strings.
 */
import type { RemoteDaemonConfig } from '../types';
import type { ProbeResult } from './DaemonClient';

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
  if (!raw) return { ok: false, field: 'url', reason: 'Enter the daemon address, for example wss://claude-box.tailnet.ts.net:8443.' };
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

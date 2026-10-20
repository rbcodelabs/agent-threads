/**
 * Local daemon: pure text and decision logic for the Settings block (status
 * line, buttons, disclosure, errors). No DOM, no Obsidian, so it is unit-tested
 * directly and the screenshot harness shows the same strings.
 */

import { RUNTIME_PKG_BYTES } from '../sandboxRuntime';
import type { LocalDaemonSnapshot } from './controller';
import type { DegradedReason } from './assess';
import { HARNESS_LABEL, LOCAL_HARNESSES, VAULT_GUEST_PATH, manualLoginCommand, normalizeHarnesses, type LocalHarness } from './spec';

export type LocalDaemonButtonId =
  | 'setup' | 'start' | 'stop' | 'restart' | 'reset' | 'update' | 'sign-in' | 'remove' | 'kill';

export interface LocalDaemonButton {
  id: LocalDaemonButtonId;
  label: string;
  cta?: boolean;
  danger?: boolean;
}

export type LocalDaemonTone = 'ok' | 'warn' | 'error' | 'muted';

/** One harness toggle with its observed state. Never carries a credential, only whether one exists. */
export interface HarnessRow {
  id: LocalHarness;
  label: string;
  enabled: boolean;
  /** The last enabled harness cannot be turned off (the daemon needs at least one). */
  locked: boolean;
  /** Plain-language CLI / sign-in state. */
  status: string;
  tone: LocalDaemonTone;
  /** The exact terminal line to run for a login that cannot be done from Settings. */
  command?: string;
  /** A Sign in button is offered (Codex device login from Settings). */
  signIn?: 'codex';
}

export interface LocalDaemonView {
  statusLabel: string;
  tone: LocalDaemonTone;
  /** Label/value rows under the status. */
  lines: Array<{ label: string; value: string }>;
  /** Per-harness toggles and state (empty while busy or on an unsupported Mac). */
  harnessRows: HarnessRow[];
  buttons: LocalDaemonButton[];
  /** A short explanation of what to do about a problem, when there is one. */
  hint?: string;
  /** The last failed operation, verbatim and trimmed. */
  error?: string;
  /** True while an operation is in flight: only Cancel is offered. */
  busy: boolean;
}

export const POSITIONING_NOTE =
  'Runs a daemon in an Apple container VM on this Mac. Threads you start with "Run on: This Mac (container)" keep running '
  + 'when Geode quits and re-attach when you return, inside a VM boundary.';

const DEGRADED_TEXT: Record<DegradedReason, { label: string; hint: string }> = {
  'health-down': { label: 'Not answering', hint: 'The container is up but the daemon does not answer. Restart it.' },
  'token-rejected': { label: 'Reconnecting', hint: 'The daemon rejected the stored access token. Start creates a new one.' },
  incompatible: { label: 'Needs an update', hint: 'This daemon and Agent Threads cannot talk to each other. Update the daemon.' },
  'credential-not-applied': { label: 'Applying Claude sign-in', hint: 'Your Claude sign-in is saved but the daemon has not picked it up yet. Start applies it.' },
};

function shorten(text: string, max = 600): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(t.length - max)}` : t;
}

export function formatProgress(p: { label: string; percent?: number; line?: string }): string {
  const pct = p.percent !== undefined ? ` ${p.percent}%` : '';
  return `${p.label}${pct}${p.line ? `: ${p.line}` : ''}`;
}

/** CLI and sign-in state per harness, from what was observed (a probe of the running container plus the Claude credential). */
export function buildHarnessRows(snap: LocalDaemonSnapshot): HarnessRow[] {
  const o = snap.observed;
  const enabled = normalizeHarnesses(snap.harnesses);
  const running = snap.assessment.status === 'running' || snap.assessment.status === 'needs-sign-in' || snap.assessment.status === 'degraded';
  return LOCAL_HARNESSES.map((id): HarnessRow => {
    const on = enabled.includes(id);
    const base = { id, label: HARNESS_LABEL[id], enabled: on, locked: on && enabled.length === 1 };
    if (!on) return { ...base, status: 'Off', tone: 'muted' };
    const probe = o.harnessProbe?.[id];
    const claudeSignedIn = o.credentialInKeychain || o.credentialInVolume;
    const signedIn = id === 'claude' ? claudeSignedIn : probe?.signedIn;
    if (!running || !probe) {
      const known = id === 'claude' ? (claudeSignedIn ? ', signed in' : ', not signed in yet') : '';
      return { ...base, status: running ? `CLI state unknown${known}` : `On; checked while the daemon runs${known}`, tone: 'muted' };
    }
    if (!probe.cli) return { ...base, status: 'CLI is not in the daemon image yet. Apply changes to rebuild it.', tone: 'warn' };
    if (signedIn) return { ...base, status: 'CLI installed, signed in', tone: 'ok' };
    if (id === 'claude') return { ...base, status: 'CLI installed, needs sign-in', tone: 'warn' };
    const command = manualLoginCommand(id, snap.containerName ?? 'agent-threads-local', snap.containerBinary);
    if (id === 'codex') return { ...base, status: 'CLI installed, not signed in', tone: 'warn', signIn: 'codex', command };
    return { ...base, status: 'CLI installed, not signed in. OpenCode\'s login is an interactive provider picker, so run this in a terminal:', tone: 'warn', command };
  });
}

export function buildLocalDaemonView(snap: LocalDaemonSnapshot): LocalDaemonView {
  const view = buildViewCore(snap);
  const hide = view.busy || snap.assessment.status === 'unsupported' || snap.assessment.status === 'conflict';
  return { ...view, harnessRows: hide ? [] : buildHarnessRows(snap) };
}

function buildViewCore(snap: LocalDaemonSnapshot): Omit<LocalDaemonView, 'harnessRows'> & { harnessRows?: HarnessRow[] } {
  const { assessment: a, observed: o } = snap;
  const error = snap.lastError ? shorten(snap.lastError.message) : undefined;
  const lines: LocalDaemonView['lines'] = [];
  const base = { lines, ...(error ? { error } : {}) };

  if (snap.busy) {
    return { ...base, statusLabel: snap.busy.label, tone: 'muted', buttons: [], busy: true };
  }
  if (a.status === 'unsupported') {
    return { ...base, statusLabel: 'Unavailable', tone: 'muted', buttons: [], busy: false, hint: o.unsupportedReason ?? 'This Mac cannot run the local daemon.' };
  }
  if (a.status === 'conflict') {
    return {
      ...base, statusLabel: 'Name conflict', tone: 'error', buttons: [], busy: false,
      hint: 'A container with the daemon\'s name exists but was not created by Agent Threads, so it was left alone. Remove or rename it with `container rm`, then reopen this page.',
    };
  }

  if (snap.vaultPath) lines.push({ label: 'Vault', value: `${snap.vaultPath} (read-write at ${VAULT_GUEST_PATH}; ${maskedList(snap)} read-only)` });
  if (snap.daemonVersion) lines.push({ label: 'Daemon', value: `v${snap.daemonVersion}${snap.daemonVersion === snap.pluginVersion ? '' : `, this plugin is v${snap.pluginVersion}`}` });
  if (snap.port !== undefined && a.status !== 'not-set-up') lines.push({ label: 'Address', value: `127.0.0.1:${snap.port} (this Mac only)` });

  const watchdogLine = watchdogLineFor(snap);
  if (watchdogLine) lines.push({ label: 'Auto-recovery', value: watchdogLine });

  const update: LocalDaemonButton | null = a.update === 'available' || a.update === 'required'
    ? { id: 'update', label: 'Update available', cta: a.update === 'required' }
    : null;
  const tail: LocalDaemonButton[] = [
    { id: 'reset', label: 'Reset daemon data', danger: true },
    { id: 'remove', label: 'Remove', danger: true },
  ];
  const updateHint = a.update === 'plugin-too-old' ? 'The daemon needs a newer Agent Threads. Update the plugin.' : undefined;

  switch (a.status) {
    case 'not-set-up':
      return { ...base, statusLabel: 'Not set up', tone: 'muted', buttons: [{ id: 'setup', label: 'Set up', cta: true }], busy: false };
    case 'stopped': {
      if (o.stoppedOutOfMemory) {
        return {
          ...base, statusLabel: 'Stopped: out of memory', tone: 'error', busy: false,
          buttons: [{ id: 'restart', label: 'Restart', cta: true }, ...(update ? [update] : []), ...tail],
          hint: OUT_OF_MEMORY_HINT,
        };
      }
      const buttons: LocalDaemonButton[] = [{ id: 'start', label: 'Start', cta: true }, ...(update ? [update] : []), ...tail];
      return { ...base, statusLabel: 'Stopped', tone: 'muted', buttons, busy: false, ...(a.needsSignIn ? { hint: 'Claude sign-in is still needed once it is running.' } : {}) };
    }
    case 'running':
      return {
        ...base, statusLabel: 'Running', tone: 'ok', busy: false,
        buttons: [{ id: 'stop', label: 'Stop' }, { id: 'restart', label: 'Restart' }, ...(update ? [update] : a.drift ? [{ id: 'update' as const, label: 'Apply changes', cta: true }] : []), ...tail],
        ...(a.drift ? { hint: 'Its settings (for example the harnesses) changed since it was created. Restart does not apply them; Apply changes does, and rebuilds the image if a CLI was added.' } : {}),
        ...(updateHint ? { hint: updateHint } : {}),
      };
    case 'needs-sign-in':
      return {
        ...base, statusLabel: 'Running, needs Claude sign-in', tone: 'warn', busy: false,
        buttons: [{ id: 'sign-in', label: 'Sign in to Claude', cta: true }, { id: 'stop', label: 'Stop' }, ...(update ? [update] : []), ...tail],
        hint: 'The daemon runs Claude in its own VM, so it needs its own sign-in. This opens a browser page and asks you to paste back a code.',
      };
    case 'degraded': {
      const d = DEGRADED_TEXT[a.degraded ?? 'health-down'];
      const primary: LocalDaemonButton = a.degraded === 'health-down' ? { id: 'restart', label: 'Restart', cta: true }
        : a.degraded === 'incompatible' ? { id: 'update', label: 'Update', cta: a.update !== 'plugin-too-old' }
          : { id: 'start', label: 'Start', cta: true };
      const stop: LocalDaemonButton = { id: 'stop', label: 'Stop' };
      const kill: LocalDaemonButton = { id: 'kill', label: 'Kill', danger: true };
      const buttons: LocalDaemonButton[] = a.update === 'plugin-too-old' && a.degraded === 'incompatible'
        ? [stop, kill, ...tail]
        : [primary, stop, kill, ...tail];
      return { ...base, statusLabel: d.label, tone: 'warn', buttons, busy: false, hint: updateHint ?? d.hint };
    }
    default:
      return { ...base, statusLabel: 'Unknown', tone: 'muted', buttons: [], busy: false };
  }
}

export const OUT_OF_MEMORY_HINT =
  'The daemon container was killed, most likely because the VM ran out of memory (exit 137). Restart starts it again. '
  + 'If this keeps happening, raise "Local daemon memory" in Settings and choose Update to recreate the container.';

/** `HH:MM` in the user's locale-independent 24-hour form. */
export function formatClockTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function watchdogLineFor(snap: LocalDaemonSnapshot): string | null {
  const w = snap.watchdog;
  if (!w) return null;
  if (w.status === 'recovering') return 'Restarting an unresponsive daemon';
  if (w.status === 'gave-up') return `Watchdog gave up after ${w.attempts} attempts. Use Restart or Kill, and check the logs.`;
  if (w.lastRestartAt !== undefined) return `Auto-restarted at ${formatClockTime(w.lastRestartAt)}${w.lastRestartOk === false ? ' (the restart did not finish)' : ''}`;
  return null;
}

function maskedList(snap: LocalDaemonSnapshot): string {
  const masked = snap.mounts.filter((m) => m.readOnly && m.guest.startsWith(`${VAULT_GUEST_PATH}/`)).map((m) => m.guest.slice(VAULT_GUEST_PATH.length + 1));
  return masked.length > 0 ? masked.join(' and ') : 'no config folders';
}

// ── Confirmation text ────────────────────────────────────────────────────────

/** What the image build downloads for an enabled set, in words. */
export function agentClis(harnesses?: readonly string[]): string {
  const set = normalizeHarnesses(harnesses);
  const parts = [
    ...(set.includes('claude') ? ['the Claude CLI from Anthropic'] : []),
    ...(set.includes('codex') ? ['the Codex CLI from npm (@openai/codex)'] : []),
    ...(set.includes('opencode') ? ['the OpenCode CLI from npm (opencode-ai)'] : []),
  ];
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
}

/** Disclosure shown before Set up: what is downloaded, what is mounted and how, and what the VM can reach. */
export function describeSetup(snap: LocalDaemonSnapshot): string {
  const o = snap.observed;
  const items: string[] = [];
  if (!o.runtimeInstalled) items.push(`the container runtime (about ${Math.round(RUNTIME_PKG_BYTES / 1e6)} MB) and a Linux kernel`);
  if (!o.imageReady) items.push(`the daemon image from ghcr.io (several hundred MB) and, while building the final layer, ${agentClis(snap.harnesses)}`);
  const download = items.length > 0 ? `This downloads ${items.join(' and ')}. ` : 'Nothing needs downloading. ';
  const vault = snap.vaultPath ?? 'your vault';
  const masked = maskedList(snap);
  const external = snap.mounts.filter((m) => m.guest.startsWith('/ext/'));
  const shared = snap.mounts.filter((m) => m.guest.startsWith('/work/'));
  const sharedNote = shared.length > 0
    ? `The folders you share (${shared.map((m) => m.host).join(', ')}) are mounted READ-WRITE at ${shared.map((m) => m.guest).join(', ')}: an agent there can edit or delete anything in them. `
    : '';
  const externalNote = external.length > 0
    ? `Your connected folders ${external.map((m) => m.host).join(', ')} are mounted READ-ONLY at ${external.map((m) => m.guest).join(', ')}. `
    : '';
  return `${download}It then starts a VM on this Mac that runs the agent-threads daemon, reachable only from this Mac (127.0.0.1). `
    + `Your vault ${vault} is mounted READ-WRITE, so an agent in the VM can edit or delete any note: keep vault backups or sync history. `
    + `${masked === 'no config folders' ? '' : `${masked} are mounted read-only so an agent cannot change plugins or settings. `}`
    + sharedNote
    + externalNote
    + 'Tools that write, schedule or touch secrets on this Mac stay off for its threads unless you switch a group on in Settings (each call then asks you first). '
    + 'The VM has full outbound network access. If you use Geode\'s GitHub connection, a short-lived GitHub token (refreshed while Geode is open, expiring after 15 minutes) is copied into the VM so git and gh work there. Continue?';
}

export const DESCRIBE_RESET =
  'This stops the daemon and deletes its data: sessions, journals, workspaces volume and access token. Threads that ran there '
  + 'stay in your transcript list but cannot resume their Claude session. It is then set up again from scratch. Continue?';

export const DESCRIBE_KILL =
  'This force-stops the daemon without letting it shut down cleanly, and ends the container\'s VM process if it does not respond. '
  + 'Any turn running right now is lost and resumes on your next message. Data is kept. Continue?';

export const DESCRIBE_REMOVE =
  'This stops and deletes the local daemon, its data and its access token, and removes it from Remote daemons. Threads that ran '
  + 'there stay in your list but cannot continue. Your Claude sign-in is kept. Continue?';

export function describeUpdate(pluginVersion: string, harnesses?: readonly string[]): string {
  return `This downloads the daemon image for v${pluginVersion}, rebuilds the layer that adds ${agentClis(harnesses)}, and replaces the container. Its data and access token are kept. `
    + 'Any turn running right now is interrupted and resumes on your next message. Continue?';
}

export function describeRestart(): string {
  return 'Any turn running right now is interrupted and resumes on your next message. Continue?';
}

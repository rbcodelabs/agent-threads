/**
 * Settings, MCP: the "Runs on" control of one Custom MCP server. A per-daemon toggle that opts the server in to being
 * synced to that daemon (`remote/mcpSync.ts`), the reason when it cannot be, the confirmation that shows exactly what
 * leaves this Mac, and a status chip fed by the engine and by what the daemon's sessions reported
 * (`plugin.daemonMcpStatus`).
 *
 * `buildRunsOnRows` and `describeSyncConfirmation` are pure and unit-tested; the rest is DOM.
 */
import { Modal, type App } from 'obsidian';
import type { McpServerStatusEntry } from './ClaudeSession';
import type { McpSyncEngine, McpSyncServerStatus, ServerEvaluation } from './remote/mcpSync';
import type { RemoteDaemonConfig } from './types';

export interface RunsOnChip { kind: 'ok' | 'warn' | 'bad' | 'neutral'; text: string }

export interface RunsOnRow {
  daemonId: string;
  daemonName: string;
  checked: boolean;
  disabled: boolean;
  /** Why the toggle is disabled (or, when it is on, what is wrong). */
  reason?: string;
  chip?: RunsOnChip;
  /** An extra line, for example "shadowed by config.json". */
  note?: string;
  action?: 'push-now' | 'review';
}

const MISSING_CREDENTIAL = /^missing credential\b/;

function chipFor(status: McpSyncServerStatus, reported: McpServerStatusEntry | undefined): { chip: RunsOnChip; action?: RunsOnRow['action']; note?: string } {
  switch (status.state) {
    case 'off': return { chip: { kind: 'neutral', text: 'Off' } };
    case 'pending': return { chip: { kind: 'neutral', text: 'Syncing…' } };
    case 'needs-confirm': return { chip: { kind: 'warn', text: 'Changed: review to sync' }, action: 'review' };
    case 'missing-secret': return { chip: { kind: 'warn', text: `Secret ${status.names.join(', ')} is not set on this Mac` } };
    case 'blocked': return { chip: { kind: 'bad', text: status.reason } };
    case 'rejected': return { chip: { kind: 'bad', text: `Refused by the daemon: ${status.reason}` } };
    case 'error': return { chip: { kind: 'bad', text: status.reason } };
    case 'synced': {
      const note = status.shadowed ? 'Shadowed by config.json: the daemon uses its own server of this name.' : undefined;
      if (!reported) return { chip: { kind: 'neutral', text: 'Synced; not started yet' }, ...(note ? { note } : {}) };
      if (reported.status === 'connected') return { chip: { kind: 'ok', text: 'Connected' }, ...(note ? { note } : {}) };
      if (reported.status === 'needs-auth') return { chip: { kind: 'warn', text: 'Needs sign-in' }, ...(note ? { note } : {}) };
      const err = reported.error ?? '';
      return {
        chip: { kind: 'bad', text: `Failed${err ? `: ${err}` : ''}` },
        ...(MISSING_CREDENTIAL.test(err) ? { action: 'push-now' as const } : {}),
        ...(note ? { note } : {}),
      };
    }
  }
}

export function buildRunsOnRows(input: {
  engine: Pick<McpSyncEngine, 'availability' | 'statusOf' | 'entryOf'>;
  daemons: readonly RemoteDaemonConfig[];
  server: ServerEvaluation;
  reported(daemonId: string): readonly McpServerStatusEntry[] | undefined;
}): RunsOnRow[] {
  const { engine, server } = input;
  return input.daemons.map((d): RunsOnRow => {
    const enabled = engine.entryOf(d.id, server.name)?.enabled === true;
    const base = { daemonId: d.id, daemonName: d.name, checked: enabled };
    const avail = engine.availability(d.id, server);
    if (!enabled) {
      if (server.blocked) return { ...base, disabled: true, reason: `Cannot run elsewhere: ${server.blocked.reason}.` };
      if (!avail.ok) return { ...base, disabled: true, reason: avail.reason };
      return { ...base, disabled: false };
    }
    const reported = input.reported(d.id)?.find((s) => s.name === server.name);
    const { chip, action, note } = chipFor(engine.statusOf(d.id, server.name), reported);
    return { ...base, disabled: false, chip, ...(action ? { action } : {}), ...(note ? { note } : {}), ...(!avail.ok ? { reason: avail.reason } : {}) };
  });
}

// ── confirmation ─────────────────────────────────────────────────────────────

export interface SyncConfirmation {
  title: string;
  serverName: string;
  daemonName: string;
  type: 'stdio' | 'http' | 'sse';
  /** Label/value rows: the exact command and arguments, or the URL. */
  details: Array<{ label: string; value: string }>;
  /** Names only, never values. */
  envNames: string[];
  headerNames: string[];
  /** Keychain secrets whose VALUES will be stored on the daemon. */
  secretNames: string[];
  warnings: string[];
}

export function describeSyncConfirmation(ev: ServerEvaluation, daemon: Pick<RemoteDaemonConfig, 'name' | 'managed'>): SyncConfirmation | undefined {
  const def = ev.stored;
  if (!def || ev.blocked) return undefined;
  const warnings: string[] = [];
  if (def.type === 'stdio') warnings.push(`This starts a program on ${daemon.name}, as the daemon's user, for every thread that runs there.`);
  else warnings.push(`Threads on ${daemon.name} connect to this endpoint and send its headers.`);
  if (ev.limitedToProject) warnings.push('Its secrets are limited to one project on this Mac, but a daemon cannot tell projects apart: every thread on this daemon can use the server and so the secrets.');
  if (ev.secretNames.length) warnings.push(`The secret values are stored on ${daemon.name} for up to 30 days and renewed while Agent Threads is open. Turning the server off removes them.`);
  return {
    title: `Run "${ev.name}" on ${daemon.name}?`,
    serverName: ev.name,
    daemonName: daemon.name,
    type: def.type,
    details: def.type === 'stdio'
      ? [{ label: 'Command', value: def.command }, ...(def.args?.length ? [{ label: 'Arguments', value: def.args.join(' ') }] : [])]
      : [{ label: 'URL', value: def.url }],
    envNames: def.type === 'stdio' ? Object.keys(def.env ?? {}) : [],
    headerNames: def.type === 'stdio' ? [] : Object.keys(def.headers ?? {}),
    secretNames: ev.secretNames,
    warnings,
  };
}

export class McpSyncConfirmModal extends Modal {
  private confirmed = false;
  private resolved = false;
  constructor(app: App, private readonly info: SyncConfirmation, private readonly onResult: (confirmed: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    const { info } = this;
    this.contentEl.addClass('ct-mcp-sync-confirm');
    this.contentEl.createEl('h2', { text: info.title });
    this.contentEl.createEl('p', { text: `This sends the definition of this server to ${info.daemonName} and starts it there. It is sent again whenever you change it, and you will be asked to confirm each change.` });
    const list = this.contentEl.createEl('dl', { cls: 'ct-mcp-sync-confirm-details' });
    const row = (label: string, value: string, mono = true): void => {
      list.createEl('dt', { text: label });
      list.createEl('dd', { text: value, cls: mono ? 'ct-mcp-sync-confirm-mono' : '' });
    };
    row('Type', info.type, false);
    for (const d of info.details) row(d.label, d.value);
    if (info.envNames.length) row('Environment variables (names)', info.envNames.join(', '));
    if (info.headerNames.length) row('Headers (names)', info.headerNames.join(', '));
    row('Secrets that leave this Mac', info.secretNames.length ? info.secretNames.join(', ') : 'None', info.secretNames.length > 0);
    row('Sent to', info.daemonName, false);
    const warn = this.contentEl.createEl('ul', { cls: 'ct-mcp-sync-confirm-warnings' });
    for (const w of info.warnings) warn.createEl('li', { text: w });
    const buttons = this.contentEl.createDiv({ cls: 'ct-mcp-registration-buttons' });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    buttons.createEl('button', { text: `Run on ${info.daemonName}`, cls: 'mod-cta' }).addEventListener('click', () => {
      this.confirmed = true;
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.resolved) return;
    this.resolved = true;
    this.onResult(this.confirmed);
  }
}

// ── DOM ──────────────────────────────────────────────────────────────────────

export interface RunsOnHost {
  app: App;
  engine: McpSyncEngine;
  daemons(): readonly RemoteDaemonConfig[];
  reported(daemonId: string): readonly McpServerStatusEntry[] | undefined;
  /** Redraw the list after something changed. */
  rerender(): void;
}

function askConfirmation(host: RunsOnHost, ev: ServerEvaluation, daemon: RemoteDaemonConfig): Promise<boolean> {
  const info = describeSyncConfirmation(ev, daemon);
  if (!info) return Promise.resolve(false);
  return new Promise((resolve) => new McpSyncConfirmModal(host.app, info, resolve).open());
}

/** The "Runs on" block under one server row. Renders nothing when there is no daemon to run it on. */
export function renderMcpRunsOn(parent: HTMLElement, host: RunsOnHost, ev: ServerEvaluation): void {
  const daemons = host.daemons();
  if (daemons.length === 0) return;
  const rows = buildRunsOnRows({ engine: host.engine, daemons, server: ev, reported: (id) => host.reported(id) });
  const wrap = parent.createDiv({ cls: 'ct-mcp-runson', attr: { role: 'group', 'aria-label': `Where ${ev.name} runs` } });
  wrap.createSpan({ cls: 'ct-mcp-runson-label', text: 'Runs on' });
  wrap.createSpan({ cls: 'ct-mcp-runson-local', text: 'This computer' });
  for (const r of rows) {
    const daemon = daemons.find((d) => d.id === r.daemonId)!;
    const line = wrap.createDiv({ cls: 'ct-mcp-runson-row' });
    const label = line.createEl('label', { cls: `ct-mcp-runson-toggle${r.disabled ? ' is-disabled' : ''}` });
    const box = label.createEl('input', { attr: { type: 'checkbox', 'aria-label': `Run ${ev.name} on ${r.daemonName}` } });
    box.checked = r.checked;
    box.disabled = r.disabled;
    label.createSpan({ text: r.daemonName });
    box.addEventListener('change', () => {
      void (async () => {
        const entry = host.engine.entryOf(r.daemonId, ev.name);
        if (!box.checked) { await host.engine.setEnabled(r.daemonId, ev.name, false); host.rerender(); return; }
        // Re-enabling the exact definition confirmed earlier needs no second prompt.
        if (entry?.confirmedHash === ev.hash) { await host.engine.setEnabled(r.daemonId, ev.name, true); host.rerender(); return; }
        if (!await askConfirmation(host, ev, daemon)) { box.checked = false; return; }
        await host.engine.setEnabled(r.daemonId, ev.name, true, ev.hash);
        host.rerender();
      })();
    });
    if (r.chip) line.createSpan({ cls: `ct-mcp-runson-chip ct-mcp-runson-chip--${r.chip.kind}`, text: r.chip.text });
    if (r.action === 'push-now') {
      const b = line.createEl('button', { cls: 'ct-mcp-runson-action', text: 'Push now', attr: { 'aria-label': `Push ${ev.name} credentials to ${r.daemonName} now` } });
      b.addEventListener('click', () => { b.disabled = true; void host.engine.pushNow(r.daemonId).finally(() => host.rerender()); });
    }
    if (r.action === 'review') {
      const b = line.createEl('button', { cls: 'ct-mcp-runson-action', text: 'Review', attr: { 'aria-label': `Review the changed ${ev.name} for ${r.daemonName}` } });
      b.addEventListener('click', () => {
        void (async () => {
          if (!await askConfirmation(host, ev, daemon)) return;
          await host.engine.setEnabled(r.daemonId, ev.name, true, ev.hash);
          host.rerender();
        })();
      });
    }
    if (r.reason) line.createDiv({ cls: 'ct-mcp-runson-reason', text: r.reason });
    if (r.note) line.createDiv({ cls: 'ct-mcp-runson-reason', text: r.note });
  }
}

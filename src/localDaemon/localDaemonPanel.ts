/**
 * Local daemon: the Settings -> Remote block. DOM only; every side effect comes
 * from injected deps, so it is tested in jsdom with no runtime, no Obsidian
 * `Modal` and no network.
 *
 * Mobile renders nothing at all (not even a heading): a loopback daemon on this
 * Mac is meaningless there.
 */

import type { LocalDaemonProgress, LocalDaemonSnapshot, SignInHandlers } from './controller';
import type { LocalHarness } from './spec';
import { LocalDaemonAbortedError } from './provision';
import {
  DESCRIBE_KILL,
  DESCRIBE_REMOVE,
  DESCRIBE_RESET,
  POSITIONING_NOTE,
  buildLocalDaemonView,
  describeRestart,
  describeSetup,
  describeUpdate,
  formatProgress,
  type LocalDaemonButtonId,
} from './view';

export interface LocalDaemonPanelDeps {
  /** Desktop-only: where this is true, `renderLocalDaemonPanel` renders nothing. */
  isMobile: boolean;
  snapshot(): Promise<LocalDaemonSnapshot>;
  /**
   * Cheap facts only (container state, port, healthz; no `exec` probes). Rendered first so the panel is useful
   * while the full {@link snapshot} is still running, or never finishes because the container VM is wedged.
   */
  snapshotQuick?(): Promise<LocalDaemonSnapshot>;
  /** How long a snapshot may take before the panel gives up on it and shows the recovery buttons. Default 15 s. */
  snapshotTimeoutMs?: number;
  /** Called on every state or progress change. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Resolves true only on an explicit "Continue". */
  confirm(message: string): Promise<boolean>;
  run(id: Exclude<LocalDaemonButtonId, 'sign-in'>, opts: { onProgress: (p: LocalDaemonProgress) => void }): Promise<unknown>;
  signIn(handlers: SignInHandlers): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Codex device-code login inside the container (URL and one-time code; nothing to paste back). */
  signInHarness?(harness: 'codex', handlers: Pick<SignInHandlers, 'onProgress' | 'onUrl'>): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Store the enabled harnesses (applied to the container by Apply changes / Start). */
  setHarnesses?(harnesses: LocalHarness[]): Promise<unknown>;
  cancel(): void;
  /** Hide or show the whole block (the Setting row around it). Hidden on a Mac that cannot run the runtime. */
  setVisible?(visible: boolean): void;
  /** Opens the sign-in page; the link in the panel is the fallback. */
  openUrl?(url: string): void;
  pluginVersion: string;
  /**
   * Managed policy: the administrator's reason the local daemon may not be created or started, or undefined. The
   * panel then says so and disables the buttons that would create or start the container. Stop, Kill and Remove stay
   * available (policy never deletes a container, and never blocks a user from removing their own).
   */
  managedBlock?(): string | undefined;
}

export interface LocalDaemonPanel {
  /** Null on mobile. */
  el: HTMLElement | null;
  refresh(): Promise<void>;
}

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 15_000;

/** Buttons that create or start the container; disabled while managed policy forbids the local daemon. */
const MANAGED_BLOCKED_BUTTONS: ReadonlySet<LocalDaemonButtonId> = new Set<LocalDaemonButtonId>(['setup', 'start', 'restart', 'update', 'reset', 'sign-in']);

class SnapshotTimeoutError extends Error {
  constructor(ms: number) { super(`the container runtime did not answer within ${Math.round(ms / 1000)} seconds`); }
}

/** Buttons that must stay reachable when nothing is known about the daemon: the recovery path for a wedged VM. */
const RECOVERY_BUTTONS: Array<{ id: LocalDaemonButtonId; label: string; cta?: boolean; danger?: boolean }> = [
  { id: 'stop', label: 'Stop' },
  { id: 'restart', label: 'Restart', cta: true },
  { id: 'kill', label: 'Kill', danger: true },
];

export function renderLocalDaemonPanel(parent: HTMLElement, deps: LocalDaemonPanelDeps): LocalDaemonPanel {
  if (deps.isMobile) return { el: null, refresh: async () => undefined };

  const root = parent.createDiv('ct-local-daemon');
  root.createDiv({ cls: 'ct-local-daemon-note setting-item-description', text: POSITIONING_NOTE });
  const managedEl = root.createDiv({ cls: 'ct-managed-note', attr: { role: 'status' } });
  const refreshManagedNote = (): string | undefined => {
    const reason = deps.managedBlock?.();
    managedEl.setText(reason ? `Managed by your administrator: ${reason}` : '');
    managedEl.toggleClass('is-visible', !!reason);
    return reason;
  };
  const statusEl = root.createDiv('ct-local-daemon-status');
  const linesEl = root.createDiv('ct-local-daemon-lines');
  const harnessEl = root.createDiv('ct-local-daemon-harnesses');
  const hintEl = root.createDiv('ct-local-daemon-hint setting-item-description');
  const errorEl = root.createDiv('ct-local-daemon-error');
  const progressEl = root.createDiv('ct-local-daemon-progress');
  const actionsEl = root.createDiv('ct-local-daemon-actions');
  const signInEl = root.createDiv('ct-local-daemon-signin');

  let localError: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let wasConnected = false;
  let hasRendered = false;
  let refreshing = false;
  let queued = false;

  const render = (snap: LocalDaemonSnapshot): void => {
    // An unsupported Mac (Intel, macOS < 26, no on-disk vault) gets no block at all rather than a dead one.
    const unsupported = snap.assessment.status === 'unsupported';
    root.toggleClass('is-hidden', unsupported);
    deps.setVisible?.(!unsupported);
    refreshManagedNote();
    const view = buildLocalDaemonView(snap);
    statusEl.empty();
    statusEl.createSpan({ cls: 'ct-local-daemon-status-label', text: 'Status: ' });
    statusEl.createSpan({ cls: `ct-local-daemon-status-value ct-local-daemon-tone-${view.tone}`, text: view.statusLabel });
    linesEl.empty();
    for (const l of view.lines) {
      const row = linesEl.createDiv('ct-local-daemon-line');
      row.createSpan({ cls: 'ct-local-daemon-label', text: `${l.label}: ` });
      row.createSpan({ cls: 'ct-local-daemon-value', text: l.value });
    }
    renderHarnesses(view);
    hintEl.setText(view.hint ?? '');
    const shownError = localError ?? view.error ?? '';
    errorEl.setText(shownError);
    errorEl.toggleClass('is-visible', shownError.length > 0);
    progressEl.setText(snap.busy ? formatProgress(snap.busy) : '');
    actionsEl.empty();
    if (view.busy) {
      const cancel = actionsEl.createEl('button', { cls: 'ct-local-daemon-btn', text: 'Cancel' });
      cancel.addEventListener('click', () => deps.cancel());
      return;
    }
    for (const b of view.buttons) addButton(b, snap);
  };

  const addButton = (b: { id: LocalDaemonButtonId; label: string; cta?: boolean; danger?: boolean }, snap: LocalDaemonSnapshot | null): void => {
    const btn = actionsEl.createEl('button', {
      cls: `ct-local-daemon-btn ct-local-daemon-btn-${b.id}${b.cta ? ' mod-cta' : ''}${b.danger ? ' mod-warning' : ''}`,
      text: b.label,
    });
    const blocked = refreshManagedNote();
    if (blocked && MANAGED_BLOCKED_BUTTONS.has(b.id)) {
      btn.disabled = true;
      btn.title = blocked;
    }
    btn.addEventListener('click', () => { void act(b.id, snap); });
  };

  /** Status plus the recovery buttons, for when there is no (usable) snapshot: still loading, or it failed. */
  const renderUnknown = (statusText: string, tone: 'muted' | 'error', detail?: string): void => {
    statusEl.empty();
    statusEl.createSpan({ cls: 'ct-local-daemon-status-label', text: 'Status: ' });
    statusEl.createSpan({ cls: `ct-local-daemon-status-value ct-local-daemon-tone-${tone}`, text: statusText });
    linesEl.empty();
    harnessEl.empty();
    hintEl.setText(tone === 'error' ? 'If the daemon is stuck, Restart tries a graceful stop, then a force kill, then ends the container’s VM process. Kill skips the graceful stop.' : '');
    const shownError = localError ?? detail ?? '';
    errorEl.setText(shownError);
    errorEl.toggleClass('is-visible', shownError.length > 0);
    progressEl.setText('');
    actionsEl.empty();
    for (const b of RECOVERY_BUTTONS) addButton(b, null);
  };

  const withTimeout = <T,>(p: Promise<T>): Promise<T> => {
    const ms = deps.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SnapshotTimeoutError(ms)), ms);
      p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
  };

  const renderHarnesses = (view: ReturnType<typeof buildLocalDaemonView>): void => {
    harnessEl.empty();
    if (view.harnessRows.length === 0) return;
    harnessEl.createDiv({ cls: 'ct-local-daemon-harness-title', text: 'Agent harnesses' });
    for (const r of view.harnessRows) {
      const row = harnessEl.createDiv(`ct-local-daemon-harness ct-local-daemon-harness-${r.id}`);
      const label = row.createEl('label', { cls: 'ct-local-daemon-harness-toggle' });
      const box = label.createEl('input', { type: 'checkbox' });
      box.checked = r.enabled;
      box.disabled = r.locked || !deps.setHarnesses;
      label.createSpan({ cls: 'ct-local-daemon-harness-name', text: ` ${r.label}` });
      row.createSpan({ cls: `ct-local-daemon-harness-status ct-local-daemon-tone-${r.tone}`, text: ` ${r.status}` });
      box.addEventListener('change', () => {
        const next = view.harnessRows.filter((x) => (x.id === r.id ? box.checked : x.enabled)).map((x) => x.id);
        localError = null;
        void (async () => {
          try { await deps.setHarnesses?.(next); } catch (err) { localError = err instanceof Error ? err.message : String(err); }
          await refresh();
        })();
      });
      if (r.signIn && deps.signInHarness) {
        const btn = row.createEl('button', { cls: 'ct-local-daemon-btn ct-local-daemon-btn-sign-in-codex', text: `Sign in to ${r.label}` });
        btn.addEventListener('click', () => { void signInHarness(r.signIn!); });
      }
      if (r.command) row.createEl('code', { cls: 'ct-local-daemon-harness-command', text: r.command });
    }
  };

  const refresh = async (): Promise<void> => {
    // The settings page re-renders from scratch; stop listening once this block has been removed from the page.
    if (root.isConnected) wasConnected = true;
    else if (wasConnected) { unsubscribe?.(); unsubscribe = null; return; }
    // Coalesce: progress events arrive fast, the snapshot does several CLI calls.
    if (refreshing) { queued = true; return; }
    refreshing = true;
    try {
      do {
        queued = false;
        let shown = false;
        // First paint only: later refreshes keep the previous view on screen rather than flashing a loading state.
        if (!hasRendered) renderUnknown('Checking…', 'muted');
        if (deps.snapshotQuick) {
          try { render(await withTimeout(deps.snapshotQuick())); shown = true; hasRendered = true; } catch { /* the full snapshot below reports */ }
        }
        try {
          render(await withTimeout(deps.snapshot()));
          hasRendered = true;
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          // A quick view already on screen stays (it has the buttons); otherwise show the recovery state.
          if (!shown) renderUnknown('Can’t reach the daemon', 'error', why);
          else errorEl.setText(`Some details could not be checked: ${why}`), errorEl.toggleClass('is-visible', true);
        }
      } while (queued);
    } finally {
      refreshing = false;
    }
  };

  const confirmFor = (id: LocalDaemonButtonId, snap: LocalDaemonSnapshot | null): string | null => {
    if (id === 'kill') return DESCRIBE_KILL;
    // Nothing is known about the daemon: Restart is the recovery, so it is always confirmed.
    if (snap === null) return id === 'restart' ? describeRestart() : null;
    switch (id) {
      case 'setup': return describeSetup(snap);
      case 'update': return describeUpdate(deps.pluginVersion, snap.harnesses);
      case 'reset': return DESCRIBE_RESET;
      case 'remove': return DESCRIBE_REMOVE;
      case 'restart': return snap.assessment.status === 'running' ? describeRestart() : null;
      default: return null;
    }
  };

  const act = async (id: LocalDaemonButtonId, snap: LocalDaemonSnapshot | null): Promise<void> => {
    localError = null;
    const message = confirmFor(id, snap);
    if (message && !(await deps.confirm(message))) return;
    try {
      if (id === 'sign-in') await signIn();
      else await deps.run(id, { onProgress: () => undefined });
    } catch (err) {
      // A cancel is not a failure; a real failure is also kept on the controller (lastError) for the next render.
      if (!(err instanceof LocalDaemonAbortedError)) localError = err instanceof Error ? err.message : String(err);
    }
    await refresh();
  };

  const signInHarness = async (harness: 'codex'): Promise<void> => {
    localError = null;
    signInEl.empty();
    const link = signInEl.createDiv('ct-local-daemon-signin-link');
    const status = signInEl.createDiv('ct-local-daemon-signin-status');
    const result = await deps.signInHarness!(harness, {
      onProgress: (text) => status.setText(text),
      onUrl: (url) => {
        link.empty();
        link.createEl('a', { text: 'Browser didn’t open? Open the sign-in page', href: url, attr: { target: '_blank', rel: 'noopener' } });
        try { deps.openUrl?.(url); } catch { /* the link is the fallback */ }
      },
    });
    signInEl.empty();
    if (!result.ok) localError = result.error;
    await refresh();
  };

  const signIn = async (): Promise<void> => {
    signInEl.empty();
    const link = signInEl.createDiv('ct-local-daemon-signin-link');
    const status = signInEl.createDiv('ct-local-daemon-signin-status');
    const result = await deps.signIn({
      onProgress: (text) => status.setText(text),
      onUrl: (url) => {
        link.empty();
        link.createEl('a', { text: 'Browser didn’t open? Open the sign-in page', href: url, attr: { target: '_blank', rel: 'noopener' } });
        try { deps.openUrl?.(url); } catch { /* the link is the fallback */ }
      },
      onCodePrompt: () => new Promise<string | null>((resolve) => {
        const wrap = signInEl.createDiv('ct-local-daemon-code');
        wrap.createDiv({ cls: 'ct-local-daemon-code-label', text: 'Paste the login code shown in your browser:' });
        const row = wrap.createDiv('ct-local-daemon-code-row');
        const input = row.createEl('input', { type: 'text', placeholder: 'Login code' });
        const submit = row.createEl('button', { cls: 'ct-local-daemon-btn mod-cta', text: 'Submit' });
        const cancel = row.createEl('button', { cls: 'ct-local-daemon-btn', text: 'Cancel' });
        const finish = (value: string | null) => { wrap.remove(); resolve(value); };
        submit.addEventListener('click', () => finish(input.value.trim() || null));
        cancel.addEventListener('click', () => finish(null));
        input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') finish(input.value.trim() || null); });
        input.focus();
      }),
    });
    signInEl.empty();
    if (!result.ok) localError = result.error;
  };

  unsubscribe = deps.subscribe(() => { void refresh(); });
  void refresh();
  return { el: root, refresh };
}

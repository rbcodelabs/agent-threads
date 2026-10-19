/**
 * Local daemon: the Settings -> Remote block. DOM only; every side effect comes
 * from injected deps, so it is tested in jsdom with no runtime, no Obsidian
 * `Modal` and no network (the `sandboxSetupPanel.ts` pattern).
 *
 * Mobile renders nothing at all (not even a heading): a loopback daemon on this
 * Mac is meaningless there.
 */

import type { LocalDaemonProgress, LocalDaemonSnapshot, SignInHandlers } from './controller';
import type { LocalHarness } from './spec';
import { LocalDaemonAbortedError } from './provision';
import {
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
}

export interface LocalDaemonPanel {
  /** Null on mobile. */
  el: HTMLElement | null;
  refresh(): Promise<void>;
}

export function renderLocalDaemonPanel(parent: HTMLElement, deps: LocalDaemonPanelDeps): LocalDaemonPanel {
  if (deps.isMobile) return { el: null, refresh: async () => undefined };

  const root = parent.createDiv('ct-local-daemon');
  root.createDiv({ cls: 'ct-local-daemon-note setting-item-description', text: POSITIONING_NOTE });
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
  let refreshing = false;
  let queued = false;

  const render = (snap: LocalDaemonSnapshot): void => {
    // An unsupported Mac (Intel, macOS < 26, no on-disk vault) gets no block at all rather than a dead one.
    const unsupported = snap.assessment.status === 'unsupported';
    root.toggleClass('is-hidden', unsupported);
    deps.setVisible?.(!unsupported);
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
    for (const b of view.buttons) {
      const btn = actionsEl.createEl('button', {
        cls: `ct-local-daemon-btn ct-local-daemon-btn-${b.id}${b.cta ? ' mod-cta' : ''}${b.danger ? ' mod-warning' : ''}`,
        text: b.label,
      });
      btn.addEventListener('click', () => { void act(b.id, snap); });
    }
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
        try {
          render(await deps.snapshot());
        } catch (err) {
          statusEl.empty();
          statusEl.createSpan({ text: `Could not check the local daemon: ${err instanceof Error ? err.message : String(err)}` });
        }
      } while (queued);
    } finally {
      refreshing = false;
    }
  };

  const confirmFor = (id: LocalDaemonButtonId, snap: LocalDaemonSnapshot): string | null => {
    switch (id) {
      case 'setup': return describeSetup(snap);
      case 'update': return describeUpdate(deps.pluginVersion, snap.harnesses);
      case 'reset': return DESCRIBE_RESET;
      case 'remove': return DESCRIBE_REMOVE;
      case 'restart': return snap.assessment.status === 'running' ? describeRestart() : null;
      default: return null;
    }
  };

  const act = async (id: LocalDaemonButtonId, snap: LocalDaemonSnapshot): Promise<void> => {
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

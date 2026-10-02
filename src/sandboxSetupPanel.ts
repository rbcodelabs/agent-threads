/**
 * sandboxSetupPanel.ts — DOM for the two places a user can start the sandbox
 * setup: the Settings status block and the one-time in-thread offer card.
 *
 * Both share `runSetupFlow` (confirm → run → progress → outcome) and get every
 * side effect through injected deps, so they are tested in jsdom with no
 * runtime, no Obsidian `Modal`, and no network. The Obsidian-specific wiring
 * (the confirm `Modal`, settings persistence) lives in the callers.
 */

import {
  SandboxSetupAbortedError,
  SandboxSetupError,
  estimateSetup,
  type SandboxSetupProgress,
  type SandboxSetupResult,
  type SandboxSetupStatus,
} from './sandboxSetup';
import { buildSandboxSetupView, errorTail, formatSetupProgress } from './sandboxSetupView';

// ── Shared flow ──────────────────────────────────────────────────────────────

export interface SandboxSetupFlowDeps {
  getStatus(): Promise<SandboxSetupStatus>;
  run(opts: { onProgress: (p: SandboxSetupProgress) => void; signal: AbortSignal }): Promise<SandboxSetupResult>;
  /** Resolves true only on an explicit "Continue"; dismissal is false. */
  confirm(message: string): Promise<boolean>;
}

export type SandboxSetupOutcome =
  | { kind: 'declined' }
  | { kind: 'cancelled' }
  | { kind: 'done'; result: SandboxSetupResult }
  | { kind: 'failed'; stepLabel: string; message: string };

const FAILED_STEP_LABEL: Record<string, string> = {
  check: 'Check',
  runtime: 'Step 1 of 3 (install the runtime)',
  start: 'Step 2 of 3 (start the runtime)',
  images: 'Step 3 of 3 (prepare the image)',
};

/**
 * Confirms with an honest download estimate, then runs setup. Never throws:
 * every result — including a bug — comes back as an outcome so the UI can
 * always re-enable its button.
 */
export async function runSetupFlow(
  deps: SandboxSetupFlowDeps,
  status: SandboxSetupStatus,
  signal: AbortSignal,
  onProgress: (p: SandboxSetupProgress) => void,
): Promise<SandboxSetupOutcome> {
  if (!(await deps.confirm(`${estimateSetup(status)} Continue?`))) return { kind: 'declined' };
  try {
    const result = await deps.run({ onProgress, signal });
    return { kind: 'done', result };
  } catch (err) {
    if (err instanceof SandboxSetupAbortedError || signal.aborted) return { kind: 'cancelled' };
    if (err instanceof SandboxSetupError) {
      return { kind: 'failed', stepLabel: FAILED_STEP_LABEL[err.step] ?? err.step, message: errorTail(err.detail) };
    }
    return { kind: 'failed', stepLabel: 'Setup', message: errorTail(err instanceof Error ? err.message : String(err)) };
  }
}

// ── Settings block ───────────────────────────────────────────────────────────

export const SIGN_IN_NOTE =
  'Claude sign-in still happens once, inside the container: the first time a routed thread needs it, a '
  + '"Sign in to Claude" card walks through the container\'s own `claude setup-token` (open a URL, paste back a '
  + 'login code) — a host `claude auth login` never reaches a process running inside the sandbox.';

export interface SandboxSettingsPanelDeps extends SandboxSetupFlowDeps {
  /** Desktop-only feature: on mobile the block explains that and offers no button. */
  isMobile: boolean;
  /**
   * Removes the local images and re-runs setup from scratch. When provided
   * (with `resetMessage`), an installed runtime also gets a "Reset sandbox" button.
   */
  reset?(opts: { onProgress: (p: SandboxSetupProgress) => void; signal: AbortSignal }): Promise<SandboxSetupResult>;
  /** Confirmation text for the reset; shown instead of the download estimate. */
  resetMessage?: string;
}

export interface SandboxSettingsPanel {
  el: HTMLElement;
  refresh(): Promise<void>;
}

export function renderSandboxSettingsPanel(parent: HTMLElement, deps: SandboxSettingsPanelDeps): SandboxSettingsPanel {
  const root = parent.createDiv('ct-sandbox-setup');
  const linesEl = root.createDiv('ct-sandbox-setup-lines');
  const noteEl = root.createDiv('ct-sandbox-setup-note');
  const actionsEl = root.createDiv('ct-sandbox-setup-actions');
  const progressEl = root.createDiv('ct-sandbox-setup-progress');
  const errorEl = root.createDiv('ct-sandbox-setup-error');
  noteEl.setText(SIGN_IN_NOTE);
  let busy = false;

  const line = (label: string, value: string) => {
    const row = linesEl.createDiv('ct-sandbox-setup-line');
    row.createSpan({ cls: 'ct-sandbox-setup-label', text: `${label}: ` });
    row.createSpan({ cls: 'ct-sandbox-setup-value', text: value });
  };

  const refresh = async (): Promise<void> => {
    linesEl.empty();
    actionsEl.empty();
    if (deps.isMobile) {
      linesEl.createDiv({ cls: 'ct-sandbox-setup-line', text: 'Sandbox VMs are desktop-only and are not available on mobile.' });
      return;
    }
    linesEl.createDiv({ cls: 'ct-sandbox-setup-line', text: 'Checking…' });
    let status: SandboxSetupStatus;
    try {
      status = await deps.getStatus();
    } catch (err) {
      linesEl.empty();
      linesEl.createDiv({ cls: 'ct-sandbox-setup-line', text: `Could not check the sandbox: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    linesEl.empty();
    const view = buildSandboxSetupView(status);
    line('Runtime', view.runtimeLine);
    if (!status.supported) return;
    line('Service', view.serviceLine);
    line('Sandbox image', view.imageLine);
    const buttons: HTMLButtonElement[] = [];
    if (view.buttonLabel) {
      const button = actionsEl.createEl('button', { cls: 'mod-cta ct-sandbox-setup-btn', text: view.buttonLabel });
      button.addEventListener('click', () => { void start(status, buttons, false); });
      buttons.push(button);
    }
    if (deps.reset && status.runtime === 'installed') {
      const resetBtn = actionsEl.createEl('button', { cls: 'ct-sandbox-reset-btn', text: 'Reset sandbox' });
      resetBtn.addEventListener('click', () => { void start(status, buttons, true); });
      buttons.push(resetBtn);
    }
  };

  const start = async (status: SandboxSetupStatus, buttons: HTMLButtonElement[], reset: boolean): Promise<void> => {
    if (busy) return;
    busy = true;
    const setButtonsDisabled = (disabled: boolean) => { for (const b of buttons) b.disabled = disabled; };
    setButtonsDisabled(true);
    errorEl.empty();
    progressEl.empty();
    const controller = new AbortController();
    const cancel: { btn: HTMLButtonElement | null } = { btn: null };
    const outcome = await runSetupFlow(
      {
        ...deps,
        ...(reset && deps.reset ? { run: deps.reset } : {}),
        // Show Cancel only once the run really starts (after the user confirmed).
        confirm: async (msg) => {
          const ok = await deps.confirm(reset && deps.resetMessage ? deps.resetMessage : msg);
          if (ok) {
            const btn = cancel.btn = actionsEl.createEl('button', { cls: 'ct-sandbox-setup-cancel', text: 'Cancel' });
            btn.addEventListener('click', () => { btn.disabled = true; controller.abort(); });
            progressEl.setText('Starting…');
          }
          return ok;
        },
      },
      status,
      controller.signal,
      (p) => progressEl.setText(formatSetupProgress(p)),
    );
    cancel.btn?.remove();
    busy = false;
    switch (outcome.kind) {
      case 'declined':
        setButtonsDisabled(false);
        return;
      case 'cancelled':
        progressEl.setText('Setup cancelled.');
        setButtonsDisabled(false);
        return;
      case 'failed':
        progressEl.empty();
        errorEl.createDiv({ cls: 'ct-sandbox-setup-error-title', text: `${outcome.stepLabel} failed` });
        errorEl.createEl('pre', { cls: 'ct-sandbox-setup-error-tail', text: outcome.message });
        setButtonsDisabled(false);
        return;
      case 'done':
        progressEl.setText('Sandbox ready. New sessions will run inside it.');
        await refresh();
        return;
    }
  };

  void refresh();
  return { el: root, refresh };
}

// ── In-thread offer card ─────────────────────────────────────────────────────

export interface SandboxOfferCardDeps extends SandboxSetupFlowDeps {
  onNotNow(): void;
  onDontAskAgain(): void;
}

export const SANDBOX_OFFER_TITLE = 'Run this thread in a sandbox?';
export const SANDBOX_OFFER_BODY = 'Setting it up takes a few minutes and a one-time download.';
export const SANDBOX_OFFER_DONE =
  'Sandbox ready. This thread is still running on your Mac; the next time its session starts it will run inside the sandbox.';

/**
 * One-time card offering the sandbox when a thread fell back to the host
 * because it isn't set up. The thread keeps running meanwhile; nothing here
 * blocks it. Removes itself on "Not now" / "Don't ask again".
 */
export function renderSandboxOfferCard(parent: HTMLElement, deps: SandboxOfferCardDeps): HTMLElement {
  const card = parent.createDiv('ct-message ct-sandbox-offer');
  card.createDiv({ cls: 'ct-sandbox-offer-title', text: SANDBOX_OFFER_TITLE });
  card.createDiv({ cls: 'ct-sandbox-offer-body', text: SANDBOX_OFFER_BODY });
  const actions = card.createDiv('ct-sandbox-offer-actions');
  const progressEl = card.createDiv('ct-sandbox-offer-progress');
  const errorEl = card.createDiv('ct-sandbox-offer-error');

  const setUpBtn = actions.createEl('button', { cls: 'mod-cta ct-sandbox-offer-setup', text: 'Set up sandbox' });
  const notNowBtn = actions.createEl('button', { cls: 'ct-sandbox-offer-notnow', text: 'Not now' });
  const neverBtn = actions.createEl('button', { cls: 'ct-sandbox-offer-never', text: 'Don\'t ask again' });
  const setChoicesDisabled = (disabled: boolean) => {
    setUpBtn.disabled = disabled; notNowBtn.disabled = disabled; neverBtn.disabled = disabled;
  };

  notNowBtn.addEventListener('click', () => { card.remove(); deps.onNotNow(); });
  neverBtn.addEventListener('click', () => { card.remove(); deps.onDontAskAgain(); });

  let busy = false;
  setUpBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    setChoicesDisabled(true);
    errorEl.empty();
    progressEl.empty();
    const controller = new AbortController();
    const cancel: { btn: HTMLButtonElement | null } = { btn: null };
    let outcome: SandboxSetupOutcome;
    try {
      const status = await deps.getStatus();
      outcome = await runSetupFlow(
        {
          ...deps,
          confirm: async (msg) => {
            const ok = await deps.confirm(msg);
            if (ok) {
              const btn = cancel.btn = actions.createEl('button', { cls: 'ct-sandbox-offer-cancel', text: 'Cancel' });
              btn.addEventListener('click', () => { btn.disabled = true; controller.abort(); });
              progressEl.setText('Starting…');
            }
            return ok;
          },
        },
        status,
        controller.signal,
        (p) => progressEl.setText(formatSetupProgress(p)),
      );
    } catch (err) {
      outcome = { kind: 'failed', stepLabel: 'Check', message: errorTail(err instanceof Error ? err.message : String(err)) };
    }
    cancel.btn?.remove();
    busy = false;
    switch (outcome.kind) {
      case 'declined':
        setChoicesDisabled(false);
        return;
      case 'cancelled':
        progressEl.setText('Setup cancelled.');
        setChoicesDisabled(false);
        return;
      case 'failed':
        progressEl.empty();
        errorEl.createDiv({ cls: 'ct-sandbox-offer-error-title', text: `${outcome.stepLabel} failed` });
        errorEl.createEl('pre', { cls: 'ct-sandbox-offer-error-tail', text: outcome.message });
        setChoicesDisabled(false);
        return;
      case 'done': {
        actions.empty();
        progressEl.setText(SANDBOX_OFFER_DONE);
        const dismiss = actions.createEl('button', { cls: 'ct-sandbox-offer-dismiss', text: 'Dismiss' });
        dismiss.addEventListener('click', () => { card.remove(); deps.onNotNow(); });
        return;
      }
    }
  });

  return card;
}

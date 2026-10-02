/**
 * @vitest-environment jsdom
 *
 * The Settings status block and the in-thread offer card, driven with injected
 * deps (no Obsidian Modal, no runtime).
 */
import '../setup/obsidian-dom';
import { describe, it, expect, vi } from 'vitest';
import {
  SANDBOX_OFFER_BODY,
  SANDBOX_OFFER_DONE,
  SANDBOX_OFFER_TITLE,
  SIGN_IN_NOTE,
  renderSandboxOfferCard,
  renderSandboxSettingsPanel,
  runSetupFlow,
  type SandboxSetupFlowDeps,
} from '../../src/sandboxSetupPanel';
import {
  SandboxSetupAbortedError,
  SandboxSetupError,
  type SandboxSetupProgress,
  type SandboxSetupResult,
  type SandboxSetupStatus,
} from '../../src/sandboxSetup';

const flush = () => new Promise((r) => setTimeout(r, 0));

const FRESH: SandboxSetupStatus = { supported: true, runtime: 'missing', running: false, images: { base: 'unknown', harness: 'unknown' } };
const READY: SandboxSetupStatus = {
  supported: true, runtime: 'installed', runtimeSource: 'managed', runtimeVersion: '1.5.0', running: true, images: { base: 'ok', harness: 'ok' },
};
const RESULT: SandboxSetupResult = { installedRuntime: true, startedRuntime: true, pulledBase: true, builtHarness: true, stepsRun: ['runtime', 'start', 'images'] };
const PROGRESS: SandboxSetupProgress = { step: 'start', stepNumber: 2, totalSteps: 3, label: 'Starting the runtime' };

function flowDeps(over: Partial<SandboxSetupFlowDeps> = {}) {
  const statuses = [FRESH];
  const deps = {
    getStatus: vi.fn(async () => statuses[Math.min(statuses.length - 1, deps.getStatus.mock.calls.length - 1)]!),
    run: vi.fn(async ({ onProgress }: Parameters<SandboxSetupFlowDeps['run']>[0]) => { onProgress(PROGRESS); return RESULT; }),
    confirm: vi.fn(async () => true),
    ...over,
  };
  return { deps: deps as unknown as SandboxSetupFlowDeps & { getStatus: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn> }, statuses };
}

const btn = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const text = (root: HTMLElement, sel: string) => root.querySelector(sel)?.textContent ?? '';

describe('runSetupFlow', () => {
  it('confirms with the estimate first; declining runs nothing', async () => {
    const { deps } = flowDeps({ confirm: vi.fn(async () => false) });
    const out = await runSetupFlow(deps, FRESH, new AbortController().signal, () => {});
    expect(out).toEqual({ kind: 'declined' });
    expect(deps.confirm).toHaveBeenCalledWith(expect.stringMatching(/^This will download .*several hundred MB.* Continue\?$/));
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('maps a SandboxSetupError to a failure naming the step, with an output tail', async () => {
    const { deps } = flowDeps({ run: vi.fn(async () => { throw new SandboxSetupError('start', 'container system start failed: boom'); }) });
    const out = await runSetupFlow(deps, FRESH, new AbortController().signal, () => {});
    expect(out).toEqual({ kind: 'failed', stepLabel: 'Step 2 of 3 (start the runtime)', message: 'container system start failed: boom' });
  });

  it('maps an abort to cancelled, and any unexpected throw to a failure (never throws)', async () => {
    const abortDeps = flowDeps({ run: vi.fn(async () => { throw new SandboxSetupAbortedError(); }) }).deps;
    expect(await runSetupFlow(abortDeps, FRESH, new AbortController().signal, () => {})).toEqual({ kind: 'cancelled' });
    const boomDeps = flowDeps({ run: vi.fn(async () => { throw new Error('kaboom'); }) }).deps;
    expect(await runSetupFlow(boomDeps, FRESH, new AbortController().signal, () => {}))
      .toMatchObject({ kind: 'failed', message: 'kaboom' });
  });
});

describe('renderSandboxSettingsPanel', () => {
  async function mount(status: SandboxSetupStatus, over: Partial<SandboxSetupFlowDeps> = {}, isMobile = false) {
    const parent = document.createElement('div');
    const { deps } = flowDeps({ getStatus: vi.fn(async () => status), ...over });
    const panel = renderSandboxSettingsPanel(parent, { ...deps, isMobile });
    await flush();
    return { parent, panel, deps, root: panel.el };
  }

  it('shows the three status lines, the sign-in sentence, and a "Set up sandbox" button on a fresh Mac', async () => {
    const { root } = await mount(FRESH);
    const lines = [...root.querySelectorAll('.ct-sandbox-setup-line')].map((l) => l.textContent);
    expect(lines).toEqual(['Runtime: Not installed', 'Service: Stopped', 'Sandbox image: Needs setup']);
    expect(text(root, '.ct-sandbox-setup-note')).toBe(SIGN_IN_NOTE);
    expect(btn(root, 'Set up sandbox')).toBeDefined();
  });

  it('unsupported: shows the reason and no button', async () => {
    const { root } = await mount({ ...FRESH, supported: false, reason: 'Sandboxed VMs require macOS 26 or later.' });
    expect(root.querySelector('button')).toBeNull();
    expect(text(root, '.ct-sandbox-setup-line')).toContain('Unsupported: Sandboxed VMs require macOS 26 or later.');
  });

  it('mobile: explains desktop-only, offers no button, and never probes the runtime', async () => {
    const { root, deps } = await mount(FRESH, {}, true);
    expect(root.querySelector('button')).toBeNull();
    expect(root.textContent).toContain('desktop-only');
    expect(deps.getStatus).not.toHaveBeenCalled();
  });

  it('ready: no button', async () => {
    const { root } = await mount(READY);
    expect(root.querySelector('button')).toBeNull();
    expect(root.textContent).toContain('Managed by Agent Threads (v1.5.0)');
  });

  it('a failing status read shows a message instead of throwing', async () => {
    const { root } = await mount(FRESH, { getStatus: vi.fn(async () => { throw new Error('nope'); }) });
    expect(root.textContent).toContain('Could not check the sandbox: nope');
  });

  it('declining the confirm leaves the button enabled and runs nothing', async () => {
    const { root, deps } = await mount(FRESH, { confirm: vi.fn(async () => false) });
    btn(root, 'Set up sandbox')!.click();
    await flush();
    expect(deps.run).not.toHaveBeenCalled();
    expect(btn(root, 'Set up sandbox')!.disabled).toBe(false);
  });

  it('runs after confirm, shows live progress and a Cancel button, then refreshes the status on success', async () => {
    let finish!: (r: SandboxSetupResult) => void;
    const statuses = [FRESH, READY];
    let call = 0;
    const { root, deps } = await mount(FRESH, {
      getStatus: vi.fn(async () => statuses[Math.min(call++, statuses.length - 1)]!),
      run: vi.fn(({ onProgress }) => { onProgress(PROGRESS); return new Promise<SandboxSetupResult>((r) => { finish = r; }); }),
    });
    const button = btn(root, 'Set up sandbox')!;
    button.click();
    await flush();
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(text(root, '.ct-sandbox-setup-progress')).toBe('Step 2 of 3 — Starting the runtime…');
    expect(btn(root, 'Cancel')).toBeDefined();
    finish(RESULT);
    await flush();
    expect(btn(root, 'Cancel')).toBeUndefined();
    expect(text(root, '.ct-sandbox-setup-progress')).toContain('Sandbox ready');
    expect(root.textContent).toContain('Image: Ready'.replace('Image', 'Sandbox image'));
    expect(root.querySelector('.ct-sandbox-setup-btn')).toBeNull();
  });

  it('Cancel aborts the signal handed to the run and re-enables the button', async () => {
    let signal!: AbortSignal;
    const { root } = await mount(FRESH, {
      run: vi.fn(({ signal: s }) => new Promise<SandboxSetupResult>((_res, rej) => {
        signal = s;
        s.addEventListener('abort', () => rej(new SandboxSetupAbortedError()));
      })),
    });
    const button = btn(root, 'Set up sandbox')!;
    button.click();
    await flush();
    btn(root, 'Cancel')!.click();
    await flush();
    expect(signal.aborted).toBe(true);
    expect(text(root, '.ct-sandbox-setup-progress')).toBe('Setup cancelled.');
    expect(button.disabled).toBe(false);
    expect(btn(root, 'Cancel')).toBeUndefined();
  });

  it('a failure shows the step name and error tail and re-enables the button', async () => {
    const { root } = await mount(FRESH, { run: vi.fn(async () => { throw new SandboxSetupError('images', 'Building x failed (exit 1):\nno space left'); }) });
    const button = btn(root, 'Set up sandbox')!;
    button.click();
    await flush();
    expect(text(root, '.ct-sandbox-setup-error-title')).toBe('Step 3 of 3 (prepare the image) failed');
    expect(text(root, '.ct-sandbox-setup-error-tail')).toContain('no space left');
    expect(button.disabled).toBe(false);
  });

  it('ignores a second click while a run is active', async () => {
    const { root, deps } = await mount(FRESH, { run: vi.fn(() => new Promise<SandboxSetupResult>(() => {})) });
    const button = btn(root, 'Set up sandbox')!;
    button.click();
    await flush();
    button.click();
    await flush();
    expect(deps.run).toHaveBeenCalledTimes(1);
  });
});

describe('Reset sandbox button', () => {
  async function mount(status: SandboxSetupStatus, withReset = true, isMobile = false) {
    const parent = document.createElement('div');
    const { deps } = flowDeps({ getStatus: vi.fn(async () => status) });
    const reset = vi.fn(async ({ onProgress }: Parameters<SandboxSetupFlowDeps['run']>[0]) => { onProgress(PROGRESS); return RESULT; });
    const panel = renderSandboxSettingsPanel(parent, {
      ...deps, isMobile, ...(withReset ? { reset, resetMessage: 'RESET MSG' } : {}),
    });
    await flush();
    return { root: panel.el, deps, reset };
  }

  it('is offered when the runtime is installed, even when the sandbox looks ready', async () => {
    const { root } = await mount(READY);
    expect(btn(root, 'Reset sandbox')).toBeDefined();
    expect(root.querySelector('.ct-sandbox-setup-btn')).toBeNull();
  });

  it('is not offered without a runtime, on mobile, or without a reset dep', async () => {
    expect(btn((await mount(FRESH)).root, 'Reset sandbox')).toBeUndefined();
    expect(btn((await mount(READY, true, true)).root, 'Reset sandbox')).toBeUndefined();
    expect(btn((await mount(READY, false)).root, 'Reset sandbox')).toBeUndefined();
  });

  it('confirms with the reset message, then runs reset (not setup) with progress', async () => {
    const { root, deps, reset } = await mount(READY);
    btn(root, 'Reset sandbox')!.click();
    await flush();
    expect(deps.confirm).toHaveBeenCalledWith('RESET MSG');
    expect(reset).toHaveBeenCalledTimes(1);
    expect(deps.run).not.toHaveBeenCalled();
    expect(text(root, '.ct-sandbox-setup-progress')).toContain('Sandbox ready');
  });

  it('declining the confirm runs nothing and re-enables the button', async () => {
    const { root, deps, reset } = await mount(READY);
    (deps.confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const b = btn(root, 'Reset sandbox')!;
    b.click();
    await flush();
    expect(reset).not.toHaveBeenCalled();
    expect(b.disabled).toBe(false);
  });

  it('a reset failure shows the step and error tail and re-enables the button', async () => {
    const { root, reset } = await mount(READY);
    reset.mockRejectedValue(new SandboxSetupError('images', 'Could not remove an image'));
    const b = btn(root, 'Reset sandbox')!;
    b.click();
    await flush();
    expect(text(root, '.ct-sandbox-setup-error-title')).toContain('failed');
    expect(text(root, '.ct-sandbox-setup-error-tail')).toContain('Could not remove an image');
    expect(b.disabled).toBe(false);
  });
});

describe('renderSandboxOfferCard', () => {
  function mount(over: Partial<SandboxSetupFlowDeps> = {}) {
    const parent = document.createElement('div');
    const { deps } = flowDeps({ getStatus: vi.fn(async () => FRESH), ...over });
    const cb = { onNotNow: vi.fn(), onDontAskAgain: vi.fn() };
    const card = renderSandboxOfferCard(parent, { ...deps, ...cb });
    return { parent, card, deps, cb };
  }

  it('shows the prompt copy and the three buttons', () => {
    const { card } = mount();
    expect(text(card, '.ct-sandbox-offer-title')).toBe(SANDBOX_OFFER_TITLE);
    expect(SANDBOX_OFFER_TITLE).toBe('Run this thread in a sandbox?');
    expect(text(card, '.ct-sandbox-offer-body')).toBe(SANDBOX_OFFER_BODY);
    expect(SANDBOX_OFFER_BODY).toBe('Setting it up takes a few minutes and a one-time download.');
    expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Set up sandbox', 'Not now', 'Don\'t ask again']);
  });

  it('"Not now" removes the card and reports it, without persisting anything', () => {
    const { card, parent, cb } = mount();
    btn(card, 'Not now')!.click();
    expect(parent.contains(card)).toBe(false);
    expect(cb.onNotNow).toHaveBeenCalledTimes(1);
    expect(cb.onDontAskAgain).not.toHaveBeenCalled();
  });

  it('"Don\'t ask again" removes the card and reports the permanent dismissal', () => {
    const { card, parent, cb } = mount();
    btn(card, 'Don\'t ask again')!.click();
    expect(parent.contains(card)).toBe(false);
    expect(cb.onDontAskAgain).toHaveBeenCalledTimes(1);
    expect(cb.onNotNow).not.toHaveBeenCalled();
  });

  it('"Set up sandbox" confirms, runs with progress in the card, then explains the NEXT session start will use it', async () => {
    let finish!: (r: SandboxSetupResult) => void;
    const { card, deps, cb } = mount({
      run: vi.fn(({ onProgress }) => { onProgress(PROGRESS); return new Promise<SandboxSetupResult>((r) => { finish = r; }); }),
    });
    btn(card, 'Set up sandbox')!.click();
    await flush();
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(text(card, '.ct-sandbox-offer-progress')).toBe('Step 2 of 3 — Starting the runtime…');
    expect(btn(card, 'Cancel')).toBeDefined();
    expect(btn(card, 'Not now')!.disabled).toBe(true); // choices locked while running
    finish(RESULT);
    await flush();
    expect(text(card, '.ct-sandbox-offer-progress')).toBe(SANDBOX_OFFER_DONE);
    expect(SANDBOX_OFFER_DONE).toContain('next time its session starts');
    expect(cb.onNotNow).not.toHaveBeenCalled();
    btn(card, 'Dismiss')!.click();
    expect(cb.onNotNow).toHaveBeenCalledTimes(1);
  });

  it('a declined confirm restores the choices; a failure shows the step and keeps the card usable', async () => {
    const declined = mount({ confirm: vi.fn(async () => false) });
    btn(declined.card, 'Set up sandbox')!.click();
    await flush();
    expect(btn(declined.card, 'Set up sandbox')!.disabled).toBe(false);

    const failed = mount({ run: vi.fn(async () => { throw new SandboxSetupError('runtime', 'Downloaded runtime failed its SHA-256 check.'); }) });
    btn(failed.card, 'Set up sandbox')!.click();
    await flush();
    expect(text(failed.card, '.ct-sandbox-offer-error-title')).toBe('Step 1 of 3 (install the runtime) failed');
    expect(btn(failed.card, 'Set up sandbox')!.disabled).toBe(false);
  });

  it('a status read that throws is reported as a failure, not an unhandled rejection', async () => {
    const { card } = mount({ getStatus: vi.fn(async () => { throw new Error('probe blew up'); }) });
    btn(card, 'Set up sandbox')!.click();
    await flush();
    expect(text(card, '.ct-sandbox-offer-error-tail')).toContain('probe blew up');
    expect(btn(card, 'Not now')!.disabled).toBe(false);
  });
});

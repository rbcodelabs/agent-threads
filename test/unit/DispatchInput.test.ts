/**
 * DispatchInput.test.ts
 * @vitest-environment jsdom
 *
 * Regression guard for the PTT wiring bug (PR #126 dropped, PR #136 restored):
 * when `getPttKey` is provided to DispatchInput, mount() must call
 * attachPttToTextarea() on the SttController instance. If that call is ever
 * dropped again, this test will fail immediately.
 */

import '../setup/obsidian-dom'; // Polyfill Obsidian's HTMLElement extensions for jsdom

// vi.mock calls must be hoisted above the imports they affect.
import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock fs so DispatchInput.loadSkills() doesn't try to read the real filesystem.
vi.mock('fs', () => ({
  default: {
    readdirSync: () => [],
    statSync: () => ({ isDirectory: () => false }),
    existsSync: () => false,
    readFileSync: () => '',
  },
  readdirSync: () => [],
  statSync: () => ({ isDirectory: () => false }),
  existsSync: () => false,
  readFileSync: () => '',
}));

// Mock SttController so we can spy on attachPttToTextarea without needing a
// real browser microphone or MediaRecorder. createMicButton must return a
// real HTMLButtonElement so DispatchInput can insert it into the DOM.
//
// The factory keeps a module-level `lastInstance` reference that each test
// reads after calling mount(). Using a proper `function` constructor ensures
// `new SttController()` works correctly.
vi.mock('../../src/stt', () => {
  let lastInstance: MockSttInstance | null = null;

  interface MockSttInstance {
    attachPttToTextarea: ReturnType<typeof vi.fn>;
    createMicButton: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }

  function SttController() {
    lastInstance = {
      attachPttToTextarea: vi.fn(() => () => {}),
      createMicButton: vi.fn(() => document.createElement('button')),
      destroy: vi.fn(),
    };
    return lastInstance;
  }

  // Expose a getter so tests can read the most-recently-created instance.
  (SttController as unknown as { getLastInstance: () => MockSttInstance | null }).getLastInstance =
    () => lastInstance;

  return { SttController };
});

import { DispatchInput } from '../../src/DispatchInput';
import { SttController } from '../../src/stt';
import { App } from 'obsidian';
import { SlashCommandRegistry } from '../../src/SlashCommandContributions';

describe('live contributed command discovery', () => {
  it('refreshes an open dropdown, restores shadowed skills and revokes a selected pill', () => {
    const registry = new SlashCommandRegistry();
    const unsubscribe = vi.fn();
    const input = new DispatchInput({ app: new App(), onSend: vi.fn(),
      builtinCommands: () => registry.list('dispatch'),
      subscribeCommands: listener => { const off = registry.subscribe(listener); return () => { off(); unsubscribe(); }; },
    });
    const root = input.mount(document.createElement('div'));
    input.setAvailableCommands([{ name: 'board', description: 'Underlying skill' }]);
    const textarea = root.querySelector('textarea')!;
    input.setValue('/');
    textarea.dispatchEvent(new Event('input'));
    expect(root.textContent).toContain('Underlying skill');
    const registration = registry.register({ pluginId: 'peer' }, { name: 'board', dispatch: {
      description: 'Peer command', invoke: async () => ({ status: 'ok' }),
    } });
    expect(root.textContent).toContain('Peer command');
    expect(root.textContent).not.toContain('Underlying skill');
    input.setValue('/board draft');
    expect(root.querySelector('.ct-command-pill')).not.toBeNull();
    registration.dispose();
    expect(input.getValue()).toBe('/board draft');
    expect(root.querySelector('.ct-command-pill')).toBeNull();
    input.setValue('/');
    textarea.dispatchEvent(new Event('input'));
    expect(root.textContent).toContain('Underlying skill');
    input.destroy();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

// Type helper: the mock factory attaches getLastInstance() to SttController.
type MockSttConstructor = typeof SttController & {
  getLastInstance: () => {
    attachPttToTextarea: ReturnType<typeof vi.fn>;
    createMicButton: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  } | null;
};

const MockSttController = SttController as unknown as MockSttConstructor;

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeApp(): App {
  return new App();
}

function makeContainer(): HTMLElement {
  return document.createElement('div');
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DispatchInput — PTT wiring', () => {
  it('calls attachPttToTextarea when getPttKey is provided', () => {
    const getPttKey = () => 'ctrl+shift+space';
    const di = new DispatchInput({
      app: makeApp(),
      onSend: vi.fn(),
      getPttKey,
    });

    di.mount(makeContainer());

    const stt = MockSttController.getLastInstance()!;
    expect(stt.attachPttToTextarea).toHaveBeenCalledOnce();
    // First arg must be the textarea, second must be the exact getter passed in.
    const [textarea, keyGetter] = stt.attachPttToTextarea.mock.calls[0];
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    expect(keyGetter).toBe(getPttKey);
  });

  it('does NOT call attachPttToTextarea when getPttKey is omitted', () => {
    const di = new DispatchInput({
      app: makeApp(),
      onSend: vi.fn(),
      // no getPttKey — mic button still created, PTT not wired
    });

    di.mount(makeContainer());

    const stt = MockSttController.getLastInstance()!;
    expect(stt.attachPttToTextarea).not.toHaveBeenCalled();
  });

  it('still creates a mic button regardless of getPttKey', () => {
    const di = new DispatchInput({
      app: makeApp(),
      onSend: vi.fn(),
    });

    di.mount(makeContainer());

    const stt = MockSttController.getLastInstance()!;
    expect(stt.createMicButton).toHaveBeenCalledOnce();
  });
});

// Regression guard for the /escalate popup-registration fix: builtinCommands
// must also accept a resolver function so a settings-derived list (e.g. the
// escalation command, which can be renamed/disabled at runtime) is re-read
// on every keystroke instead of being frozen at construction time.
describe('DispatchInput — dynamic builtinCommands', () => {
  function typeAndTriggerInput(root: HTMLElement, value: string): void {
    const textarea = root.querySelector('textarea')!;
    textarea.value = value;
    textarea.dispatchEvent(new Event('input'));
  }

  it('still converts a static builtinCommands array into a pill (existing behavior)', () => {
    const di = new DispatchInput({
      app: makeApp(),
      onSend: vi.fn(),
      builtinCommands: [{ name: 'goal', description: 'set a goal' }],
    });
    const root = di.mount(makeContainer());

    typeAndTriggerInput(root, '/goal ');

    expect(root.querySelector('.ct-command-pill')).toBeTruthy();
    expect(di.getValue()).toBe('/goal ');
  });

  it('accepts a resolver function for builtinCommands', () => {
    const commands = [{ name: 'escalate', description: 'escalate this turn' }];
    const di = new DispatchInput({
      app: makeApp(),
      onSend: vi.fn(),
      builtinCommands: () => commands,
    });
    const root = di.mount(makeContainer());

    typeAndTriggerInput(root, '/escalate ');

    expect(root.querySelector('.ct-command-pill')).toBeTruthy();
    expect(di.getValue()).toBe('/escalate ');
  });

  it('re-invokes the resolver on every keystroke, reflecting a list that changes at runtime', () => {
    let commands: { name: string; description: string }[] = [
      { name: 'escalate', description: 'escalate this turn' },
    ];
    const di = new DispatchInput({
      app: makeApp(),
      onSend: vi.fn(),
      builtinCommands: () => commands,
    });
    const root = di.mount(makeContainer());

    // Simulate the user disabling escalation in Settings between keystrokes —
    // no re-mount, no event bus, just a plain list mutation.
    commands = [];
    typeAndTriggerInput(root, '/escalate ');

    // No matching builtin command anymore, so no pill is created and the
    // raw text stays in the textarea as a plain (non-intercepted) prompt.
    expect(root.querySelector('.ct-command-pill')).toBeFalsy();
    expect(di.getValue()).toBe('/escalate ');
  });
});

// Regression guard for peer-registered slash commands supplying their own
// argument completions: getArgQuery() must fall back to peerArgCompletions
// only when the static built-in argCompletions record has no entry for that
// command name — built-ins always win, no merging.
describe('DispatchInput — peer argument completions', () => {
  function typeAndTriggerInput(root: HTMLElement, value: string): void {
    const textarea = root.querySelector('textarea')!;
    textarea.value = value;
    textarea.dispatchEvent(new Event('input'));
  }

  it('offers a peer command\'s argCompletions once its name is typed', () => {
    const di = new DispatchInput({
      app: makeApp(),
      onSend: vi.fn(),
      builtinCommands: [{ name: 'board', description: 'Open a board' }],
      peerArgCompletions: name => name === 'board'
        ? [{ name: 'sprint', description: 'Current sprint board' }, { name: 'backlog', description: 'Full backlog board' }]
        : undefined,
    });
    const root = di.mount(makeContainer());

    typeAndTriggerInput(root, '/board sp');

    expect(root.textContent).toContain('Current sprint board');
    expect(root.textContent).not.toContain('Full backlog board');
  });

  it('never consults peerArgCompletions for a command name with a built-in entry', () => {
    const peerArgCompletions = vi.fn(() => [{ name: 'ignored', description: 'should never appear' }]);
    const di = new DispatchInput({
      app: makeApp(),
      onSend: vi.fn(),
      builtinCommands: [{ name: 'model', description: 'Set the model' }],
      argCompletions: { model: [{ name: 'opus', description: 'Claude Opus' }] },
      peerArgCompletions,
    });
    const root = di.mount(makeContainer());

    typeAndTriggerInput(root, '/model o');

    expect(root.textContent).toContain('Claude Opus');
    expect(peerArgCompletions).not.toHaveBeenCalled();
  });

  it('returns no dropdown when peerArgCompletions has nothing for the typed command', () => {
    const di = new DispatchInput({
      app: makeApp(),
      onSend: vi.fn(),
      builtinCommands: [{ name: 'board', description: 'Open a board' }],
      peerArgCompletions: () => undefined,
    });
    const root = di.mount(makeContainer());

    typeAndTriggerInput(root, '/board sp');

    expect(root.querySelector('.ct-skill-dropdown')).toBeNull();
  });
});

describe('DispatchInput — interactive wait controls', () => {
  it('keeps both Send and Stop visible when sending is allowed during a stream', () => {
    const di = new DispatchInput({
      app: makeApp(),
      onSend: vi.fn(),
      showStopBtn: true,
    });
    const root = di.mount(makeContainer());

    di.setStreaming(true, true);

    expect(root.querySelector('.ct-send-btn')?.classList.contains('ct-hidden')).toBe(false);
    expect(root.querySelector('.ct-stop-btn')?.classList.contains('ct-hidden')).toBe(false);
  });
});

describe('DispatchInput — placeholder', () => {
  it('updates the mounted textarea placeholder', () => {
    const di = new DispatchInput({
      app: makeApp(),
      onSend: vi.fn(),
      placeholder: 'Message Claude',
    });
    const root = di.mount(makeContainer());

    di.setPlaceholder('Message Codex');

    expect(root.querySelector('textarea')?.placeholder).toBe('Message Codex');
  });
});

describe('DispatchInput — failed dispatch recovery', () => {
  it('restores prompt and attachments when onSend rejects', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('Project not found: deleted'));
    const di = new DispatchInput({ app: makeApp(), onSend });
    const root = di.mount(makeContainer());
    di.setValue('Keep this prompt');
    di.setPendingAttachment('notes.txt\nimportant context');
    di.setPendingImages([{ name: 'mock.png', base64: 'abc', mediaType: 'image/png' }]);

    di.triggerSend();
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());

    expect(di.getValue()).toBe('Keep this prompt');
    expect(di.getPendingAttachment()).toBe('notes.txt\nimportant context');
    expect(di.getPendingImages()).toEqual([{ name: 'mock.png', base64: 'abc', mediaType: 'image/png' }]);
    expect(root.querySelectorAll('.ct-paste-chip')).toHaveLength(2);
  });

  it('merges the failed payload with newer draft edits made while dispatch is pending', async () => {
    let rejectDispatch!: (error: Error) => void;
    const onSend = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectDispatch = reject;
    }));
    const di = new DispatchInput({ app: makeApp(), onSend });
    di.mount(makeContainer());
    di.setValue('Original prompt');
    di.setPendingAttachment('original.txt\noriginal context');
    di.setPendingImages([{ name: 'original.png', base64: 'old', mediaType: 'image/png' }]);

    di.triggerSend();
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    di.setValue('New prompt typed while waiting');
    di.setPendingAttachment('new.txt\nnew context');
    di.setPendingImages([{ name: 'new.png', base64: 'new', mediaType: 'image/png' }]);
    rejectDispatch(new Error('Project not found: deleted'));

    await vi.waitFor(() => expect(di.getValue()).toContain('Original prompt'));
    expect(di.getValue()).toContain('New prompt typed while waiting');
    expect(di.getPendingAttachment()).toContain('original.txt\noriginal context');
    expect(di.getPendingAttachment()).toContain('new.txt\nnew context');
    expect(di.getPendingImages().map((image) => image.name)).toEqual(['original.png', 'new.png']);
  });
});

describe('DispatchInput — harness picker', () => {
  function mountPicker(onSend = vi.fn()) {
    const di = new DispatchInput({
      app: makeApp(),
      onSend,
      harnessPicker: { initialHarness: 'claude' },
    });
    const container = makeContainer();
    document.body.appendChild(container);
    const root = di.mount(container);
    const textarea = root.querySelector('textarea')!;
    const sendButton = root.querySelector<HTMLButtonElement>('.ct-send-btn')!;
    return { di, root, textarea, sendButton, onSend };
  }

  it('scopes the picker positioning class away from ordinary dispatch inputs', () => {
    const ordinary = new DispatchInput({ app: makeApp(), onSend: vi.fn() });
    const ordinaryRoot = ordinary.mount(makeContainer());
    const { root: pickerRoot } = mountPicker();

    expect(ordinaryRoot.classList.contains('ct-harness-picker-root')).toBe(false);
    expect(pickerRoot.classList.contains('ct-harness-picker-root')).toBe(true);
  });

  it('shows the initial harness and submits it with the payload', async () => {
    const { textarea, sendButton, onSend } = mountPicker();

    expect(sendButton.getAttribute('aria-label')).toContain('Claude');
    expect(sendButton.querySelector('.ct-harness-mark-claude')?.getAttribute('data-icon')).toBe('claude-spark');
    expect(sendButton.querySelector('.ct-harness-mark-claude')?.textContent).toBe('');
    textarea.value = 'Do the task';
    sendButton.click();
    await Promise.resolve();

    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Do the task',
      agentHarness: 'claude',
    }));
  });

  it('right-click opens a selector; choosing Codex changes selection without dispatching', async () => {
    const { root, textarea, sendButton, onSend } = mountPicker();

    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    sendButton.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);

    const codexOption = root.querySelector<HTMLButtonElement>('[role="menuitemradio"][data-harness="codex"]')!;
    expect(codexOption).toBeTruthy();
    expect(codexOption.querySelector('.ct-harness-mark-codex')?.getAttribute('data-icon')).toBe('openai-blossom');
    expect(codexOption.querySelector('.ct-harness-mark-codex')?.textContent).toBe('');
    codexOption.click();
    expect(onSend).not.toHaveBeenCalled();
    expect(sendButton.getAttribute('aria-label')).toContain('Codex');

    textarea.value = 'Use Codex';
    sendButton.click();
    await Promise.resolve();
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ agentHarness: 'codex' }));
  });

  it('opens from the keyboard and closes on Escape', () => {
    const { root, sendButton } = mountPicker();

    sendButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    expect(root.querySelector('[role="menu"]')).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('[role="menu"]')).toBeFalsy();
    expect(document.activeElement).toBe(sendButton);
  });

  it('long-press opens the selector and suppresses the resulting send click', () => {
    vi.useFakeTimers();
    try {
      const { root, sendButton, onSend } = mountPicker();

      sendButton.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      vi.advanceTimersByTime(500);
      sendButton.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
      sendButton.click();

      expect(root.querySelector('[role="menu"]')).toBeTruthy();
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DispatchInput — no local container run mode', () => {
  it('offers no "Run in" section and never sends harnessVmMode', async () => {
    const onSend = vi.fn();
    const di = new DispatchInput({ app: makeApp(), onSend, harnessPicker: { initialHarness: 'claude' } });
    const container = makeContainer();
    document.body.appendChild(container);
    const root = di.mount(container);
    const textarea = root.querySelector('textarea')!;
    const sendButton = root.querySelector<HTMLButtonElement>('.ct-send-btn')!;
    sendButton.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(root.querySelector('.ct-run-mode-item[data-run-mode]')).toBeFalsy();
    expect(root.textContent).not.toContain('Run in');
    textarea.value = 'hello';
    sendButton.click();
    await Promise.resolve();
    expect(onSend.mock.calls[0][0]).not.toHaveProperty('harnessVmMode');
  });
});

describe('DispatchInput — set up the local daemon from the picker', () => {
  function mountOffer(available: boolean) {
    const onSetUp = vi.fn();
    const di = new DispatchInput({ app: makeApp(), onSend: vi.fn(), harnessPicker: { initialHarness: 'claude', localDaemonOffer: { available: () => available, onSetUp } } });
    const container = makeContainer();
    document.body.appendChild(container);
    const root = di.mount(container);
    const sendButton = root.querySelector<HTMLButtonElement>('.ct-send-btn')!;
    sendButton.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    return { root, onSetUp };
  }

  it('offers "This Mac (container) - set up" when the daemon can run here but is not set up, and opens its settings', () => {
    const { root, onSetUp } = mountOffer(true);
    const item = root.querySelector<HTMLButtonElement>('[data-run-on="setup-local"]');
    expect(item?.textContent).toContain('This Mac (container)');
    item!.click();
    expect(onSetUp).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.ct-harness-menu')).toBeNull();
  });

  it('shows nothing extra when it is already set up or cannot run on this machine', () => {
    const { root } = mountOffer(false);
    expect(root.querySelector('[data-run-on="setup-local"]')).toBeNull();
    expect(root.textContent).not.toContain('Run on');
  });
});

describe('DispatchInput — Run on a remote daemon: vault folder suggestion', () => {
  const VAULT = '/Users/me/Documents/My Vault';
  const box = { id: 'box', name: 'my-server', url: 'wss://x', tokenSecretName: 'T', defaultCwdRoot: '/home/user/projects', vaultMapping: { remoteRoot: '/home/user/vault' } };
  const plain = { id: 'plain', name: 'plain-box', url: 'wss://y', tokenSecretName: 'U', defaultCwdRoot: '/srv/workspaces' };

  function mountRemote(state: { localCwd: string | undefined }, onSend = vi.fn()) {
    const di = new DispatchInput({
      app: makeApp(),
      onSend,
      harnessPicker: {
        initialHarness: 'claude',
        getRemoteDaemons: () => [box, plain],
        getLocalCwd: () => state.localCwd,
        getVaultRoot: () => VAULT,
      },
    });
    const container = makeContainer();
    document.body.appendChild(container);
    const root = di.mount(container);
    const textarea = root.querySelector('textarea')!;
    const sendButton = root.querySelector<HTMLButtonElement>('.ct-send-btn')!;
    return { root, textarea, sendButton, onSend };
  }
  const openMenu = (btn: HTMLElement) => btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const pick = (root: HTMLElement, id: string) => root.querySelector<HTMLButtonElement>(`.ct-run-on-item[data-run-on="${id}"]`)!.click();
  const folder = (root: HTMLElement) => root.querySelector<HTMLInputElement>('.ct-run-on-folder-input')!;
  const hint = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-testid="run-on-folder-hint"]')!;

  it('pre-fills the mapped vault folder (iCloud path with spaces) and says why', () => {
    const { root, sendButton } = mountRemote({ localCwd: `${VAULT}/Products/Agent Threads` });
    openMenu(sendButton);
    pick(root, 'box');
    expect(folder(root).value).toBe('/home/user/vault/Products/Agent Threads');
    expect(hint(root).classList.contains('is-hidden')).toBe(false);
    expect(hint(root).textContent).toContain('Same folder as in your vault');
  });

  it('keeps the daemon default folder for a non-vault cwd, with no hint', () => {
    const { root, sendButton } = mountRemote({ localCwd: '/Users/me/projects/app' });
    openMenu(sendButton);
    pick(root, 'box');
    expect(folder(root).value).toBe('/home/user/projects');
    expect(hint(root).classList.contains('is-hidden')).toBe(true);
  });

  it('a daemon with no mapping keeps its default even for a vault cwd', () => {
    const { root, sendButton } = mountRemote({ localCwd: VAULT });
    openMenu(sendButton);
    pick(root, 'plain');
    expect(folder(root).value).toBe('/srv/workspaces');
  });

  it('typing replaces the suggestion, hides the hint, and is what gets sent', async () => {
    const { root, textarea, sendButton, onSend } = mountRemote({ localCwd: VAULT });
    openMenu(sendButton);
    pick(root, 'box');
    expect(folder(root).value).toBe('/home/user/vault');
    folder(root).value = '/home/user/vault/Elsewhere';
    folder(root).dispatchEvent(new Event('input', { bubbles: true }));
    expect(hint(root).classList.contains('is-hidden')).toBe(true);
    textarea.value = 'go';
    sendButton.click();
    await Promise.resolve();
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ remote: { daemonId: 'box', cwd: '/home/user/vault/Elsewhere' } }));
  });

  it('re-suggests when the Project (local cwd) changed since the menu was last open, unless the user typed', () => {
    const state = { localCwd: `${VAULT}/Daily` as string | undefined };
    const { root, sendButton } = mountRemote(state);
    openMenu(sendButton);
    pick(root, 'box');
    expect(folder(root).value).toBe('/home/user/vault/Daily');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); // dismiss the menu
    expect(root.querySelector('.ct-harness-menu')).toBeNull();
    state.localCwd = `${VAULT}/Products`;
    openMenu(sendButton);
    expect(folder(root).value).toBe('/home/user/vault/Products');
  });
});


describe('DispatchInput — Run on a remote daemon: the daemon offers its own folders', () => {
  const VAULT = '/Users/me/Documents/My Vault';
  const projects = { path: '/home/user/projects', name: 'projects', readOnly: false, kind: 'folder' as const, isDefault: true };
  const notes = { path: '/home/user/notes', name: 'notes', readOnly: false, kind: 'vault' as const, isDefault: false };
  const tree: Record<string, string[]> = {
    '/home/user/projects': ['app', 'site'],
    '/home/user/projects/app': ['packages'],
    '/home/user/notes': ['Daily', 'Products'],
  };
  const box = { id: 'box', name: 'my-server', url: 'wss://x', tokenSecretName: 'T', vaultMapping: { remoteRoot: '/home/user/notes' } };
  const old = { id: 'old', name: 'old-server', url: 'wss://y', tokenSecretName: 'U', defaultCwdRoot: '/srv/workspaces' };

  function source(failFor: Record<string, 'unsupported' | 'error'> = {}) {
    return {
      workspaces: vi.fn(async (id: string) => {
        const fail = failFor[id];
        if (fail) return { ok: false as const, reason: fail, detail: fail === 'unsupported' ? 'This daemon is too old to list its folders.' : 'boom' };
        return { ok: true as const, value: [projects, notes] };
      }),
      subfolders: vi.fn(async (_id: string, path: string) => ({
        ok: true as const,
        value: { allowed: path in tree, entries: (tree[path] ?? []).map((name) => ({ name, path: `${path}/${name}` })), truncated: false },
      })),
    };
  }
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

  function mount(state: { localCwd: string | undefined }, src = source(), onSend = vi.fn()) {
    const di = new DispatchInput({
      app: makeApp(),
      onSend,
      harnessPicker: {
        initialHarness: 'claude',
        getRemoteDaemons: () => [box, old],
        getLocalCwd: () => state.localCwd,
        getVaultRoot: () => VAULT,
        getFolderSource: () => src,
      },
    });
    const container = makeContainer();
    document.body.appendChild(container);
    const root = di.mount(container);
    return { root, textarea: root.querySelector('textarea')!, sendButton: root.querySelector<HTMLButtonElement>('.ct-send-btn')!, onSend, src };
  }
  const openMenu = (btn: HTMLElement) => btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const pick = (root: HTMLElement, id: string) => root.querySelector<HTMLButtonElement>(`.ct-run-on-item[data-run-on="${id}"]`)!.click();
  const select = (root: HTMLElement) => root.querySelector<HTMLSelectElement>('.ct-run-on-folder-select')!;
  const hint = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-testid="run-on-folder-hint"]')!;

  it('shows the daemon\'s workspaces and preselects the mapped vault folder for a vault thread, no typing', async () => {
    const { root, sendButton } = mount({ localCwd: `${VAULT}/Products` });
    openMenu(sendButton);
    pick(root, 'box');
    await flush();
    const opts = Array.from(select(root).options).map((o) => o.value);
    expect(opts).toEqual(['/home/user/projects', '/home/user/notes', '/home/user/notes/Products', '__other__']);
    expect(select(root).value).toBe('/home/user/notes/Products');
    expect(root.querySelector('.ct-run-on-folder-input')).toBeNull();
    expect(hint(root).classList.contains('is-hidden')).toBe(false);
  });

  it('defaults to the daemon\'s advertised default workspace when nothing else applies, and sends it', async () => {
    const { root, textarea, sendButton, onSend } = mount({ localCwd: '/Users/me/projects/app' });
    openMenu(sendButton);
    pick(root, 'box');
    await flush();
    expect(select(root).value).toBe('/home/user/projects');
    expect(hint(root).classList.contains('is-hidden')).toBe(true);
    textarea.value = 'go';
    sendButton.click();
    await Promise.resolve();
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ remote: { daemonId: 'box', cwd: '/home/user/projects' } }));
  });

  it('choosing another workspace from the dropdown is what gets sent', async () => {
    const { root, textarea, sendButton, onSend } = mount({ localCwd: undefined });
    openMenu(sendButton);
    pick(root, 'box');
    await flush();
    select(root).value = '/home/user/notes';
    select(root).dispatchEvent(new Event('change', { bubbles: true }));
    expect(select(root).value).toBe('/home/user/notes');
    textarea.value = 'go';
    sendButton.click();
    await Promise.resolve();
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ remote: { daemonId: 'box', cwd: '/home/user/notes' } }));
  });

  it('Browse lists subfolders via the daemon, descends, goes up only inside a workspace, and uses the chosen folder', async () => {
    const { root, textarea, sendButton, onSend, src } = mount({ localCwd: undefined });
    openMenu(sendButton);
    pick(root, 'box');
    await flush();
    const panel = () => root.querySelector<HTMLElement>('[data-testid="run-on-browser"]')!;
    expect(panel().classList.contains('is-hidden')).toBe(true);
    root.querySelector<HTMLButtonElement>('.ct-run-on-browse-btn')!.click();
    await flush();
    expect(src.subfolders).toHaveBeenCalledWith('box', '/home/user/projects');
    const names = () => Array.from(root.querySelectorAll('.ct-run-on-browse-item')).map((e) => e.textContent);
    expect(names()).toEqual(['app', 'site']);
    expect(root.querySelector<HTMLButtonElement>('.ct-run-on-browse-up')!.disabled).toBe(true);
    root.querySelector<HTMLButtonElement>('.ct-run-on-browse-item[data-path="/home/user/projects/app"]')!.click();
    await flush();
    expect(names()).toEqual(['packages']);
    expect(root.querySelector<HTMLButtonElement>('.ct-run-on-browse-up')!.disabled).toBe(false);
    root.querySelector<HTMLButtonElement>('.ct-run-on-browse-item[data-path="/home/user/projects/app/packages"]')!.click();
    await flush();
    root.querySelector<HTMLButtonElement>('.ct-run-on-browse-use')!.click();
    await flush();
    expect(select(root).value).toBe('/home/user/projects/app/packages');
    textarea.value = 'go';
    sendButton.click();
    await Promise.resolve();
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ remote: { daemonId: 'box', cwd: '/home/user/projects/app/packages' } }));
  });

  it('a daemon too old to list folders falls back to the text field with its default and a reason', async () => {
    const { root, sendButton } = mount({ localCwd: undefined }, source({ old: 'unsupported' }));
    openMenu(sendButton);
    pick(root, 'old');
    await flush();
    expect(select(root)).toBeNull();
    expect(root.querySelector<HTMLInputElement>('.ct-run-on-folder-input')!.value).toBe('/srv/workspaces');
    expect(root.querySelector('[data-testid="run-on-folder-note"]')!.textContent).toContain('too old');
  });

  it('"Other folder…" switches to typing', async () => {
    const { root, sendButton } = mount({ localCwd: undefined });
    openMenu(sendButton);
    pick(root, 'box');
    await flush();
    select(root).value = '__other__';
    select(root).dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.querySelector('.ct-run-on-folder-input')).not.toBeNull();
    expect(select(root)).toBeNull();
  });
});

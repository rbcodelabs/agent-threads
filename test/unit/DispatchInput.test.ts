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

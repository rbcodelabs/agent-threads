/**
 * @vitest-environment jsdom
 *
 * Advisory managed-policy UI: the new-conversation composer disables targets and harnesses the administrator removed
 * (with a note), says so explicitly when nothing can run, and refuses to send; the local-daemon panel disables the
 * buttons that would create or start the container; the host_exec "Always allow" offer follows allowAlways.
 */
import '../setup/obsidian-dom';
import { vi, describe, it, expect } from 'vitest';

vi.mock('fs', () => ({
  default: { readdirSync: () => [], statSync: () => ({ isDirectory: () => false }), existsSync: () => false, readFileSync: () => '' },
  readdirSync: () => [], statSync: () => ({ isDirectory: () => false }), existsSync: () => false, readFileSync: () => '',
}));
vi.mock('../../src/stt', () => ({
  SttController: function SttController() {
    return { attachPttToTextarea: vi.fn(() => () => {}), createMicButton: vi.fn(() => document.createElement('button')), destroy: vi.fn() };
  },
}));

import { App, Notice } from 'obsidian';
import { DispatchInput, MANAGED_SUFFIX } from '../../src/DispatchInput';
import { renderLocalDaemonPanel } from '../../src/localDaemon/localDaemonPanel';
import { ALL_DISABLED_MESSAGE, policyTargetOfDaemon, type ThreadExecutionPolicy } from '../../src/managedPolicy';
import type { RemoteDaemonConfig } from '../../src/types';
import { snap } from '../helpers/localDaemonSnap';

const policy = (te: Record<string, unknown>): ThreadExecutionPolicy => ({
  machine: { enabled: true }, localDaemon: { enabled: true }, remoteDaemon: { enabled: true }, ...te,
}) as ThreadExecutionPolicy;

const LOCAL: RemoteDaemonConfig = { id: 'this-mac-container', name: 'This Mac', url: 'ws://127.0.0.1:7433', tokenSecretName: 't', managed: 'local-container' };
const HOMELAB: RemoteDaemonConfig = { id: 'homelab', name: 'Homelab', url: 'wss://threads.corp.example:8443', tokenSecretName: 't2' };

function mount(p: ThreadExecutionPolicy | undefined, extra: { daemons?: RemoteDaemonConfig[]; harness?: 'claude' | 'codex' | 'opencode'; onSend?: ReturnType<typeof vi.fn> } = {}) {
  const onSend = extra.onSend ?? vi.fn();
  const di = new DispatchInput({
    app: new App(),
    onSend,
    harnessPicker: {
      initialHarness: extra.harness ?? 'claude',
      getRemoteDaemons: () => extra.daemons ?? [],
      managedPolicy: {
        get: () => p,
        targetOf: (id) => (id === undefined ? { kind: 'machine' } : policyTargetOfDaemon((extra.daemons ?? []).find((d) => d.id === id), 'this-mac-container')),
      },
    },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = di.mount(container);
  return { di, root, onSend, textarea: root.querySelector('textarea')!, send: root.querySelector<HTMLButtonElement>('.ct-send-btn')! };
}

const open = (root: Element) => root.querySelector<HTMLButtonElement>('.ct-settings-indicator')!.click();
const level = (root: Element, id: string) => {
  root.querySelector<HTMLButtonElement>('.ct-sp-back')?.click();
  root.querySelector<HTMLButtonElement>(`[data-ct-key="row:${id}"]`)!.click();
};
const option = (root: Element, label: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('.ct-sp-option')).find((o) => o.querySelector('.ct-sp-label')!.textContent!.startsWith(label))!;

describe('composer: harness menu', () => {
  it('disables a harness the policy removed and says it is managed', () => {
    const { root } = mount(policy({ harnesses: ['claude'] }));
    open(root);
    level(root, 'harness');
    expect(option(root, 'Claude').hasAttribute('disabled') || option(root, 'Claude').getAttribute('aria-disabled') === 'true').toBe(false);
    for (const label of ['Codex', 'OpenCode']) {
      const o = option(root, label);
      expect(o.querySelector('.ct-sp-label')!.textContent).toContain(MANAGED_SUFFIX);
      expect(o.hasAttribute('disabled') || o.getAttribute('aria-disabled') === 'true').toBe(true);
    }
  });

  it('with no policy nothing is disabled or annotated', () => {
    const { root } = mount(undefined);
    open(root);
    level(root, 'harness');
    expect(root.textContent).not.toContain(MANAGED_SUFFIX);
  });

  it('starts on an allowed harness when the default one is removed', () => {
    const { root, textarea, send, onSend } = mount(policy({ harnesses: ['codex'] }), { harness: 'claude' });
    textarea.value = 'go';
    send.click();
    return Promise.resolve().then(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend.mock.calls[0][0].agentHarness).toBe('codex');
      void root;
    });
  });
});

describe('composer: Run on', () => {
  it('machine off: This computer is disabled and annotated; the container stays selectable', () => {
    const { root } = mount(policy({ machine: { enabled: false } }), { daemons: [LOCAL, HOMELAB] });
    open(root);
    level(root, 'runon');
    const computer = option(root, 'This computer');
    expect(computer.querySelector('.ct-sp-label')!.textContent).toContain(MANAGED_SUFFIX);
    expect(computer.hasAttribute('disabled') || computer.getAttribute('aria-disabled') === 'true').toBe(true);
    const mac = option(root, 'This Mac');
    expect(mac.querySelector('.ct-sp-label')!.textContent).not.toContain(MANAGED_SUFFIX);
  });

  it('a remote daemon off the host list is annotated', () => {
    const { root } = mount(policy({ remoteDaemon: { enabled: true, hosts: ['wss://other.example:1'] } }), { daemons: [HOMELAB] });
    open(root);
    level(root, 'runon');
    expect(option(root, 'Homelab').querySelector('.ct-sp-label')!.textContent).toContain(MANAGED_SUFFIX);
  });
});

describe('composer: nothing may run', () => {
  const none = policy({ machine: { enabled: false }, localDaemon: { enabled: false }, remoteDaemon: { enabled: false } });

  it('says so next to the composer', () => {
    const { root } = mount(none);
    const note = root.querySelector('.ct-managed-note');
    expect(note?.textContent).toBe(ALL_DISABLED_MESSAGE);
    expect(note?.classList.contains('is-visible')).toBe(true);
  });

  it('refuses to send and keeps the draft, with the administrator wording', async () => {
    (Notice as unknown as { messages: unknown[] }).messages.length = 0;
    const { textarea, send, onSend } = mount(none);
    textarea.value = 'please run';
    send.click();
    await Promise.resolve();
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('please run');
    const messages = (Notice as unknown as { messages: Array<{ message: string }> }).messages.map((m) => m.message);
    expect(messages).toContain(ALL_DISABLED_MESSAGE);
  });

  it('shows no note when something can run', () => {
    const { root } = mount(policy({ machine: { enabled: false } }));
    expect(root.querySelector('.ct-managed-note')).toBeNull();
  });
});

describe('local daemon panel', () => {
  const NOT_SET_UP = snap({ container: 'absent', imageReady: false, volumesPresent: false, health: 'na', welcome: undefined }, {}, false);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const render = async (managedBlock?: () => string | undefined) => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    renderLocalDaemonPanel(parent, {
      isMobile: false, pluginVersion: '1',
      snapshot: async () => NOT_SET_UP, subscribe: () => () => undefined, confirm: async () => true,
      run: vi.fn(async () => undefined) as never, signIn: async () => ({ ok: true }), cancel: () => undefined,
      ...(managedBlock ? { managedBlock } : {}),
    });
    await flush();
    return parent;
  };

  it('shows the managed note and disables the buttons that would create or start the container', async () => {
    const parent = await render(() => 'Running threads on the local daemon is disabled by your administrator.');
    expect(parent.querySelector('.ct-managed-note')?.textContent).toContain('Managed by your administrator');
    const setUp = [...parent.querySelectorAll('button')].find((b) => b.textContent === 'Set up') as HTMLButtonElement;
    expect(setUp).toBeDefined();
    expect(setUp.disabled).toBe(true);
  });

  it('is unchanged without a managed block', async () => {
    const parent = await render();
    expect(parent.querySelector('.ct-managed-note')?.textContent ?? '').toBe('');
    const setUp = [...parent.querySelectorAll('button')].find((b) => b.textContent === 'Set up') as HTMLButtonElement;
    expect(setUp.disabled).toBe(false);
  });
});

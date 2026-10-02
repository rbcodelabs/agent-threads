/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { HostExecModal } from '../../src/confirmModal';

const request = {
  command: 'pnpm test -- --run test/unit/hostExec.test.ts',
  cwd: '/Users/example/projects/agent-threads',
  reason: 'Verify host execution behavior.',
  timeoutSeconds: 120,
};

function open(onResult = vi.fn()) {
  const modal = new HostExecModal(new App(), request, onResult);
  modal.close = () => modal.onClose();
  modal.onOpen();
  return { modal, onResult };
}

function button(modal: HostExecModal, text: string): HTMLButtonElement {
  const match = [...modal.contentEl.querySelectorAll('button')].find(candidate => candidate.textContent === text);
  if (!match) throw new Error(`No ${text} button`);
  return match as HTMLButtonElement;
}

describe('HostExecModal', () => {
  it('renders the exact command, directory, reason, timeout, and one-call controls', () => {
    const { modal } = open();

    expect(modal.contentEl.textContent).toContain(request.command);
    expect(modal.contentEl.textContent).toContain(request.cwd);
    expect(modal.contentEl.textContent).toContain(request.reason);
    expect(modal.contentEl.textContent).toContain('120s');
    expect(button(modal, 'Deny')).toBeTruthy();
    expect(button(modal, 'Allow once')).toBeTruthy();
  });

  it.each([
    ['dismissal', undefined, false],
    ['Deny', 'Deny', false],
    ['Allow once', 'Allow once', true],
  ] as const)('resolves %s exactly once', (_label, action, expected) => {
    const { modal, onResult } = open();

    if (action) button(modal, action).click();
    else modal.onClose();
    modal.onClose();

    expect(onResult).toHaveBeenCalledExactlyOnceWith(expected);
    expect(modal.contentEl.childElementCount).toBe(0);
  });
});

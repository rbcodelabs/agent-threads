// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { OutsideVaultLinkModal, outsideVaultLinkPath } from '../../src/OutsideVaultLinkModal';
import type { App } from 'obsidian';
import '../setup/obsidian-dom';

describe('outsideVaultLinkPath', () => {
  it('decodes percent escapes', () => {
    expect(outsideVaultLinkPath('/Users/me/My%20Docs/a%26b.md')).toBe('/Users/me/My Docs/a&b.md');
  });
  it('strips a #subpath before decoding', () => {
    expect(outsideVaultLinkPath('/Users/me/notes.md#My%20Heading')).toBe('/Users/me/notes.md');
  });
  it('keeps the raw path on a malformed escape', () => {
    expect(outsideVaultLinkPath('/Users/me/100%.md')).toBe('/Users/me/100%.md');
  });
  it('trims whitespace', () => {
    expect(outsideVaultLinkPath('  /tmp/x.txt ')).toBe('/tmp/x.txt');
  });
});

function openModal() {
  const actions = { open: vi.fn(), reveal: vi.fn(), copy: vi.fn() };
  const modal = new OutsideVaultLinkModal({} as App, '/Users/me/My%20Docs/a.md#h', actions);
  const titleEl = document.createElement('div') as HTMLElement & { setText: (s: string) => void };
  titleEl.setText = (s) => { titleEl.textContent = s; };
  (modal as unknown as { titleEl: HTMLElement }).titleEl = titleEl;
  const close = vi.spyOn(modal, 'close');
  modal.onOpen();
  const btn = (label: string) =>
    Array.from(modal.contentEl.querySelectorAll('button')).find((b) => b.textContent === label)!;
  return { modal, actions, close, btn };
}

describe('OutsideVaultLinkModal', () => {
  it('shows the decoded path and opens nothing on its own', () => {
    const { modal, actions } = openModal();
    expect(modal.contentEl.textContent).toContain('/Users/me/My Docs/a.md');
    expect(actions.open).not.toHaveBeenCalled();
  });
  it.each([['Open', 'open'], ['Reveal in Finder', 'reveal'], ['Copy path', 'copy']] as const)(
    '%s calls its action with the decoded path and closes',
    (label, key) => {
      const { actions, btn, close } = openModal();
      btn(label).click();
      expect(actions[key]).toHaveBeenCalledWith('/Users/me/My Docs/a.md');
      expect(close).toHaveBeenCalled();
    },
  );
  it('Cancel closes without acting', () => {
    const { actions, btn, close } = openModal();
    btn('Cancel').click();
    expect(close).toHaveBeenCalled();
    expect(actions.open).not.toHaveBeenCalled();
    expect(actions.reveal).not.toHaveBeenCalled();
    expect(actions.copy).not.toHaveBeenCalled();
  });
});

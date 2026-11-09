/**
 * dock-link-opener.test.ts
 *
 * B1 (#903 review): opening a [[note]] from the sheet must never navigate the Agent Board's own leaf
 * (that would destroy the dock and the open sheet) and must never create an empty note for a link
 * that does not resolve.
 */
import { vi, describe, it, expect } from 'vitest';
import { canOpenDockLink, openDockLink, linkpathOf } from '../../src/dockLinkOpener';

const deps = (over: Partial<Parameters<typeof openDockLink>[0]> = {}) => ({
  getFirstLinkpathDest: vi.fn((p: string) => (p === 'Real' ? {} : null)),
  isConversationFirst: () => false,
  openInContextPanel: vi.fn(),
  openLinkText: vi.fn(),
  ...over,
});

describe('linkpathOf', () => {
  it('drops the heading, block and alias parts', () => {
    expect(linkpathOf('Projects/Plan#Goals')).toBe('Projects/Plan');
    expect(linkpathOf('Note#^block')).toBe('Note');
    expect(linkpathOf('Note|alias')).toBe('Note');
  });
});

describe('canOpenDockLink', () => {
  it('is true only when the link resolves to an existing file', () => {
    expect(canOpenDockLink(deps(), 'Real#Heading')).toBe(true);
    expect(canOpenDockLink(deps(), 'Ghost')).toBe(false);
  });
});

describe('openDockLink', () => {
  it('opens in a NEW tab, never in the active leaf (which is the board)', () => {
    const d = deps();
    openDockLink(d, 'Real#H');
    expect(d.openLinkText).toHaveBeenCalledWith('Real#H', '', 'tab');
    expect(d.openLinkText).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), false);
  });
  it('conversation-first layouts route through the context panel, like ThreadsView', () => {
    const d = deps({ isConversationFirst: () => true });
    openDockLink(d, 'Real');
    expect(d.openInContextPanel).toHaveBeenCalledWith('Real', '');
    expect(d.openLinkText).not.toHaveBeenCalled();
  });
  it('an unresolved link opens nothing (no empty note is created)', () => {
    const d = deps();
    openDockLink(d, 'Ghost');
    expect(d.openLinkText).not.toHaveBeenCalled();
    expect(d.openInContextPanel).not.toHaveBeenCalled();
  });
});

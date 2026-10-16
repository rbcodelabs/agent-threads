/**
 * @vitest-environment jsdom
 *
 * Regression tests for "inline links in the conversation from Codex/Claude
 * don't work — clicking does nothing":
 *
 *  Root cause 1: a rendered markdown link whose href is an OS-absolute path
 *  that happens to fall under the vault root (e.g.
 *  `/Users/me/Documents/Personal/Products/Geode/Runs/foo.md`) was passed
 *  straight through to ContextPanelController.openLinkText / the classic
 *  openLinkText call, both of which expect vault-relative linktext — so the
 *  lookup silently failed and nothing happened. Fixed by resolving such
 *  hrefs through resolveAbsoluteVaultHref() before opening.
 *
 *  Root cause 2: in classic placement (still the default for existing
 *  installs — see conversation-first-placement.test.ts for why new installs
 *  now default to conversation-first instead), no click listener was ever
 *  attached to plain `[label](path)` links at all — the handler bailed out
 *  immediately via `if (!this.plugin.isConversationFirst() || ...) return`.
 *  Only conversation-first mode got a working handler. Fixed by attaching
 *  the listener unconditionally and branching on isConversationFirst()
 *  *inside* the handler, mirroring the existing a.internal-link handler.
 *
 * ThreadsView is a full Obsidian ItemView; this suite instantiates it via
 * Object.create(ThreadsView.prototype) (see threads-view-focus.test.ts for
 * the established pattern) so renderMarkdown() can be exercised directly
 * against real jsdom nodes without standing up the full view lifecycle.
 */

import { describe, it, expect } from 'vitest';
import { ThreadsView } from '../../src/ThreadsView';

interface Harness {
  view: ThreadsView;
  contextPanelCalls: Array<[string, string]>;
  workspaceCalls: string[];
  /** Parallel to workspaceCalls: the sourcePath each classic open was given. */
  workspaceSourcePaths: string[];
  /** Calls to the private openLink() helper used for http(s) links — [url, forceExternal]. */
  openLinkCalls: Array<[string, boolean]>;
}

function makeView(opts: { conversationFirst: boolean; vaultFiles?: string[]; noteFile?: string }): Harness {
  const contextPanelCalls: Array<[string, string]> = [];
  const workspaceCalls: string[] = [];
  const workspaceSourcePaths: string[] = [];
  const openLinkCalls: Array<[string, boolean]> = [];
  const view = Object.create(ThreadsView.prototype) as ThreadsView & Record<string, unknown>;
  // openLink() itself (Web Viewer leaf routing, electron fallback) is covered
  // by linkUtils.test.ts against openUrlPreferringWebViewer directly. Here we
  // only need to verify renderMarkdown's http(s) handler calls it with the
  // right arguments, so it's stubbed rather than exercised end-to-end.
  (view as unknown as { openLink: (url: string, forceExternal?: boolean) => void }).openLink =
    (url: string, forceExternal = false) => { openLinkCalls.push([url, forceExternal]); };

  (view as unknown as { app: unknown }).app = {
    vault: {
      getAbstractFileByPath: (p: string) => ((opts.vaultFiles ?? []).includes(p) ? { path: p } : null),
    },
    workspace: {
      openLinkText: (href: string, sourcePath?: string) => {
        workspaceCalls.push(href);
        workspaceSourcePaths.push(sourcePath ?? '');
      },
    },
  };
  (view as unknown as { plugin: unknown }).plugin = {
    settings: { enableInlineVisualizations: false },
    isConversationFirst: () => opts.conversationFirst,
    contextPanel: {
      openLinkText: async (href: string, sourcePath: string) => { contextPanelCalls.push([href, sourcePath]); },
    },
  };
  (view as unknown as { manager: unknown }).manager = {
    getThread: () => (opts.noteFile ? { noteFile: opts.noteFile } : undefined),
  };
  (view as unknown as { activeThreadId: string | null }).activeThreadId = 'tid';
  (view as unknown as { visualizeManager: unknown }).visualizeManager = undefined;

  return { view, contextPanelCalls, workspaceCalls, workspaceSourcePaths, openLinkCalls };
}

async function renderAndClick(harness: Harness, markdown: string): Promise<HTMLAnchorElement> {
  const el = document.createElement('div');
  const render = (harness.view as unknown as {
    renderMarkdown(markdown: string, el: HTMLElement): Promise<void>;
  }).renderMarkdown.bind(harness.view);
  await render(markdown, el);
  const link = el.querySelector('a') as HTMLAnchorElement;
  expect(link).not.toBeNull();
  link.click();
  return link;
}

describe('ThreadsView renderMarkdown — plain markdown link clicks (classic placement)', () => {
  it('attaches a click listener and routes through app.workspace.openLinkText', async () => {
    const harness = makeView({ conversationFirst: false });
    await renderAndClick(harness, '[Plan](Notes/Plan.md)');
    expect(harness.workspaceCalls).toEqual(['Notes/Plan.md']);
    expect(harness.contextPanelCalls).toEqual([]);
  });

  it('resolves an OS-absolute path under the vault root before opening', async () => {
    const abs = '/Users/me/Documents/My Vault/Products/Geode/Runs/geode-2026-09-01-architecture-review.md';
    const harness = makeView({
      conversationFirst: false,
      vaultFiles: ['Products/Geode/Runs/geode-2026-09-01-architecture-review.md'],
    });
    await renderAndClick(harness, `[Geode Architecture Review](<${abs}>)`);
    expect(harness.workspaceCalls).toEqual(['Products/Geode/Runs/geode-2026-09-01-architecture-review.md']);
  });

  // Previously this asserted the raw absolute path was forwarded to
  // openLinkText. That is the unsafe behavior: an unresolved linktext asks the
  // host to open a link that doesn't exist, which can create a stray note named
  // after the filesystem path — in the DEFAULT placement, from clicking a link
  // the user did not author. Before the plain-link handler existed, classic
  // placement attached no listener at all and the click was inert; staying
  // inert (with a Notice) is the safe equivalent.
  it('does NOT forward an unresolvable OS-absolute path to openLinkText', async () => {
    const abs = '/Users/me/elsewhere/note.md';
    const harness = makeView({ conversationFirst: false, vaultFiles: [] });
    await renderAndClick(harness, `[Note](<${abs}>)`);
    expect(harness.workspaceCalls).toEqual([]);
  });

  it('does NOT forward an unresolvable OS-absolute path to the companion either', async () => {
    const abs = '/Users/me/elsewhere/note.md';
    const harness = makeView({ conversationFirst: true, vaultFiles: [], noteFile: 'Claude/thread.md' });
    await renderAndClick(harness, `[Note](<${abs}>)`);
    expect(harness.contextPanelCalls).toEqual([]);
  });

  // A relative href that doesn't resolve is still forwarded: it IS vault
  // linktext, and "open/create this note" is the host's ordinary, expected
  // behavior for one. Only filesystem paths are withheld.
  it('still forwards an unresolvable RELATIVE href (ordinary vault linktext)', async () => {
    const harness = makeView({ conversationFirst: false, vaultFiles: [] });
    await renderAndClick(harness, '[Note](Notes/Missing.md)');
    expect(harness.workspaceCalls).toEqual(['Notes/Missing.md']);
  });

  it('preserves a #heading subpath when resolving an OS-absolute path', async () => {
    const abs = '/Users/me/Vault/Products/Geode/Runs/report.md#QA Report';
    const harness = makeView({
      conversationFirst: false,
      vaultFiles: ['Products/Geode/Runs/report.md'],
    });
    await renderAndClick(harness, `[Report](<${abs}>)`);
    expect(harness.workspaceCalls).toEqual(['Products/Geode/Runs/report.md#QA Report']);
  });

  it('preserves a #^block subpath when resolving an OS-absolute path', async () => {
    const abs = '/Users/me/Vault/Notes/Plan.md#^abc123';
    const harness = makeView({ conversationFirst: false, vaultFiles: ['Notes/Plan.md'] });
    await renderAndClick(harness, `[Plan](<${abs}>)`);
    expect(harness.workspaceCalls).toEqual(['Notes/Plan.md#^abc123']);
  });

  // The target is frequently written by the agent in the same turn that links
  // to it, so it may only appear after this message rendered. Resolution must
  // therefore happen on click, not at render time.
  it('resolves at click time, so a target that appears after render still opens', async () => {
    const abs = '/Users/me/Vault/Products/Geode/Runs/late.md';
    const vaultFiles: string[] = [];
    const harness = makeView({ conversationFirst: false, vaultFiles });
    const el = document.createElement('div');
    await (harness.view as unknown as {
      renderMarkdown(md: string, el: HTMLElement): Promise<void>;
    }).renderMarkdown(`[Late](<${abs}>)`, el);
    // File lands only AFTER the message was rendered.
    vaultFiles.push('Products/Geode/Runs/late.md');
    el.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(harness.workspaceCalls).toEqual(['Products/Geode/Runs/late.md']);
  });

  it('passes the thread note as sourcePath in classic placement, matching conversation-first', async () => {
    const harness = makeView({
      conversationFirst: false,
      vaultFiles: ['Projects/Roadmap.md'],
      noteFile: 'Claude/thread.md',
    });
    await renderAndClick(harness, '[Roadmap](../Projects/Roadmap.md)');
    expect(harness.workspaceSourcePaths).toEqual(['Claude/thread.md']);
  });

  it('decodes percent-encoded spaces (marked encodes them) before suffix-matching a path whose vault-relative portion has a space', async () => {
    // marked emits `href="...Products/Geode/Runs/My%20Report.md"` for a
    // markdown link target containing a literal space. The vault-relative
    // suffix here itself contains the space, so matching only works if the
    // href is decoded before being probed against getAbstractFileByPath.
    const abs = '/Users/me/Vault/Products/Geode/Runs/My Report.md';
    const harness = makeView({
      conversationFirst: false,
      vaultFiles: ['Products/Geode/Runs/My Report.md'],
    });
    await renderAndClick(harness, `[My Report](<${abs}>)`);
    expect(harness.workspaceCalls).toEqual(['Products/Geode/Runs/My Report.md']);
  });
});

describe('ThreadsView renderMarkdown — plain markdown link clicks (conversation-first placement)', () => {
  it('attaches a click listener and routes through contextPanel.openLinkText with the thread note as sourcePath', async () => {
    const harness = makeView({ conversationFirst: true, noteFile: 'Threads/my-thread.md' });
    await renderAndClick(harness, '[Plan](Notes/Plan.md)');
    expect(harness.contextPanelCalls).toEqual([['Notes/Plan.md', 'Threads/my-thread.md']]);
    expect(harness.workspaceCalls).toEqual([]);
  });

  it('resolves an OS-absolute path under the vault root before opening', async () => {
    const abs = '/Users/me/Documents/My Vault/Products/Geode/Runs/geode-2026-09-01-architecture-review.md';
    const harness = makeView({
      conversationFirst: true,
      vaultFiles: ['Products/Geode/Runs/geode-2026-09-01-architecture-review.md'],
    });
    await renderAndClick(harness, `[Geode Architecture Review](<${abs}>)`);
    expect(harness.contextPanelCalls).toEqual([
      ['Products/Geode/Runs/geode-2026-09-01-architecture-review.md', ''],
    ]);
  });
});

// [[wikilink]] anchors are wired by a separate handler. It used to pass an
// empty sourcePath in classic placement while conversation-first passed the
// thread note, so the same wikilink could resolve to two different files
// depending only on where the conversation was docked.
describe('ThreadsView renderMarkdown — wikilink sourcePath parity across placements', () => {
  it('resolves a relative wikilink against the thread note in classic placement', async () => {
    const harness = makeView({
      conversationFirst: false,
      vaultFiles: ['Projects/Roadmap.md'],
      noteFile: 'Claude/thread.md',
    });
    await renderAndClick(harness, 'See [[Roadmap]] for details.');
    expect(harness.workspaceCalls).toEqual(['Roadmap']);
    expect(harness.workspaceSourcePaths).toEqual(['Claude/thread.md']);
  });

  it('passes the same sourcePath in conversation-first placement', async () => {
    const harness = makeView({
      conversationFirst: true,
      vaultFiles: ['Projects/Roadmap.md'],
      noteFile: 'Claude/thread.md',
    });
    await renderAndClick(harness, 'See [[Roadmap]] for details.');
    expect(harness.contextPanelCalls).toEqual([['Roadmap', 'Claude/thread.md']]);
  });

  it('falls back to an empty sourcePath when the thread has no note file', async () => {
    const harness = makeView({ conversationFirst: false, vaultFiles: [] });
    await renderAndClick(harness, 'See [[Roadmap]] for details.');
    expect(harness.workspaceSourcePaths).toEqual(['']);
  });
});

// Regression coverage for "clicking a URL in the conversation doesn't open in
// the right tab" in conversation-first placement: an http(s) link previously
// got NO click listener at all (classifyRenderedMarkdownLink calls it
// 'external' and the vault-link handler bails out), so it fell through to the
// host's default anchor behavior — which has no idea about conversation-first
// placement or the Web Viewer's destination-leaf routing. Fixed by wiring
// these through the same openLink() the footer pills already use.
describe('ThreadsView renderMarkdown — external http(s) links route through openLink()', () => {
  it('attaches a click listener that calls openLink with the href', async () => {
    const harness = makeView({ conversationFirst: false });
    await renderAndClick(harness, '[Example](https://example.com)');
    expect(harness.openLinkCalls).toEqual([['https://example.com', false]]);
    expect(harness.workspaceCalls).toEqual([]);
    expect(harness.contextPanelCalls).toEqual([]);
  });

  it('routes the same way in conversation-first placement — openLink owns the destination-leaf branch', async () => {
    const harness = makeView({ conversationFirst: true, noteFile: 'Threads/my-thread.md' });
    await renderAndClick(harness, '[Example](https://example.com/path?x=1)');
    expect(harness.openLinkCalls).toEqual([['https://example.com/path?x=1', false]]);
  });

  it('forces the system browser on Cmd/Ctrl-click, matching the footer pill convention', async () => {
    const harness = makeView({ conversationFirst: false });
    const el = document.createElement('div');
    const render = (harness.view as unknown as {
      renderMarkdown(markdown: string, el: HTMLElement): Promise<void>;
    }).renderMarkdown.bind(harness.view);
    await render('[Example](https://example.com)', el);
    const link = el.querySelector('a') as HTMLAnchorElement;
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(harness.openLinkCalls).toEqual([['https://example.com', true]]);
  });

  it('leaves a mailto: link inert — only http(s) is intercepted', async () => {
    const harness = makeView({ conversationFirst: false });
    await renderAndClick(harness, '[Email](mailto:rick@example.com)');
    expect(harness.openLinkCalls).toEqual([]);
    expect(harness.workspaceCalls).toEqual([]);
    expect(harness.contextPanelCalls).toEqual([]);
  });
});

describe('ThreadsView renderMarkdown — same-page links stay inert', () => {
  it('does not attach a click listener to a same-page anchor', async () => {
    const harness = makeView({ conversationFirst: false });
    const el = document.createElement('div');
    const render = (harness.view as unknown as {
      renderMarkdown(markdown: string, el: HTMLElement): Promise<void>;
    }).renderMarkdown.bind(harness.view);
    await render('[Jump](#section)', el);
    const link = el.querySelector('a') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    link.click();
    expect(harness.workspaceCalls).toEqual([]);
    expect(harness.contextPanelCalls).toEqual([]);
    expect(harness.openLinkCalls).toEqual([]);
  });
});

/**
 * @vitest-environment jsdom
 *
 * Characterisation of the dock's strict markdown output (renderDockMarkdown)
 * recorded BEFORE the pipeline moved into src/messageRenderer as the strict
 * link policy. The snapshots must not be edited to make the move pass.
 */
import '../setup/obsidian-dom';
import { describe, expect, it } from 'vitest';
import { renderDockMarkdown } from '../../src/dockMarkdown';
import { dumpDom } from '../helpers/domDump';
import { DOCK_CASES, DOCK_RESOLVABLE, DOCK_THREADS } from '../fixtures/dockMarkdownCases';

describe('dock markdown golden output (legacy renderDockMarkdown)', () => {
  for (const [name, md] of Object.entries(DOCK_CASES)) {
    it(name, async () => {
      const el = document.createElement('div');
      await renderDockMarkdown(md, el, { threads: DOCK_THREADS, resolveLink: (h) => DOCK_RESOLVABLE.has(h) });
      expect(dumpDom(el)).toMatchSnapshot();
    });
  }
});

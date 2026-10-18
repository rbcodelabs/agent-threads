/**
 * toolCallDom.ts
 *
 * Shared DOM builders for tool-call rows and group headers, used by BOTH
 * ThreadsView (desktop) and MobileView so the markup cannot drift. The three
 * "Tool call style" looks (chips | tree | cards) are pure CSS over this one
 * structure, switched by a `ct-tools-<style>` class on the view root.
 */
import { setIcon } from 'obsidian';
import type { ToolCallRecord } from './types';
import {
  ACTIVITY_LABELS,
  formatToolName,
  formatToolRowSummary,
  getToolIcon,
  summarizeToolGroup,
  toolCallStyleClass,
  TOOL_CALL_STYLES,
  type ActivityKind,
  type ToolCallStyle,
  type ToolPathContext,
} from './toolNameUtils';

export type ToolState = 'pending' | 'success' | 'error';

const STATE_ICON: Record<ToolState, string> = { pending: 'loader-2', success: 'check', error: 'x' };

/** Swap the root's `ct-tools-*` class so the style changes live, no re-render. */
export function applyToolCallStyleClass(root: HTMLElement | null | undefined, style: ToolCallStyle): void {
  if (!root) return;
  for (const s of TOOL_CALL_STYLES) root.classList.toggle(toolCallStyleClass(s), s === style);
}

function statusIcon(parent: HTMLElement, cls: string, state: ToolState): HTMLElement {
  const el = parent.createSpan({ cls: `${cls} ct-tool-state-${state}` });
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', state === 'pending' ? 'running' : state === 'error' ? 'failed' : 'done');
  setIcon(el, STATE_ICON[state]);
  return el;
}

/**
 * One tool call row. `forcePending` is for mobile, whose records carry no
 * status: the live view marks every row running.
 */
export function renderToolRow(
  wrapper: HTMLElement,
  tool: ToolCallRecord,
  opts: { pathCtx?: ToolPathContext; time?: string; forcePending?: boolean } = {},
): HTMLElement {
  const state: ToolState = opts.forcePending ? 'pending' : (tool.status ?? 'success');
  const pill = wrapper.createDiv('ct-tool-pill');
  pill.setAttribute('tabindex', '0');
  if (state === 'error') pill.addClass('ct-tool-error');
  else if (state === 'success' && tool.status === 'success') pill.addClass('ct-tool-success');
  else if (state === 'pending') pill.addClass('ct-tool-active');

  statusIcon(pill, 'ct-tool-status', state);
  const iconEl = pill.createSpan({ cls: 'ct-tool-pill-icon' });
  setIcon(iconEl, getToolIcon(tool.name));
  pill.createSpan({ cls: 'ct-tool-pill-name', text: formatToolName(tool.name) });
  if (tool.summary) {
    const row = formatToolRowSummary(tool.name, tool.summary, opts.pathCtx);
    const text = pill.createSpan({
      cls: row.isPath ? 'ct-tool-pill-text ct-tool-pill-text-path' : 'ct-tool-pill-text',
      attr: { title: tool.summary },
    });
    if (row.isPath) {
      if (row.dir) text.createSpan({ cls: 'ct-tool-path-dir', text: row.dir });
      text.createSpan({ cls: 'ct-tool-path-file', text: row.main });
    } else {
      text.setText(row.main);
    }
  }
  if (opts.time) pill.createSpan({ cls: 'ct-tool-pill-ts', text: opts.time });
  return pill;
}

/**
 * Group shell: a real `<button aria-expanded>` header + the collapsible body.
 * Caller fills `body` with rows. `expanded` is the initial state; `onToggle`
 * lets the caller persist it (keyed expand/collapse sets).
 */
export function renderToolGroupShell(
  wrapper: HTMLElement,
  activityKind: ActivityKind,
  tools: ToolCallRecord[],
  opts: {
    hasError: boolean;
    hasPending: boolean;
    expanded: boolean;
    onToggle: (expanded: boolean) => void;
  },
): { groupEl: HTMLElement; headerRow: HTMLElement; body: HTMLElement } {
  const summary = summarizeToolGroup(activityKind, tools);
  const state: ToolState = opts.hasError ? 'error' : opts.hasPending ? 'pending' : 'success';

  const groupEl = wrapper.createDiv('ct-tool-group');
  groupEl.addClass(`ct-tool-group-${state}`);
  const headerRow = groupEl.createEl('button', {
    cls: 'ct-tool-group-header ct-compressed-row',
    attr: { type: 'button', 'aria-expanded': String(opts.expanded) },
  });
  // Flag on the header so the error / running tints (styles.css) apply.
  if (opts.hasError) headerRow.addClass('ct-tool-error');
  if (opts.hasPending) headerRow.addClass('ct-tool-active');

  statusIcon(headerRow, 'ct-tool-group-status', state);
  const iconEl = headerRow.createSpan({ cls: 'ct-tool-pill-icon ct-tool-group-icon' });
  setIcon(iconEl, getToolIcon(tools[0].name));
  // Running groups show the live activity name ("Working") with the count in a badge; finished groups get the one-line summary.
  const text = opts.hasPending ? ACTIVITY_LABELS[activityKind] : summary.label;
  headerRow.createSpan({ cls: 'ct-compressed-summary', text });
  headerRow.createSpan({
    cls: 'ct-tool-group-count',
    text: summary.countInLabel && !opts.hasPending ? String(tools.length) : `${tools.length}×`,
    attr: { 'data-count-in-label': String(summary.countInLabel && !opts.hasPending) },
  });
  if (opts.hasPending) headerRow.createSpan({ cls: 'ct-tool-group-running', text: 'running' });
  const chevron = headerRow.createSpan({ cls: 'ct-expand-btn', attr: { 'aria-hidden': 'true' } });

  const body = groupEl.createDiv('ct-full-content');
  let expanded = opts.expanded;
  const sync = (): void => {
    body.toggleClass('ct-hidden', !expanded);
    headerRow.setAttribute('aria-expanded', String(expanded));
    groupEl.toggleClass('ct-tool-group-open', expanded);
    // One glyph; each style rotates it via CSS (aria-expanded).
    setIcon(chevron, 'chevron-down');
  };
  sync();
  headerRow.addEventListener('click', () => {
    expanded = !expanded;
    sync();
    opts.onToggle(expanded);
  });
  return { groupEl, headerRow, body };
}

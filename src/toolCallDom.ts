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


const rowRecords = new WeakMap<HTMLElement, ToolCallRecord>();
const groupRefreshers = new WeakMap<HTMLElement, () => void>();

function paintRowClasses(pill: HTMLElement, tool: ToolCallRecord, state: ToolState): void {
  pill.classList.toggle('ct-tool-error', state === 'error');
  pill.classList.toggle('ct-tool-success', state === 'success' && tool.status === 'success');
  pill.classList.toggle('ct-tool-active', state === 'pending');
}

/**
 * A result landed for `toolUseId`: repaint that row (and its group) in place.
 * Records are mutated in place by the session, so this just re-reads them;
 * it covers rows committed mid-turn, whose DOM would otherwise stay "running".
 */
export function refreshToolRowByUseId(root: ParentNode, toolUseId: string): void {
  const sel = `.ct-tool-pill[data-tool-use-id="${toolUseId.replace(/["\\]/g, '')}"]`;
  root.querySelectorAll<HTMLElement>(sel).forEach((pill) => {
    const tool = rowRecords.get(pill);
    if (!tool) return;
    const state: ToolState = tool.status ?? 'success';
    paintRowClasses(pill, tool, state);
    const old = pill.querySelector<HTMLElement>('.ct-tool-status');
    if (old) {
      old.className = `ct-tool-status ct-tool-state-${state}`;
      old.setAttribute('aria-label', state === 'pending' ? 'running' : state === 'error' ? 'failed' : 'done');
      old.empty();
      setIcon(old, STATE_ICON[state]);
    }
    const group = pill.closest<HTMLElement>('.ct-tool-group');
    if (group) groupRefreshers.get(group)?.();
  });
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
  if (tool.toolUseId) pill.dataset.toolUseId = tool.toolUseId;
  rowRecords.set(pill, tool);
  paintRowClasses(pill, tool, state);

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
  const groupEl = wrapper.createDiv('ct-tool-group');
  const headerRow = groupEl.createEl('button', {
    cls: 'ct-tool-group-header ct-compressed-row',
    attr: { type: 'button' },
  });
  const body = groupEl.createDiv('ct-full-content');
  let expanded = opts.expanded;
  let userToggled = false;
  const wasRunning = opts.hasPending;
  // Mobile records carry no status: the caller says "running" and no result will ever land.
  const forcedPending = opts.hasPending && !tools.some(t => t.status === 'pending');

  const paintExpanded = (): void => {
    body.toggleClass('ct-hidden', !expanded);
    headerRow.setAttribute('aria-expanded', String(expanded));
    groupEl.toggleClass('ct-tool-group-open', expanded);
  };

  // Header content is derived from the (live-mutated) records, so it can be
  // repainted whenever a call's result lands.
  const paintHeader = (): void => {
    const hasError = tools.some(t => t.status === 'error');
    const hasPending = forcedPending || tools.some(t => t.status === 'pending');
    const state: ToolState = hasError ? 'error' : hasPending ? 'pending' : 'success';
    const summary = summarizeToolGroup(activityKind, tools);
    groupEl.className = `ct-tool-group ct-tool-group-${state}${expanded ? ' ct-tool-group-open' : ''}`;
    headerRow.empty();
    headerRow.classList.toggle('ct-tool-error', hasError);
    // Flag on the header so the error / running tints (styles.css) apply.
    headerRow.classList.toggle('ct-tool-active', hasPending);
    statusIcon(headerRow, 'ct-tool-group-status', state);
    const iconEl = headerRow.createSpan({ cls: 'ct-tool-pill-icon ct-tool-group-icon' });
    setIcon(iconEl, getToolIcon(tools[0].name));
    // Running groups show the live activity name ("Working") with the count in a badge; finished groups get the one-line summary.
    headerRow.createSpan({ cls: 'ct-compressed-summary', text: hasPending ? ACTIVITY_LABELS[activityKind] : summary.label });
    headerRow.createSpan({
      cls: 'ct-tool-group-count',
      text: String(tools.length),
      attr: { 'data-count-in-label': String(summary.countInLabel && !hasPending) },
    });
    if (hasPending) headerRow.createSpan({ cls: 'ct-tool-group-running', text: 'running' });
    const chevron = headerRow.createSpan({ cls: 'ct-expand-btn', attr: { 'aria-hidden': 'true' } });
    // One glyph; each style rotates it via CSS (aria-expanded).
    setIcon(chevron, 'chevron-down');
  };

  paintHeader();
  paintExpanded();
  groupRefreshers.set(groupEl, () => {
    const done = !forcedPending && !tools.some(t => t.status === 'pending');
    // A group that opened because it was running folds itself away once it
    // finishes, unless the user has taken over the toggle.
    if (done && wasRunning && !userToggled) expanded = false;
    paintHeader();
    paintExpanded();
  });
  headerRow.addEventListener('click', () => {
    expanded = !expanded;
    userToggled = true;
    paintHeader();
    paintExpanded();
    opts.onToggle(expanded);
  });
  return { groupEl, headerRow, body };
}

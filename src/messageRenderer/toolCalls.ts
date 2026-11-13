import { setIcon } from 'obsidian';
import type { ToolCallRecord } from '../types';
import { renderToolGroupShell, renderToolRow } from '../toolCallDom';
import {
  formatToolName, getToolIcon, groupToolRuns, liveToolGroupKey, pickCurrentTool, shouldWrapOuter,
  type ToolCallGroup, type ToolPathContext,
} from '../toolNameUtils';

/**
 * The tool-call renderer shared by the main panel (ThreadsView) and the dock sheet: pills, activity groups and the
 * second collapsible "outer wrap" tier. It was ThreadsView's private renderToolCalls / populateToolCallsWrapper /
 * renderGroupedEntries / renderToolPill / renderToolGroup / renderOuterToolWrap, moved here unchanged. What belongs to a
 * surface is injected: the expand/collapse sets (so a surface keeps them across row rebuilds and clears them when it
 * switches thread), the path context and clock for pill text, and the browser-session card behaviour (only the main
 * panel has one; without it a browser session renders as plain pills).
 */

/** Expand/collapse memory for tool groups and the outer wrap. The caller owns the sets (and clears them on a thread switch). */
export interface ToolCallExpandState {
  /** Finalized groups, keyed by a hash of their members' tool-use ids. */
  expandedToolGroups: Set<string>;
  /** Groups the user collapsed (a record only; nothing re-opens them). */
  userCollapsedToolGroups: Set<string>;
  /** LIVE groups, keyed by first call + kind (liveToolGroupKey): their member list keeps growing mid-turn. */
  liveExpandedToolGroups: Set<string>;
  /** Finalized outer wraps, keyed like finalized groups over the FULL flat tool list. */
  expandedOuterToolWrap: Set<string>;
  /** LIVE outer wraps (liveToolGroupKey over the tool list). */
  liveExpandedOuterToolWrap: Set<string>;
}

export function createToolCallExpandState(): ToolCallExpandState {
  return {
    expandedToolGroups: new Set(),
    userCollapsedToolGroups: new Set(),
    liveExpandedToolGroups: new Set(),
    expandedOuterToolWrap: new Set(),
    liveExpandedOuterToolWrap: new Set(),
  };
}

/** The part of a browser-session presenter the renderer needs (BrowserSessionPresenter satisfies it structurally). */
export interface ToolCallBrowserHooks {
  renderEntry(container: HTMLElement, entry: Extract<ToolCallGroup, { kind: 'browser' }>): void;
  needsAttention(tools: readonly ToolCallRecord[]): boolean;
}

export interface ToolCallRendererDeps {
  state: ToolCallExpandState;
  /** Vault root + home dir so tool-call paths render vault-relative / ~-relative. Read per pill. */
  pathContext(): ToolPathContext;
  /** Short clock text for a pill's timestamp. */
  formatTime(timestamp: number): string;
  /** The surface's browser cards, or null/undefined when it has none. Read lazily at render time. */
  browser(): ToolCallBrowserHooks | null | undefined;
}

export type PillRendered = (tool: ToolCallRecord, pill: HTMLElement) => void;

export class ToolCallRenderer {
  constructor(private readonly deps: ToolCallRendererDeps) {}

  /** Deterministic key for a FINALIZED tool-call group's expand/collapse state. */
  private toolGroupKey(tools: ToolCallRecord[]): string {
    return tools.map(t => t.toolUseId ?? t.timestamp ?? '').join(':');
  }

  /**
   * Deterministic key for a FINALIZED outer-wrap's expand/collapse state.
   * Thin wrapper over toolGroupKey — hashes the FULL flat tool list (not the
   * post-smoothing grouped entries), matching toolGroupKey's own convention.
   */
  private outerToolWrapKey(tools: ToolCallRecord[]): string {
    return this.toolGroupKey(tools);
  }

  /**
   * LIVE counterpart to outerToolWrapKey — thin wrapper over liveToolGroupKey
   * for the same "member list keeps growing mid-turn" reason liveToolGroupKey
   * exists at the group level (see that function's doc comment).
   */
  private outerLiveToolWrapKey(tools: ToolCallRecord[]): string {
    return liveToolGroupKey(tools);
  }

  /**
   * Render a single tool call as a `.ct-tool-pill` into `wrapper`. Shared by
   * the finalized flat (ungrouped) path, renderToolGroup's expanded body, and
   * the live-streaming path so isolated calls, grouped calls, and in-progress
   * calls all look identical. Returns the created pill so live-rendering can
   * register it for tool_progress heartbeat updates.
   */
  renderToolPill(wrapper: HTMLElement, tool: ToolCallRecord): HTMLElement {
    return renderToolRow(wrapper, tool, {
      pathCtx: this.deps.pathContext(),
      time: tool.timestamp ? this.deps.formatTime(tool.timestamp) : undefined,
    });
  }

  /**
   * @param opts.live When true, groups are keyed/expand-tracked the same way
   *   the live-streaming path does — via liveToolGroupKey
   *   + liveExpandedToolGroups instead of the stable id-hash keying used by
   *   default. Needed by the R3 in-place tail-row rebuild: that row's member
   *   list keeps growing as the still-open run receives more tool-only steps,
   *   so a stable-hash key would change on every extension and silently
   *   re-collapse a group the user had expanded. Only that call site should
   *   pass `live: true` — first-time append of a settled row and the full
   *   rebuild both keep the default (stable) keying.
   */
  renderToolCalls(
    parent: HTMLElement,
    tools: ToolCallRecord[],
    opts?: { live?: boolean; onPillRendered?: PillRendered },
  ): HTMLElement {
    const wrapper = parent.createDiv('ct-tools');
    this.populateToolCallsWrapper(wrapper, tools, { live: opts?.live ?? false, onPillRendered: opts?.onPillRendered });
    return wrapper;
  }

  /**
   * The one place "group + decide + render" policy for a tool-call list
   * lives. Groups the raw tools into runs, then either renders flat (the
   * common case) or wraps the whole list in a second collapsible tier once it
   * is still too long (see shouldWrapOuter/OUTER_WRAP_ENTRY_THRESHOLD).
   */
  populateToolCallsWrapper(
    wrapper: HTMLElement,
    tools: ToolCallRecord[],
    opts: { live: boolean; onPillRendered?: PillRendered },
  ): void {
    const grouped = groupToolRuns(tools);
    if (shouldWrapOuter(grouped)) {
      this.renderOuterToolWrap(wrapper, tools, grouped, opts);
    } else {
      this.renderGroupedEntries(wrapper, grouped, opts);
    }
  }

  /**
   * Renders one layer of tool-call entries (singles and groups) into
   * `container` — the exact per-entry loop shared by the flat (non-wrapped)
   * render path AND the expanded body of the outer wrap (renderOuterToolWrap),
   * so the two structurally match. `opts.onPillRendered` is threaded through
   * to renderToolGroup so live-mode pill registration keeps working even when
   * a group ends up nested inside the outer wrap.
   */
  private renderGroupedEntries(
    container: HTMLElement,
    grouped: ToolCallGroup[],
    opts: { live: boolean; onPillRendered?: PillRendered },
  ): void {
    for (const entry of grouped) {
      if (entry.kind === 'single') {
        const pill = this.renderToolPill(container, entry.tool);
        opts.onPillRendered?.(entry.tool, pill);
      } else if (entry.kind === 'browser') {
        // One card per browser session, in place of tool pills. Live and
        // finalized rendering share this call, so they cannot drift.
        const browser = this.deps.browser();
        if (browser) browser.renderEntry(container, entry);
        else for (const tool of entry.tools) this.renderToolPill(container, tool);
      } else if (opts.live) {
        this.renderToolGroup(container, entry, {
          keyOverride: liveToolGroupKey(entry.tools),
          expandedSet: this.deps.state.liveExpandedToolGroups,
          onPillRendered: opts.onPillRendered,
        });
      } else {
        this.renderToolGroup(container, entry);
      }
    }
  }

  /**
   * Second collapsible tier, wrapping the ENTIRE entry list when it's still
   * too long to render flat (see shouldWrapOuter). Mirrors renderToolGroup's
   * collapse/expand pattern one level up: collapsed by default, auto-expands
   * through BOTH tiers if any descendant tool errored, and — while live —
   * shows a live-updating "currently executing tool" header instead of a
   * static count so a long collapsed run doesn't read as frozen.
   */
  private renderOuterToolWrap(
    wrapper: HTMLElement,
    tools: ToolCallRecord[],
    grouped: ToolCallGroup[],
    opts: { live: boolean; onPillRendered?: PillRendered },
  ): void {
    const hasError = tools.some(t => t.status === 'error');
    const hasPending = tools.some(t => t.status === 'pending');

    const groupEl = wrapper.createDiv('ct-tool-outer-wrap');
    const headerRow = groupEl.createDiv('ct-tool-outer-wrap-header ct-compressed-row');
    if (hasError) headerRow.addClass('ct-tool-error');

    if (opts.live && hasPending) {
      headerRow.addClass('ct-tool-active');
      const current = pickCurrentTool(tools);
      const summaryEl = headerRow.createSpan({ cls: 'ct-tool-outer-wrap-live-summary' });
      if (current) {
        const iconEl = summaryEl.createSpan({ cls: 'ct-tool-pill-icon' });
        setIcon(iconEl, getToolIcon(current.name));
        summaryEl.createSpan({ cls: 'ct-tool-pill-name', text: formatToolName(current.name) });
        if (current.summary) summaryEl.createSpan({ cls: 'ct-tool-pill-text', text: current.summary });
      }
    } else {
      // 'list-tree' reads as "a nested list of steps," matching what the
      // outer wrap actually contains (a list of groups, each a list of pills).
      const iconEl = headerRow.createSpan({ cls: 'ct-tool-pill-icon' });
      setIcon(iconEl, 'list-tree');
      headerRow.createSpan({
        cls: 'ct-compressed-summary',
        text: `${tools.length} tool calls, ${grouped.length} steps`,
      });
    }

    const expandBtn = headerRow.createEl('button', { cls: 'ct-expand-btn', attr: { title: 'Expand' } });

    const fullContent = groupEl.createDiv('ct-full-content');
    this.renderGroupedEntries(fullContent, grouped, opts);

    const expandedSet = opts.live ? this.deps.state.liveExpandedOuterToolWrap : this.deps.state.expandedOuterToolWrap;
    const key = opts.live ? this.outerLiveToolWrapKey(tools) : this.outerToolWrapKey(tools);
    // A browser card waiting on the human (sign-in) must not hide behind a collapsed wrap.
    let expanded = hasError || expandedSet.has(key) || (this.deps.browser()?.needsAttention(tools) ?? false);
    if (!expanded) fullContent.addClass('ct-hidden');
    setIcon(expandBtn, expanded ? 'chevron-up' : 'chevron-down');

    expandBtn.addEventListener('click', () => {
      expanded = !expanded;
      if (expanded) {
        fullContent.removeClass('ct-hidden');
        expandedSet.add(key);
      } else {
        fullContent.addClass('ct-hidden');
        expandedSet.delete(key);
      }
      setIcon(expandBtn, expanded ? 'chevron-up' : 'chevron-down');
    });
  }

  /**
   * Render a run of consecutive tool calls as a collapsible section,
   * mirroring the compressed-view collapse/expand pattern and CSS classes. The
   * header's red icon flags a failure; only a group the user opened stays open.
   *
   * Shared by the finalized view (default opts) and the live-streaming view
   * (a stable liveToolGroupKey + a dedicated expand-state set + a callback to
   * register pending pills for tool_progress heartbeat lookups).
   */
  private renderToolGroup(
    wrapper: HTMLElement,
    entry: Extract<ToolCallGroup, { kind: 'group' }>,
    opts?: {
      keyOverride?: string;
      expandedSet?: Set<string>;
      onPillRendered?: PillRendered;
    },
  ): void {
    const { activityKind, tools } = entry;
    const hasError = tools.some(t => t.status === 'error');
    const hasPending = tools.some(t => t.status === 'pending');
    const expandedSet = opts?.expandedSet ?? this.deps.state.expandedToolGroups;
    const groupKey = opts?.keyOverride ?? this.toolGroupKey(tools);

    // Collapsed by default, running, failed or finished; the red header icon
    // flags a failure. Only a group the user opened stays open.
    const expanded = expandedSet.has(groupKey);
    const { body } = renderToolGroupShell(wrapper, activityKind, tools, {
      hasError,
      hasPending,
      expanded,
      onToggle: (open) => {
        if (open) {
          expandedSet.add(groupKey);
          this.deps.state.userCollapsedToolGroups.delete(groupKey);
        } else {
          expandedSet.delete(groupKey);
          this.deps.state.userCollapsedToolGroups.add(groupKey);
        }
      },
    });
    for (const tool of tools) {
      const pill = this.renderToolPill(body, tool);
      opts?.onPillRendered?.(tool, pill);
    }
  }
}

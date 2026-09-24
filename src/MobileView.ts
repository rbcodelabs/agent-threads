/**
 * MobileView.ts
 *
 * Obsidian ItemView for the mobile remote-access client. Renders threads from
 * MobileThreadStore and sends RemoteCommands via RelayClient.
 *
 * This view intentionally has no knowledge of ThreadManager, ClaudeSession, or
 * VaultPersistence — all state comes through the relay.
 */

import { ItemView, WorkspaceLeaf, Notice, sanitizeHTMLToDom, setIcon } from 'obsidian';
import { marked } from 'marked';
import type { RelayClient } from './RelayClient';
import type { MobileThreadStore } from './MobileThreadStore';
import type { SerializedThread, SerializedMessage, PendingPermission, PendingQuestion } from './relay-protocol';
import type { ToolCallRecord, ImageAttachment } from './types';
import { formatToolName, getToolIcon, groupToolCalls, smoothToolGroups, ACTIVITY_LABELS, type ToolCallGroup } from './toolNameUtils';
import { splitErrorMessage } from './dashboardUtils';
import { extractMessageContent } from './MessageContent';
import { classifyRenderedMarkdownLink, isOsAbsoluteHref, resolveAbsoluteVaultHref } from './linkUtils';
import {
  VISUALIZE_SLOT_ATTR,
  VISUALIZE_SLOT_CLASS,
  basename,
  extractVisualizeMarkers,
  type VisualizeMarker,
} from './visualizeMarker';

export const MOBILE_VIEW_TYPE = 'claude-threads:mobile';

export class MobileView extends ItemView {
  private relayClient: RelayClient | null;
  private store: MobileThreadStore | null;

  // DOM refs
  private rootEl!: HTMLElement;
  private headerEl!: HTMLElement;
  private listPanelEl!: HTMLElement;
  private convPanelEl!: HTMLElement;
  private disconnectedBannerEl: HTMLElement | null = null;
  private threadListEl!: HTMLElement;
  private conversationEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputRowEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private convTitleEl!: HTMLSpanElement;
  private convModelEl!: HTMLSpanElement;
  private convCwdEl!: HTMLElement;
  private statusRailEl!: HTMLElement;
  private statusRailCardEl: HTMLElement | null = null;
  private showingList = false; // user pressed back — stay on list even if desktop has active thread
  // Image attachments pending send
  private pendingImages: Array<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; name: string }> = [];
  private imageStripEl!: HTMLElement;
  private fileInputEl!: HTMLInputElement;
  // Thread search / filter
  private _threadFilter = '';
  private _filterDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Queue rows container
  private queueRowsEl: HTMLElement | null = null;
  // Running thread-row elements, keyed by threadId, for the stale-spinner sweep.
  private threadItemEls: Map<string, HTMLElement> = new Map();
  // Lightweight sweep to pause spinners of wedged ("stale") streaming rows.
  private staleInterval: ReturnType<typeof setInterval> | null = null;
  // Dismiss state for error card
  private _errorDismissed: Set<string> = new Set();

  // Incremental render tracking — avoids full re-render on every streaming token
  private lastRenderedActiveId: string | null = null;
  private lastRenderedMessageCount = -1;
  private lastRenderedPermissionCount = -1;
  private lastRenderedQuestionCount = -1;
  private streamingEl: HTMLElement | null = null;

  // Expand/collapse state for tool-call groups (see renderToolGroup), keyed by
  // `${startIndex}:${activityKind}` — mobile ToolCallRecords carry no
  // toolUseId/timestamp (see MobileThreadStore.streamingTools), so position in
  // the tool list is the only stable-ish identity available. Cleared on thread
  // switch in renderConversation so state doesn't leak across threads. Note:
  // updateStreamingEl() fully tears down and recreates the streaming element on
  // every token/tool event, so expand state naturally does not persist across a
  // live rebuild — this matches the pre-existing lack of any live incremental
  // state on mobile (no per-tool status/toolUseId either); only the finalized
  // per-message render benefits from this persisting.
  private expandedToolGroups: Set<string> = new Set();

  // Context summary banner (mirrors desktop behaviour)
  private summaryBannerEl: HTMLElement | null = null;
  private summaryBannerTimer: ReturnType<typeof setTimeout> | null = null;
  private _summaryBannerOutsideTap?: (e: PointerEvent) => void;
  private threadAccessTimes: Map<string, number> = new Map();
  private static readonly BANNER_IDLE_THRESHOLD_MS = 60_000;
  private static readonly BANNER_AUTO_DISMISS_MS = 10_000;

  // Cleanup handles
  private unsubStore: (() => void) | null = null;
  private unsubConnectionState: (() => void) | null = null;
  private scrollObserver: MutationObserver | null = null;
  private vpFocusHandler: (() => void) | null = null;
  private vpBlurHandler: (() => void) | null = null;
  private vpHandler: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    relayClient: RelayClient | null,
    store: MobileThreadStore | null,
  ) {
    super(leaf);
    this.relayClient = relayClient;
    this.store = store;
  }

  getViewType(): string {
    return MOBILE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Agent Threads (Mobile)';
  }

  getIcon(): string {
    return 'smartphone';
  }

  async onOpen(): Promise<void> {
    this.buildUI();
    this.render();
    this.attachViewportListener();

    if (this.store) {
      this.unsubStore = this.store.subscribe(() => this.render());
    }

    if (this.relayClient) {
      this.unsubConnectionState = this.relayClient.onConnectionStateChange((state) => {
        this.updateConnectionBanner(state);
      });
    }

    this.staleInterval = setInterval(() => this.refreshStale(), 15_000);
  }

  async onClose(): Promise<void> {
    this.detachViewportListener();
    this.unsubStore?.();
    this.unsubConnectionState?.();
    if (this.staleInterval) clearInterval(this.staleInterval);
    this.scrollObserver?.disconnect();
    this.scrollObserver = null;
    this.hideSummaryBanner(true);
  }

  /**
   * Toggles `.ct-stale` on each streaming row so styles.css pauses its spinner
   * once the thread's stream has been quiet for STALE_MS. Runs on an interval
   * because a wedged thread produces no store notifications to re-render on.
   */
  private refreshStale(): void {
    if (!this.store) return;
    for (const [id, el] of this.threadItemEls) {
      el.toggleClass('ct-stale', this.store.isStale(id));
    }
  }

  // ── UI construction ───────────────────────────────────────────────────

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    this.rootEl = root;
    root.empty();
    root.addClass('ct-mobile-root');

    // ── List panel ────────────────────────────────────────────────────
    this.listPanelEl = root.createDiv('ct-mobile-list-panel');
    const listPanel = this.listPanelEl;
    const listHeader = listPanel.createDiv('ct-mobile-list-header');
    listHeader.createEl('span', { cls: 'ct-mobile-list-title', text: 'Agent Threads' });
    const newBtn = listHeader.createEl('button', { cls: 'ct-mobile-new-btn', attr: { title: 'New thread' } });
    newBtn.createSpan({ text: '+' });
    newBtn.addEventListener('click', () => {
      this.showingList = false; // clear back-navigation guard so we switch to the new thread
      this.relayClient?.sendCommand({ type: 'create_thread', title: 'New Thread' });
    });

    // 3.3 — Search input above thread list
    const searchEl = listPanel.createEl('input', {
      cls: 'ct-mobile-search-input',
      attr: { type: 'text', placeholder: 'Search threads…' },
    }) as HTMLInputElement;
    searchEl.addEventListener('input', () => {
      if (this._filterDebounceTimer !== null) clearTimeout(this._filterDebounceTimer);
      this._filterDebounceTimer = setTimeout(() => {
        this._threadFilter = searchEl.value;
        if (this.store) {
          this.renderThreadList(this.store.getThreads(), this.store.getActiveThreadId());
        }
      }, 150);
    });

    this.threadListEl = listPanel.createDiv('ct-mobile-thread-list');

    // ── Conversation panel ────────────────────────────────────────────
    this.convPanelEl = root.createDiv('ct-mobile-conv-panel');
    const convPanel = this.convPanelEl;
    this.headerEl = convPanel.createDiv('ct-mobile-conv-header');
    const backBtn = this.headerEl.createEl('button', { cls: 'ct-mobile-back-btn' });
    backBtn.setText('‹');
    backBtn.addEventListener('click', () => {
      this.showingList = true;
      this.showPanel('list');
    });
    this.convTitleEl = this.headerEl.createEl('span', { cls: 'ct-mobile-conv-title' });
    // 3.4 — Model indicator (right-aligned, read-only)
    this.convModelEl = this.headerEl.createEl('span', { cls: 'ct-mobile-model-indicator' });
    this.convModelEl.style.display = 'none';

    // 3.7 — cwd chip: lives below the header in the conv panel, above the messages
    this.convCwdEl = convPanel.createDiv('ct-mobile-cwd-chip-bar');
    this.convCwdEl.style.display = 'none';

    this.conversationEl = convPanel.createDiv('ct-mobile-conversation');
    this.messagesEl = this.conversationEl.createDiv('ct-mobile-messages');

    // 3.2 — Status rail above input
    this.statusRailEl = convPanel.createDiv('ct-mobile-status-rail');

    this.inputRowEl = convPanel.createDiv('ct-mobile-input-row');

    // 3.12 — Queue rows container (inside inputRowEl, above imageStrip)
    this.queueRowsEl = this.inputRowEl.createDiv('ct-mobile-queue-rows');
    this.queueRowsEl.style.display = 'none';

    this.imageStripEl = this.inputRowEl.createDiv('ct-mobile-image-strip');
    this.imageStripEl.style.display = 'none';
    const inputControls = this.inputRowEl.createDiv('ct-mobile-input-controls');
    const attachBtn = inputControls.createEl('button', { cls: 'ct-mobile-attach-btn', attr: { title: 'Attach image' } });
    attachBtn.setText('⊕');
    this.fileInputEl = this.inputRowEl.createEl('input', { type: 'file', attr: { accept: 'image/*', multiple: 'true' } });
    this.fileInputEl.style.display = 'none';
    attachBtn.addEventListener('click', () => this.fileInputEl.click());
    this.fileInputEl.addEventListener('change', () => this.handleImageSelect());
    this.inputEl = inputControls.createEl('textarea', {
      cls: 'ct-mobile-input',
      attr: { placeholder: 'Message Claude', rows: '1' },
    });
    this.sendBtn = inputControls.createEl('button', { cls: 'ct-mobile-send-btn', text: '↵', attr: { title: 'Send message' } });
    this.sendBtn.addEventListener('click', () => this.handleSend());
    this.stopBtn = inputControls.createEl('button', { cls: 'ct-mobile-stop-btn', text: '■', attr: { title: 'Stop' } });
    this.stopBtn.style.display = 'none';
    this.stopBtn.addEventListener('click', () => this.handleStop());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });
    // Auto-grow textarea
    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  private render(): void {
    if (!this.store || !this.relayClient) {
      this.renderPairingScreen();
      return;
    }

    const threads = this.store.getThreads();
    const activeId = this.store.getActiveThreadId();

    this.renderThreadList(threads, activeId);

    // Toggle send/stop based on streaming state
    const isStreaming = activeId ? this.store.isStreaming(activeId) : false;
    this.sendBtn.style.display = isStreaming ? 'none' : '';
    this.stopBtn.style.display = isStreaming ? '' : 'none';

    // Update queue banner
    this.updateQueueBanner(activeId);

    const thread = activeId ? this.store.getThread(activeId) : null;
    this.inputEl.placeholder = thread?.agentHarness === 'codex' ? 'Message Codex' : 'Message Claude';
    const msgCount = thread?.messages.length ?? 0;
    const permCount = activeId ? (this.store.getPendingPermissionsForThread(activeId)?.length ?? 0) : 0;
    const questionCount = activeId ? (this.store.getPendingQuestionsForThread(activeId)?.length ?? 0) : 0;

    if (
      activeId !== this.lastRenderedActiveId ||
      msgCount !== this.lastRenderedMessageCount ||
      permCount !== this.lastRenderedPermissionCount ||
      questionCount !== this.lastRenderedQuestionCount
    ) {
      // Thread changed, new messages finalized, or permission/question state changed — full re-render.
      this.renderConversation(activeId);
      this.lastRenderedActiveId = activeId;
      this.lastRenderedMessageCount = msgCount;
      this.lastRenderedPermissionCount = permCount;
      this.lastRenderedQuestionCount = questionCount;
    } else {
      // Same thread, same message count — streaming token arrived.
      // Only swap out the streaming element; stable messages stay untouched.
      this.updateStreamingEl(activeId);
    }

    // If there's a pending permission or question for the active thread and the user is
    // on the list view, override the back-navigation guard and bring them to the
    // conversation panel so they don't miss the card.
    if (activeId && (permCount > 0 || questionCount > 0) && this.showingList) {
      this.showingList = false;
    }

    // Switch to conversation panel when there's an active thread and the user
    // hasn't explicitly navigated back to the list.
    if (activeId && !this.showingList) {
      this.convTitleEl.textContent = thread?.title ?? '';
      // 3.4 — Model indicator
      this.updateModelIndicator(thread ?? null);
      // 3.7 — cwd chip
      this.updateCwdChip(thread ?? null);
      this.showPanel('conversation');
    } else if (!activeId) {
      this.showingList = false;
      this.showPanel('list');
    }

    // 3.2 — Status rail
    this.updateStatusRail(activeId);

    // 3.10 — Error card (rendered as part of renderConversation, but we also
    // need to clear it when the active thread has no error or changes)
  }

  private renderPairingScreen(): void {
    this.threadListEl.empty();
    this.messagesEl.empty();
    this.showPanel('list');

    const el = this.threadListEl.createDiv('ct-mobile-pairing');
    el.createEl('div', { cls: 'ct-mobile-pairing-icon', text: '⟳' });
    el.createEl('h3', { text: 'Not connected' });
    el.createEl('p', {
      text: 'On desktop: Settings > Agent Threads > Remote Access > enable > Show QR code.',
      cls: 'ct-mobile-pairing-text',
    });
    el.createEl('p', {
      text: 'Scan the QR code with your phone camera, or paste the pairing code in Settings.',
      cls: 'ct-mobile-pairing-text',
    });
  }

  private renderThreadList(threads: SerializedThread[], activeId: string | null): void {
    this.threadListEl.empty();
    this.threadItemEls.clear();

    // 3.3 — Apply search filter
    const filter = this._threadFilter.trim().toLowerCase();
    let filtered = threads;
    if (filter) {
      filtered = threads.filter(t => {
        if (t.title?.toLowerCase().includes(filter)) return true;
        const preview = (t.summary ?? t.recap ?? t.messages.filter(m => m.role !== 'compact').at(-1)?.content ?? '').toLowerCase();
        return preview.includes(filter);
      });
    }

    if (filtered.length === 0) {
      const empty = this.threadListEl.createDiv({ cls: 'ct-mobile-no-threads' });
      if (filter) {
        empty.createEl('p', { text: 'No results.' });
      } else {
        empty.createEl('p', { text: 'No threads yet.' });
        empty.createEl('p', { text: 'Create one on desktop to get started.', cls: 'ct-mobile-hint' });
      }
      return;
    }

    // Group threads by status, each group sorted by updatedAt descending.
    // Labels intentionally mirror the desktop Agent Dashboard: Working / New / Reviewed / Failed / Ready.
    const byUpdated = (a: SerializedThread, b: SerializedThread) => b.updatedAt - a.updatedAt;
    const running    = filtered.filter(t => this.store!.isStreaming(t.id)).sort(byUpdated);
    const failed     = filtered.filter(t => !this.store!.isStreaming(t.id) && t.lastError).sort(byUpdated);
    const unreviewed = filtered.filter(t => !this.store!.isStreaming(t.id) && !t.lastError && t.messages.length > 0 && !t.reviewed).sort(byUpdated);
    const reviewed   = filtered.filter(t => !this.store!.isStreaming(t.id) && !t.lastError && t.messages.length > 0 && t.reviewed).sort(byUpdated);
    const empty      = filtered.filter(t => !this.store!.isStreaming(t.id) && !t.lastError && t.messages.length === 0).sort(byUpdated);

    const groups: Array<{ label: string; threads: SerializedThread[] }> = [
      { label: 'Working',  threads: running },
      { label: 'Failed',   threads: failed },
      { label: 'New',      threads: unreviewed },
      { label: 'Reviewed', threads: reviewed },
      { label: 'Ready',    threads: empty },
    ];

    for (const group of groups) {
      if (group.threads.length === 0) continue;

      const groupEl = this.threadListEl.createDiv('ct-mobile-thread-group');
      groupEl.createDiv({ cls: 'ct-mobile-thread-group-label', text: group.label });

      for (const thread of group.threads) {
        this.renderThreadRow(thread, activeId, groupEl);
      }
    }
  }

  private renderThreadRow(thread: SerializedThread, activeId: string | null, container: HTMLElement): void {
    const isActive = thread.id === activeId;
    const isStreaming = this.store!.isStreaming(thread.id);
    const hasPendingPermission = this.store!.getPendingPermissionsForThread(thread.id).length > 0;
    const hasPendingQuestion = this.store!.getPendingQuestionsForThread(thread.id).length > 0;
    const needsInput = hasPendingPermission || hasPendingQuestion;

    const item = container.createDiv({
      cls: `ct-mobile-thread-item${isActive ? ' ct-mobile-thread-item-active' : ''}${needsInput ? ' ct-mobile-thread-item-permission' : ''}`,
    });
    if (isStreaming) {
      this.threadItemEls.set(thread.id, item);
      item.toggleClass('ct-stale', this.store!.isStale(thread.id));
    }

    // Left: status icon — permission/question badge (both mean "Claude needs your
    // input") takes priority over streaming indicator
    let icon = '›';
    let iconCls = 'ct-mobile-thread-icon';
    if (needsInput) {
      icon = '?';
      iconCls += ' ct-mobile-thread-icon-permission';
    } else if (isStreaming) {
      icon = '✽';
      iconCls += ' ct-mobile-thread-icon-running';
    } else if (thread.lastError) {
      icon = '✗';
      iconCls += ' ct-mobile-thread-icon-error';
    } else if (thread.messages.length === 0) {
      icon = '○';
      iconCls += ' ct-mobile-thread-icon-empty';
    } else {
      icon = '✓';
      iconCls += ' ct-mobile-thread-icon-done';
    }
    item.createSpan({ cls: iconCls, text: icon });

    // Middle: title + subtitle
    const meta = item.createDiv('ct-mobile-thread-meta');
    meta.createSpan({ cls: 'ct-mobile-thread-title', text: thread.title || 'Untitled' });

    const subtitle = thread.lastError
      ? thread.lastError.slice(0, 80)
      : (thread.summary || thread.recap)
        ? (thread.summary || thread.recap)!.replace(/\n/g, ' ').slice(0, 80)
        : thread.messages.filter(m => m.role !== 'compact').at(-1)?.content.slice(0, 80).replace(/\n/g, ' ') ?? '';

    if (subtitle) {
      meta.createSpan({ cls: 'ct-mobile-thread-preview', text: subtitle });
    }

    // Right: relative time + chevron
    const right = item.createDiv('ct-mobile-thread-right');
    if (thread.updatedAt) {
      right.createSpan({ cls: 'ct-mobile-thread-time', text: relativeTime(thread.updatedAt) });
    }
    right.createSpan({ cls: 'ct-mobile-thread-chevron', text: '›' });

    item.addEventListener('click', () => {
      this.showingList = false;
      this.convTitleEl.textContent = thread.title || 'Untitled';
      this.showPanel('conversation');

      const previousId = this.store!.getActiveThreadId();
      const priorAccessTime = this.threadAccessTimes.get(thread.id);
      this.threadAccessTimes.set(thread.id, Date.now());

      this.store!.setActiveThreadId(thread.id);
      this.relayClient!.sendCommand({ type: 'set_active_thread', threadId: thread.id });

      // Show context recap banner when returning to a thread after a real break
      this.maybeShowSummaryBanner(thread, previousId, priorAccessTime);
    });
  }

  private renderConversation(activeId: string | null): void {
    // Clear the streaming element ref — it will be destroyed by empty() below.
    this.streamingEl = null;
    this.messagesEl.empty();
    this.expandedToolGroups.clear();

    if (!activeId || !this.store) {
      this.messagesEl.createDiv({ cls: 'ct-mobile-empty', text: 'Send a message to start.' });
      return;
    }

    const thread = this.store.getThread(activeId);
    if (!thread) {
      return;
    }

    // Render permission cards for this thread first
    const permissions = this.store.getPendingPermissionsForThread(activeId);
    for (const permission of permissions) {
      this.renderPermissionCard(permission);
    }

    // Render question cards for this thread
    const questions = this.store.getPendingQuestionsForThread(activeId);
    for (const question of questions) {
      this.renderQuestionCard(question);
    }

    // Render settled messages
    for (const msg of thread.messages) {
      this.renderMessage(msg);
    }

    // 3.10 — Error card (shown when thread has a lastError and not dismissed)
    if (thread.lastError && !this._errorDismissed.has(activeId)) {
      this.renderErrorCard(activeId, thread.lastError);
    }

    // Append streaming element if active
    this.updateStreamingEl(activeId);

    this.scrollToBottom();
  }

  private async renderMarkdown(markdown: string, el: HTMLElement, options: { streaming?: boolean } = {}): Promise<void> {
    // Codex's wrapped `visualize` content references become inert cards here. The
    // mobile client is a relay: the fragment lives on the desktop machine's
    // disk, and renderConversation() rebuilds the whole list on every finalized
    // message with no throttle, so mounting sandboxed iframes is doubly wrong.
    const inline = extractMessageContent(markdown, options);
    const visualize = extractVisualizeMarkers(inline.text);

    // Pre-process [[wikilinks]] and [[target|alias]] into inline HTML anchors
    // before handing off to marked. Mirrors the ThreadsView approach — see that
    // method for the full rationale (short version: MarkdownRenderer.render()
    // does not parse GFM pipe tables in this non-document context).
    const processed = visualize.text.replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_match, target: string, alias?: string) => {
        const label = (alias ?? target.split('/').pop() ?? target).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c] ?? c));
        const escapedTarget = target.replace(/"/g, '&quot;');
        return `<a class="internal-link" data-href="${escapedTarget}" href="#">${label}</a>`;
      },
    );
    el.appendChild(sanitizeHTMLToDom(await marked.parse(processed)));
    this.hydrateVisualizeSlots(el, visualize.markers);
    // Relay clients have no local peer provider or remote action protocol.
    for (const marker of inline.markers) {
      const slots = Array.from(el.querySelectorAll<HTMLElement>('.ct-message-content-slot')).filter(slot => slot.getAttribute('data-ct-content') === marker.token);
      if (slots.length !== 1) continue;
      const card = document.createElement('section'); card.className = 'ct-inline-content'; card.dataset.kind = 'fallback';
      const title = document.createElement('div'); title.className = 'ct-inline-content-title'; title.textContent = marker.ref.title; card.appendChild(title);
      const status = document.createElement('div'); status.className = 'ct-inline-content-status'; status.textContent = options.streaming ? 'Content will be available when the response finishes.' : 'Content unavailable on this device'; card.appendChild(status);
      const slot = slots[0];
      if (slot.parentElement?.tagName === 'P' && slot.parentElement.childNodes.length === 1) slot.parentElement.replaceWith(card); else slot.replaceWith(card);
    }
    // Wrap tables in a scrollable container so wide tables don't overflow.
    el.querySelectorAll<HTMLTableElement>('table').forEach((table) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'ct-table-scroll';
      table.parentNode?.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });
    el.querySelectorAll<HTMLAnchorElement>('a.internal-link').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const href = a.getAttribute('data-href') ?? a.getAttribute('href') ?? '';
        void this.app.workspace.openLinkText(href, '', false);
      });
    });
    // marked renders ordinary `[label](path.md#heading)` links without the
    // custom wikilink class, so — unlike the block above — they never got a
    // click handler at all: mobile is always classic placement, and this view
    // had no equivalent of ThreadsView's plain-markdown-link wiring. Some
    // hrefs are OS-absolute paths that happen to fall under the synced vault
    // (e.g. a fragment written from outside Obsidian) — resolve those first.
    // This uses the shared helper rather than resolveVaultCopy because marked
    // percent-encodes hrefs and only the helper probes the decoded form; the
    // callback preserves resolveVaultCopy's relay-client guard, where the
    // client has no vault index at all. A non-absolute href is forwarded
    // untouched so openLinkText keeps ownership of subpath parsing/decoding.
    el.querySelectorAll<HTMLAnchorElement>(`a:not(.internal-link):not(.${VISUALIZE_SLOT_CLASS})`).forEach((a) => {
      const href = a.getAttribute('href') ?? '';
      if (classifyRenderedMarkdownLink(href) !== 'vault') return;
      const absolute = isOsAbsoluteHref(href);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Resolved on click rather than at render, so a target that finishes
        // syncing to the phone after this message rendered still opens.
        const resolved = resolveAbsoluteVaultHref(href, (p) => {
          try { return !!this.app.vault.getAbstractFileByPath(p); } catch { return false; }
        });
        // An absolute desktop path with no synced vault copy is not vault
        // linktext; forwarding it risks creating a stray note named after the
        // path. Say so instead — the file genuinely isn't on this device.
        if (absolute && !resolved) {
          new Notice('That link points to a file that is not in this vault.');
          return;
        }
        void this.app.workspace.openLinkText(resolved ?? href, '', false);
      });
    });
  }

  /**
   * Resolve a desktop-side absolute path to a vault file, if the fragment
   * happens to live inside the synced vault.
   *
   * The mobile client never sees the desktop's vault root, so the absolute path
   * cannot be trimmed arithmetically. Instead the path's suffixes are probed
   * longest-first against the vault index: each probe is a map lookup, and the
   * longest match is by construction the correct one.
   */
  private resolveVaultCopy(absolutePath: string): string | null {
    const segments = absolutePath.replace(/\\/g, '/').split('/').filter(Boolean);
    try {
      for (let start = 0; start < segments.length; start++) {
        const candidate = segments.slice(start).join('/');
        if (this.app.vault.getAbstractFileByPath(candidate)) return candidate;
      }
    } catch {
      // No vault index available (relay-only client): fall through to the
      // desktop-only card rather than failing the whole message render.
    }
    return null;
  }

  /**
   * Replace visualize placeholders with inert card chrome. When the fragment is
   * also present in the synced vault, the card gets a button that opens it;
   * otherwise it just names the file, since a phone cannot reach the desktop's
   * filesystem.
   */
  private hydrateVisualizeSlots(root: HTMLElement, markers: VisualizeMarker[]): void {
    if (markers.length === 0) return;
    const slots = root.querySelectorAll<HTMLAnchorElement>(`a.${VISUALIZE_SLOT_CLASS}[${VISUALIZE_SLOT_ATTR}]`);
    for (const slot of Array.from(slots)) {
      const marker = markers[Number(slot.getAttribute(VISUALIZE_SLOT_ATTR))];
      if (!marker) {
        slot.remove();
        continue;
      }
      const card = this.buildMobileVisualizeCard(marker);
      const parent = slot.parentElement;
      const target = parent && parent.tagName === 'P' && (parent.textContent ?? '').trim() === (slot.textContent ?? '').trim()
        ? parent
        : slot;
      target.replaceWith(card);
    }
  }

  private buildMobileVisualizeCard(marker: VisualizeMarker): HTMLElement {
    const card = document.createElement('div');
    card.className = 'ct-visualize-card ct-visualize-static';

    const header = document.createElement('div');
    header.className = 'ct-visualize-header';
    const icon = document.createElement('span');
    icon.className = 'ct-visualize-icon';
    setIcon(icon, 'bar-chart-3');
    header.appendChild(icon);

    const title = document.createElement('span');
    title.className = 'ct-visualize-title';
    title.textContent = marker.title ?? basename(marker.path);
    title.title = marker.path;
    header.appendChild(title);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'ct-visualize-body ct-visualize-placeholder';
    const vaultPath = this.resolveVaultCopy(marker.path);
    if (vaultPath) {
      const open = document.createElement('button');
      open.className = 'ct-visualize-action ct-visualize-open';
      open.type = 'button';
      open.textContent = 'Open visualization';
      open.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.app.workspace.openLinkText(vaultPath, '', false);
      });
      body.appendChild(open);
    } else {
      body.textContent = 'Visualization renders on desktop';
    }
    card.appendChild(body);
    return card;
  }

  /**
   * Swap out only the streaming element without touching settled messages.
   * Called on every token event so the stable message list is never cleared.
   */
  private async updateStreamingEl(activeId: string | null): Promise<void> {
    // Remove previous streaming element.
    this.streamingEl?.remove();
    this.streamingEl = null;

    if (!activeId || !this.store || !this.store.isStreaming(activeId)) return;

    const content = this.store.getStreamingContent(activeId);
    const tools = this.store.getStreamingTools(activeId);
    const el = this.messagesEl.createDiv('ct-mobile-message ct-mobile-message-assistant ct-mobile-streaming');
    this.streamingEl = el;

    // Show tool pills for any tools fired during this turn
    if (tools.length > 0) {
      this.renderToolCalls(el, tools, true);
    }

    const contentEl = el.createDiv('ct-mobile-message-content');

    if (content) {
      try {
        await this.renderMarkdown(content, contentEl, { streaming: true });
        this.wrapTablesForMobileScroll(contentEl);
      } catch {
        contentEl.createEl('p', { text: content });
      }
    } else {
      // 3.5 — Show thinking spinner when there is no content yet, regardless of
      // whether tools have fired. Early tool calls arrive before the first text
      // token, so we must show the spinner in that case too.
      contentEl.createSpan({ cls: 'ct-thinking-spinner', attr: { 'aria-label': 'Claude is thinking' } });
    }
    contentEl.createSpan({ cls: 'ct-cursor' });

    // Scroll to keep streaming content visible.
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async renderMessage(msg: SerializedMessage): Promise<void> {
    // 3.9 — Compact divider with optional token count
    if (msg.role === 'compact') {
      const divider = this.messagesEl.createDiv('ct-mobile-compact-divider');
      let dividerText = 'Context compacted';
      if (msg.preTokens && msg.preTokens > 0) {
        const kTokens = msg.preTokens >= 1000
          ? `${Math.round(msg.preTokens / 1000)}k`
          : String(msg.preTokens);
        dividerText += ` · ${kTokens} tokens`;
      }
      divider.textContent = dividerText;
      return;
    }

    const el = this.messagesEl.createDiv(`ct-mobile-message ct-mobile-message-${msg.role}`);

    // Render tool-call pills above the message content (assistant only)
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      this.renderToolCalls(el, msg.toolCalls, false);
    }

    const content = el.createDiv('ct-mobile-message-content');

    if (msg.role === 'assistant') {
      try {
        await this.renderMarkdown(msg.content, content);
        this.wrapTablesForMobileScroll(content);
      } catch {
        content.createEl('p', { text: msg.content });
      }

      // 3.1 — Copy button for assistant messages. Only render it when there is
      // actual text to copy — tool-only turns (e.g. TaskCreate, ToolSearch with
      // no accompanying prose) leave msg.content empty, and an always-visible
      // mobile button with nothing above it renders as a stray icon-only row
      // between the tool-call pill and the message footer/timestamp.
      if (msg.content && msg.content.trim().length > 0) {
        const copyBtn = el.createEl('button', { cls: 'ct-mobile-copy-btn', attr: { title: 'Copy response' } });
        copyBtn.textContent = '⎘';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(msg.content);
          copyBtn.textContent = '✓';
          setTimeout(() => { copyBtn.textContent = '⎘'; }, 1500);
        });
      }
    } else {
      // Render any attached images above the text
      if (msg.images && msg.images.length > 0) {
        const imgGrid = content.createDiv('ct-mobile-msg-images');
        for (const img of msg.images) {
          const imgEl = imgGrid.createEl('img', { cls: 'ct-mobile-msg-img' });
          imgEl.src = `data:${img.mediaType};base64,${img.base64}`;
          imgEl.alt = img.name || 'image';
        }
      }
      if (msg.content) {
        content.createEl('p', { text: msg.content });
      }
    }

    // 3.6 — Message footer: cost + timestamp
    const hasCost = !!msg.cost && msg.cost > 0;
    if (msg.role === 'user' || msg.role === 'assistant') {
      const footer = el.createDiv('ct-mobile-message-footer');
      if (hasCost) {
        footer.createSpan({ cls: 'ct-mobile-cost', text: `$${msg.cost!.toFixed(4)}` });
      }
      if (msg.timestamp) {
        footer.createSpan({ cls: 'ct-mobile-message-time', text: this.formatShortTime(msg.timestamp) });
      }
    }
  }


  /**
   * Wraps every <table> inside `container` in a <div class="ct-mobile-table-scroll">
   * so that wide tables scroll horizontally in isolation, leaving paragraph text
   * completely unaffected. Must be called after the parsed HTML has been appended
   * to the DOM — the wrapper div is the element that owns overflow-x:auto, which
   * requires that its parent (.ct-mobile-message-content) does NOT have
   * overflow:hidden (that would clip the scroll region).
   */
  private wrapTablesForMobileScroll(container: HTMLElement): void {
    const tables = Array.from(container.querySelectorAll('table'));
    for (const table of tables) {
      // Guard against double-wrapping if called more than once on the same element.
      if (table.parentElement?.classList.contains('ct-mobile-table-scroll')) continue;
      const wrapper = document.createElement('div');
      wrapper.className = 'ct-mobile-table-scroll';
      table.parentNode?.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    }
  }

  /**
   * Renders tool-call pills using the same ct-tool-pill classes as the desktop
   * view, collapsing runs of 2+ consecutive same-activity-kind calls into a
   * `.ct-tool-group` exactly like ThreadsView.renderToolCalls (same
   * groupToolCalls() chunking, same markup/classes) so the same styles.css
   * rules apply unchanged and long agentic runs don't grow an unbounded flat
   * pill list here either. Called for both the live streaming view
   * (updateStreamingEl, active=true) and the finalized per-message view
   * (renderMessage, active=false).
   */
  private renderToolCalls(parent: HTMLElement, tools: ToolCallRecord[], active: boolean): void {
    const wrapper = parent.createDiv('ct-tools');
    let index = 0;
    // Smoothing only (see toolNameUtils.smoothToolGroups) — the two-tier
    // outer wrap and live-current-tool header from the desktop view are
    // deliberately NOT ported here: mobile ToolCallRecords carry no
    // status/toolUseId (see the renderToolGroup doc comment below), so there's
    // no pending state to key a live header off, and this view's positional
    // `${startIndex}:${activityKind}` expand-key isn't a stable enough
    // identity for the outer-wrap's live-identity requirement.
    for (const entry of smoothToolGroups(groupToolCalls(tools))) {
      if (entry.kind === 'single') {
        this.renderToolPill(wrapper, entry.tool, active);
        index += 1;
      } else {
        this.renderToolGroup(wrapper, entry, active, index);
        index += entry.tools.length;
      }
    }
  }

  /** Renders a single tool call as a `.ct-tool-pill`. Shared by the flat path and renderToolGroup's body. */
  private renderToolPill(wrapper: HTMLElement, tool: ToolCallRecord, active: boolean): void {
    const pill = wrapper.createDiv(active ? 'ct-tool-pill ct-tool-active' : 'ct-tool-pill');
    // 3.8 — Tool pill icons (matches desktop renderToolCalls pattern)
    const iconEl = pill.createSpan({ cls: 'ct-tool-pill-icon' });
    setIcon(iconEl, getToolIcon(tool.name));
    pill.createSpan({ cls: 'ct-tool-pill-name', text: formatToolName(tool.name) });
    if (tool.summary) pill.createSpan({ cls: 'ct-tool-pill-text', text: tool.summary });
  }

  /**
   * Renders a run of 2+ consecutive same-activity tool calls as a collapsible
   * section, mirroring ThreadsView.renderToolGroup's markup/classes exactly so
   * styles.css rules apply unchanged. Mobile ToolCallRecords carry no
   * toolUseId/status (see MobileThreadStore.streamingTools) — there's no
   * per-tool success/error/pending state to reflect on mobile today, live or
   * finalized, so unlike the desktop version this has no error-triggered
   * auto-expand and no "still running" pulse; that's a pre-existing fidelity
   * gap on mobile, not a regression introduced here.
   */
  private renderToolGroup(
    wrapper: HTMLElement,
    entry: Extract<ToolCallGroup, { kind: 'group' }>,
    active: boolean,
    startIndex: number,
  ): void {
    const { activityKind, tools } = entry;
    const groupKey = `${startIndex}:${activityKind}`;

    const groupEl = wrapper.createDiv('ct-tool-group');
    const headerRow = groupEl.createDiv('ct-tool-group-header ct-compressed-row');

    const iconEl = headerRow.createSpan({ cls: 'ct-tool-pill-icon' });
    setIcon(iconEl, getToolIcon(tools[0].name));

    headerRow.createSpan({
      cls: 'ct-compressed-summary',
      text: `${ACTIVITY_LABELS[activityKind]} (${tools.length})`,
    });

    const expandBtn = headerRow.createEl('button', { cls: 'ct-expand-btn', attr: { title: 'Expand' } });

    const fullContent = groupEl.createDiv('ct-full-content');
    for (const tool of tools) {
      this.renderToolPill(fullContent, tool, active);
    }

    let expanded = this.expandedToolGroups.has(groupKey);
    if (!expanded) fullContent.addClass('ct-hidden');
    setIcon(expandBtn, expanded ? 'chevron-up' : 'chevron-down');

    expandBtn.addEventListener('click', () => {
      expanded = !expanded;
      if (expanded) {
        fullContent.removeClass('ct-hidden');
        this.expandedToolGroups.add(groupKey);
      } else {
        fullContent.addClass('ct-hidden');
        this.expandedToolGroups.delete(groupKey);
      }
      setIcon(expandBtn, expanded ? 'chevron-up' : 'chevron-down');
    });
  }

  /**
   * Renders the mobile question card shown when Claude calls AskUserQuestion.
   * Mirrors renderPermissionCard's structure and ThreadsView's renderQuestionCard
   * DOM/answer-building logic — every question gets fixed options (radio for
   * single-select, checkbox for multiSelect) plus an always-present "Other"
   * free-text option. Submit builds the answers map and sends resolve_question.
   */
  private renderQuestionCard(pending: PendingQuestion): void {
    const card = this.messagesEl.createDiv('ct-mobile-question-card');

    const header = card.createDiv('ct-mobile-question-header');
    const iconEl = header.createSpan({ cls: 'ct-mobile-question-icon' });
    setIcon(iconEl, getToolIcon('AskUserQuestion'));
    const source = pending.questions.some((question) => question.source === 'codex') ? 'Codex' : 'Claude';
    header.createSpan({ cls: 'ct-mobile-question-label', text: `${source} needs your input` });

    const body = card.createDiv('ct-mobile-question-body');

    const questionInputs: Array<{
      answerKey: string;
      optionInputs: HTMLInputElement[];
      otherInput?: HTMLInputElement;
      otherText?: HTMLInputElement;
    }> = [];

    for (const q of pending.questions) {
      const qEl = body.createDiv({ cls: 'ct-mobile-question' });
      if (q.header) qEl.createEl('h3', { cls: 'ct-mobile-question-title', text: q.header });
      qEl.createEl('p', { cls: 'ct-mobile-question-text', text: q.question });

      const optionsEl = qEl.createDiv({ cls: 'ct-mobile-question-options' });
      const optionInputs: HTMLInputElement[] = [];
      for (const opt of q.options) {
        const row = optionsEl.createDiv({ cls: 'ct-mobile-question-option' });
        const inputEl = row.createEl('input', {
          attr: { type: q.multiSelect ? 'checkbox' : 'radio', name: q.question, value: opt.label },
        }) as HTMLInputElement;
        const labelEl = row.createEl('label', { cls: 'ct-mobile-question-option-label' });
        labelEl.createSpan({ cls: 'ct-mobile-question-opt-name', text: opt.label });
        if (opt.description) {
          labelEl.createSpan({ cls: 'ct-mobile-question-opt-desc', text: opt.description });
        }
        optionInputs.push(inputEl);
      }

      let otherInput: HTMLInputElement | undefined;
      let otherText: HTMLInputElement | undefined;
      if (q.allowOther !== false) {
        const otherRow = optionsEl.createDiv({ cls: 'ct-mobile-question-option ct-mobile-question-option-other' });
        otherInput = otherRow.createEl('input', {
          attr: { type: q.multiSelect ? 'checkbox' : 'radio', name: q.question, value: '__other__' },
        }) as HTMLInputElement;
        const otherLabelEl = otherRow.createEl('label', { cls: 'ct-mobile-question-option-label' });
        otherLabelEl.createSpan({ cls: 'ct-mobile-question-opt-name', text: q.options.length > 0 ? 'Other' : 'Answer' });
        otherText = otherLabelEl.createEl('input', {
          cls: 'ct-mobile-question-other-text',
          attr: {
            type: q.isSecret ? 'password' : 'text',
            placeholder: q.isSecret ? 'Enter secret…' : 'Type your own answer…',
            autocomplete: q.isSecret ? 'off' : 'on',
          },
        }) as HTMLInputElement;
        otherText.addEventListener('input', () => {
          if (otherInput && !otherInput.checked) otherInput.checked = true;
        });
        otherText.addEventListener('click', (e) => e.stopPropagation());
      }

      questionInputs.push({ answerKey: q.id ?? q.question, optionInputs, otherInput, otherText });
    }

    const actions = card.createDiv('ct-mobile-question-actions');
    const submitBtn = actions.createEl('button', {
      cls: 'ct-mobile-question-submit',
      text: 'Submit',
    });
    submitBtn.addEventListener('click', () => {
      const answers: Record<string, string> = {};
      for (const { answerKey, optionInputs, otherInput, otherText } of questionInputs) {
        const values: string[] = [];
        for (const input of optionInputs) {
          if (input.checked) values.push(input.value);
        }
        if (otherInput?.checked) {
          const text = otherText?.value.trim();
          if (text) values.push(text);
        }
        answers[answerKey] = values.join(',');
      }
      this.relayClient!.sendCommand({
        type: 'resolve_question',
        threadId: pending.threadId,
        requestId: pending.requestId,
        answers,
      });
    });
  }

  private renderPermissionCard(permission: PendingPermission): void {
    const card = this.messagesEl.createDiv('ct-mobile-permission-card');

    card.createDiv({ cls: 'ct-mobile-permission-label', text: 'Permission request' });

    const body = card.createDiv('ct-mobile-permission-body');
    body.createEl('code', { cls: 'ct-mobile-permission-tool', text: formatToolName(permission.toolName) });
    if (permission.detail) {
      body.createEl('p', { cls: 'ct-mobile-permission-detail', text: permission.detail });
    }

    const actions = card.createDiv('ct-mobile-permission-actions');

    const denyBtn = actions.createEl('button', {
      cls: 'ct-mobile-permission-btn ct-mobile-permission-deny',
      text: 'Deny',
    });
    denyBtn.addEventListener('click', () => {
      this.relayClient!.sendCommand({
        type: 'resolve_permission',
        threadId: permission.threadId,
        requestId: permission.requestId,
        allow: false,
      });
    });

    const allowBtn = actions.createEl('button', {
      cls: 'ct-mobile-permission-btn ct-mobile-permission-allow',
      text: 'Allow',
    });
    allowBtn.addEventListener('click', () => {
      this.relayClient!.sendCommand({
        type: 'resolve_permission',
        threadId: permission.threadId,
        requestId: permission.requestId,
        allow: true,
      });
    });

    // 3.11 — Always Allow button
    const alwaysBtn = actions.createEl('button', {
      cls: 'ct-mobile-permission-btn ct-mobile-permission-always',
      text: 'Always Allow',
    });
    alwaysBtn.addEventListener('click', () => {
      this.relayClient!.sendCommand({
        type: 'resolve_permission',
        threadId: permission.threadId,
        requestId: permission.requestId,
        allow: true,
        alwaysAllow: true,
      });
    });
  }

  private updateConnectionBanner(state: string): void {
    if (state === 'connected') {
      this.disconnectedBannerEl?.remove();
      this.disconnectedBannerEl = null;
    } else if (!this.disconnectedBannerEl) {
      const banner = this.rootEl.createDiv('ct-mobile-disconnected-banner');
      banner.createSpan({ text: 'Desktop disconnected — reconnecting...' });
      this.disconnectedBannerEl = banner;
      // Insert at the top
      this.rootEl.insertBefore(banner, this.rootEl.firstChild);
    }
  }

  // ── Viewport / keyboard handling ──────────────────────────────────────

  /**
   * Keyboard handling in Obsidian's iOS WKWebView.
   *
   * Neither window.innerHeight nor window.visualViewport.height changes when
   * the software keyboard opens — confirmed by measuring both values with the
   * keyboard open vs closed (both 874px on the test device). The keyboard is a
   * pure OS overlay with no web-layer API exposure.
   *
   * Strategy:
   *   • Use input focus / blur as the keyboard proxy.
   *   • On focus: shrink the root to the estimated visible area above the
   *     keyboard (60% of window height minus the parent's top offset), then
   *     scroll messages to the bottom so the input row stays in view.
   *   • On blur: restore CSS-driven sizing.
   *   • Keep a visualViewport resize/scroll listener as a silent fallback in
   *     case a future Obsidian version does expose keyboard height via the vv
   *     API (gap > 50px threshold avoids false-positives).
   *
   * The 60/40 split (visible / keyboard) is calibrated from real device data:
   * on an 874 px logical screen the keyboard + suggestion bar ≈ 350 px (40%).
   * This may be slightly off on very small or very large devices but keeps the
   * input comfortably above the keyboard on all modern iPhones.
   */
  private attachViewportListener(): void {
    const onFocus = () => {
      // Wait for the keyboard animation (~300 ms) before resizing.
      setTimeout(() => {
        // Guard: if the user blurred before the timeout fired, skip the inset.
        // Without this, ct-keyboard-open would be incorrectly applied post-blur.
        if (document.activeElement !== this.inputEl) return;
        this.applyKeyboardInset();
        // Pad the message list so the last message isn't hidden under the input row.
        this.messagesEl.style.paddingBottom = '90px';
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      }, 350);
    };
    const onBlur = () => {
      this.rootEl.style.height = '';
      this.rootEl.style.bottom = '';
      this.messagesEl.style.paddingBottom = '';
      this.rootEl.removeClass('ct-keyboard-open');
    };
    this.vpFocusHandler = onFocus;
    this.vpBlurHandler = onBlur;
    this.inputEl.addEventListener('focus', onFocus);
    this.inputEl.addEventListener('blur', onBlur);

    // Fallback: visualViewport API (no-op in current Obsidian but future-proof).
    const vv = window.visualViewport;
    if (vv) {
      const update = () => {
        const gap = window.innerHeight - vv.offsetTop - vv.height;
        if (gap < 50) return; // viewport unchanged — Obsidian WKWebView case
        const parent = this.rootEl.parentElement;
        if (!parent) return;
        const rect = parent.getBoundingClientRect();
        const newHeight = Math.min(rect.height, Math.max(100, vv.height - Math.max(0, rect.top)));
        this.rootEl.style.height = newHeight + 'px';
        this.rootEl.style.bottom = 'auto';
      };
      this.vpHandler = update;
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
    }
  }

  // Device-class keyboard inset fractions (portrait, measured on real devices)
  // SE3 (logical 667px): keyboard+bar ≈ 45% of viewport
  // iPhone 12-16 (logical 844–932px): keyboard+bar ≈ 40%
  // iPad mini/Air/Pro (logical 1024px+): keyboard+bar ≈ 36%
  private getKeyboardFraction(): number {
    const h = window.screen.height;
    if (h <= 700) return 0.45;
    if (h <= 950) return 0.40;
    return 0.36;
  }

  private applyKeyboardInset(): void {
    // If the vv fallback already handled it, skip.
    const vv = window.visualViewport;
    if (vv && window.innerHeight - vv.offsetTop - vv.height > 50) return;

    const parent = this.rootEl.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();

    // Available height above the keyboard = (1 - keyboardFraction) * innerHeight.
    const keyboardTop = Math.round(window.innerHeight * (1 - this.getKeyboardFraction()));
    const newHeight = Math.max(100, Math.min(parentRect.height, keyboardTop - Math.max(0, parentRect.top)));
    this.rootEl.style.height = newHeight + 'px';
    this.rootEl.style.bottom = 'auto';

    // Scroll so the input row is visible at the bottom of the shrunk root.
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

    // Signal to CSS that the keyboard is open.
    this.rootEl.addClass('ct-keyboard-open');
  }

  private detachViewportListener(): void {
    if (this.vpFocusHandler) {
      this.inputEl.removeEventListener('focus', this.vpFocusHandler);
      this.vpFocusHandler = null;
    }
    if (this.vpBlurHandler) {
      this.inputEl.removeEventListener('blur', this.vpBlurHandler);
      this.vpBlurHandler = null;
    }
    const vv = window.visualViewport;
    if (vv && this.vpHandler) {
      vv.removeEventListener('resize', this.vpHandler);
      vv.removeEventListener('scroll', this.vpHandler);
      this.vpHandler = null;
    }
    this.rootEl.style.height = '';
    this.rootEl.style.bottom = '';
  }

  // ── Summary peek banner ───────────────────────────────────────────────

  private maybeShowSummaryBanner(
    thread: SerializedThread,
    previousId: string | null,
    priorAccessTime: number | undefined,
  ): void {
    this.hideSummaryBanner(true); // clear any stale banner immediately

    // Only fire when genuinely switching between two different threads
    if (!previousId || previousId === thread.id) return;

    const summary = thread.summary || thread.recap;
    if (!summary) return;

    // Skip if the user was just here — only show when returning after a real break
    const elapsed = priorAccessTime !== undefined ? Date.now() - priorAccessTime : Infinity;
    if (elapsed < MobileView.BANNER_IDLE_THRESHOLD_MS) return;

    this.showSummaryBanner(thread, summary);
  }

  private showSummaryBanner(thread: SerializedThread, summary: string): void {
    const banner = this.conversationEl.createDiv('ct-summary-banner');
    this.summaryBannerEl = banner;

    const header = banner.createDiv('ct-summary-banner-header');
    header.createSpan({ cls: 'ct-summary-banner-label', text: '↺ Context' });
    header.createSpan({
      cls: 'ct-summary-banner-time',
      text: `Last active ${relativeTimeAgo(thread.updatedAt)}`,
    });

    const closeBtn = header.createEl('button', {
      cls: 'ct-summary-banner-close',
      text: '×',
      attr: { title: 'Dismiss' },
    });
    closeBtn.addEventListener('click', () => this.hideSummaryBanner(false));

    banner.createEl('p', { cls: 'ct-summary-banner-text', text: summary });

    this.summaryBannerTimer = setTimeout(
      () => this.hideSummaryBanner(false),
      MobileView.BANNER_AUTO_DISMISS_MS,
    );

    // Dismiss when the user taps anywhere outside the banner.
    const outsideTap = (e: PointerEvent) => {
      if (!banner.contains(e.target as Node)) {
        this.hideSummaryBanner(false);
      }
    };
    this.conversationEl.addEventListener('pointerdown', outsideTap);
    this._summaryBannerOutsideTap = outsideTap;
  }

  private hideSummaryBanner(immediate: boolean): void {
    if (this.summaryBannerTimer !== null) {
      clearTimeout(this.summaryBannerTimer);
      this.summaryBannerTimer = null;
    }
    if (this._summaryBannerOutsideTap) {
      this.conversationEl.removeEventListener('pointerdown', this._summaryBannerOutsideTap);
      this._summaryBannerOutsideTap = undefined;
    }
    if (!this.summaryBannerEl) return;
    const el = this.summaryBannerEl;
    this.summaryBannerEl = null;

    if (immediate) {
      el.remove();
      return;
    }

    // Animate out then remove
    el.addClass('ct-summary-banner-out');
    setTimeout(() => el.remove(), 300);
  }

  // ── Panel switching ───────────────────────────────────────────────────

  /** Directly show/hide panels without relying on CSS class cascades. */
  private showPanel(panel: 'list' | 'conversation'): void {
    if (panel === 'conversation') {
      this.listPanelEl.style.display = 'none';
      this.convPanelEl.style.display = 'flex';
    } else {
      this.convPanelEl.style.display = 'none';
      this.listPanelEl.style.display = 'flex';
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────

  private handleSend(): void {
    const text = this.inputEl.value.trim();
    if ((!text && this.pendingImages.length === 0) || !this.store || !this.relayClient) return;

    const activeId = this.store.getActiveThreadId();
    if (!activeId) return;

    const cmd: { type: 'send_message'; threadId: string; text: string; images?: ImageAttachment[] } = {
      type: 'send_message',
      threadId: activeId,
      text,
    };
    if (this.pendingImages.length > 0) {
      cmd.images = [...this.pendingImages];
    }
    this.relayClient.sendCommand(cmd);
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
    this.pendingImages = [];
    this.renderImageStrip();
  }

  private handleStop(): void {
    const activeId = this.store?.getActiveThreadId();
    if (!activeId || !this.relayClient) return;
    this.relayClient.sendCommand({ type: 'stop_session', threadId: activeId });
  }

  private updateQueueBanner(activeId: string | null): void {
    // 3.12 — Replace flat banner with stacked rows
    if (!this.queueRowsEl) return;
    this.queueRowsEl.empty();

    if (!activeId || !this.store) {
      this.queueRowsEl.style.display = 'none';
      return;
    }
    const queued = this.store.getQueuedMessages(activeId);
    if (queued.length === 0) {
      this.queueRowsEl.style.display = 'none';
      return;
    }

    this.queueRowsEl.style.display = '';
    const MAX_VISIBLE = 3;
    const visible = queued.slice(0, MAX_VISIBLE);

    visible.forEach((text, i) => {
      const row = this.queueRowsEl!.createDiv('ct-mobile-queue-row');
      const preview = text.length > 40 ? text.slice(0, 40) + '…' : text;
      const previewEl = row.createSpan({ cls: 'ct-mobile-queue-preview', text: preview || '(empty)' });

      const cancelBtn = row.createEl('button', {
        cls: 'ct-mobile-queue-cancel',
        text: '×',
        attr: { title: 'Cancel queued message' },
      });
      cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.relayClient?.sendCommand({ type: 'cancel_queued_message', threadId: activeId, index: i });
      });

      // Tap row → pull into composer
      const doPull = () => {
        const current = this.inputEl.value.trim();
        if (!current) {
          this.inputEl.value = text;
          this.relayClient?.sendCommand({ type: 'cancel_queued_message', threadId: activeId, index: i });
          return;
        }
        // Replace draft? inline confirm
        this.queueRowsEl?.querySelector('.ct-mobile-queue-confirm')?.remove();
        const confirm = this.queueRowsEl!.createDiv('ct-mobile-queue-confirm');
        confirm.createSpan({ text: 'Replace draft?' });
        const yes = confirm.createEl('button', { cls: 'ct-mobile-queue-confirm-yes', text: 'Yes' });
        const no  = confirm.createEl('button', { cls: 'ct-mobile-queue-confirm-no', text: 'Cancel' });
        yes.addEventListener('click', () => {
          confirm.remove();
          this.inputEl.value = text;
          this.relayClient?.sendCommand({ type: 'cancel_queued_message', threadId: activeId, index: i });
        });
        no.addEventListener('click', () => confirm.remove());
        row.after(confirm);
      };

      previewEl.addEventListener('click', doPull);
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.ct-mobile-queue-cancel')) return;
        doPull();
      });
    });

    // "+N more" label if queue has more than MAX_VISIBLE
    if (queued.length > MAX_VISIBLE) {
      const extra = queued.length - MAX_VISIBLE;
      const more = this.queueRowsEl.createDiv('ct-mobile-queue-more');
      more.textContent = `+${extra} more`;
    }
  }

  private async handleImageSelect(): Promise<void> {
    const files = Array.from(this.fileInputEl.files ?? []);
    this.fileInputEl.value = '';
    for (const file of files) {
      const attachment = await resizeImage(file);
      this.pendingImages.push(attachment);
    }
    this.renderImageStrip();
  }

  private renderImageStrip(): void {
    this.imageStripEl.empty();
    if (this.pendingImages.length === 0) {
      this.imageStripEl.style.display = 'none';
      return;
    }
    this.imageStripEl.style.display = 'flex';
    for (let i = 0; i < this.pendingImages.length; i++) {
      const img = this.pendingImages[i];
      const thumb = this.imageStripEl.createDiv('ct-mobile-image-thumb');
      const imgEl = thumb.createEl('img');
      imgEl.src = `data:${img.mediaType};base64,${img.base64}`;
      const removeBtn = thumb.createEl('button', { cls: 'ct-mobile-image-remove', text: '×' });
      const idx = i;
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.pendingImages.splice(idx, 1);
        this.renderImageStrip();
      });
    }
  }

  // ── 3.2 — Status rail helpers ──────────────────────────────────────────

  private showMobileStatusCard(type: 'active' | 'warning' | 'error', text: string): void {
    this.statusRailCardEl?.remove();
    const card = this.statusRailEl.createDiv(
      type === 'active'   ? 'ct-status-card ct-status-card-active'
      : type === 'warning' ? 'ct-status-card ct-status-card-warning'
      :                       'ct-status-card ct-status-card-error',
    );
    if (type === 'active') {
      card.createSpan({ cls: 'ct-status-card-spinner' });
    }
    card.createSpan({ cls: 'ct-status-card-text', text });
    this.statusRailCardEl = card;
  }

  private hideMobileStatusCard(): void {
    this.statusRailCardEl?.remove();
    this.statusRailCardEl = null;
  }

  private updateStatusRail(activeId: string | null): void {
    if (!activeId || !this.store) {
      this.hideMobileStatusCard();
      return;
    }
    const status = this.store.getThreadStatus(activeId);
    if (status === 'compacting') {
      this.showMobileStatusCard('active', 'Compacting…');
    } else if (status === 'requesting') {
      this.showMobileStatusCard('active', 'Requesting…');
    } else {
      this.hideMobileStatusCard();
    }
  }

  // ── 3.4 — Model indicator helper ───────────────────────────────────────

  private updateModelIndicator(thread: SerializedThread | null): void {
    if (!thread?.model) {
      this.convModelEl.style.display = 'none';
      this.convModelEl.textContent = '';
      return;
    }
    // Show the model name; strip the leading "claude-" vendor prefix for brevity
    const displayModel = thread.model.replace(/^claude-/, '');
    this.convModelEl.textContent = displayModel;
    this.convModelEl.style.display = '';
  }

  // ── 3.7 — cwd chip helper ──────────────────────────────────────────────

  private shortenCwd(cwd: string): string {
    if (!cwd) return '';
    // Replace home dir with ~
    const home = (typeof process !== 'undefined' && process.env?.HOME) || '/Users';
    let path = cwd.replace(home, '~');
    // Show only last 2 segments if longer than ~40 chars
    if (path.length > 40) {
      const parts = path.replace(/\/$/, '').split('/');
      path = '…/' + parts.slice(-2).join('/');
    }
    return path;
  }

  private updateCwdChip(thread: SerializedThread | null): void {
    if (!thread?.cwd) {
      this.convCwdEl.style.display = 'none';
      this.convCwdEl.textContent = '';
      return;
    }
    this.convCwdEl.textContent = this.shortenCwd(thread.cwd);
    this.convCwdEl.style.display = '';
  }

  // ── 3.6 — Short time formatter ─────────────────────────────────────────

  private formatShortTime(timestamp: number): string {
    const d = new Date(timestamp);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return time;
    const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${date}, ${time}`;
  }

  // ── 3.10 — Error card renderer ─────────────────────────────────────────

  private renderErrorCard(threadId: string, errorText: string): void {
    const card = this.messagesEl.createDiv('ct-mobile-error-card');
    const { headline, stack } = splitErrorMessage(errorText);
    // Wrap headline + collapsed stack together so they stack vertically as a
    // single flex item, instead of sitting side-by-side with the dismiss
    // button in the card's flex-row layout.
    const bodyEl = card.createDiv('ct-mobile-error-body');
    bodyEl.createDiv({ cls: 'ct-mobile-error-text', text: headline });
    if (stack) {
      const detailsEl = bodyEl.createEl('details', { cls: 'ct-mobile-error-details' });
      detailsEl.createEl('summary', { text: 'Show technical details' });
      detailsEl.createEl('pre', { cls: 'ct-mobile-error-stack', text: stack });
    }
    const dismissBtn = card.createEl('button', {
      cls: 'ct-mobile-error-dismiss',
      text: '×',
      attr: { title: 'Dismiss', 'aria-label': 'Dismiss error' },
    });
    dismissBtn.addEventListener('click', () => {
      this._errorDismissed.add(threadId);
      card.remove();
    });
  }

  private scrollToBottom(): void {
    // Disconnect any previous observer before creating a new one.
    this.scrollObserver?.disconnect();
    this.scrollObserver = null;

    const doScroll = () => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    };

    // First pass: after layout is computed.
    requestAnimationFrame(() => {
      doScroll();

      // Second pass: watch for async DOM mutations (MarkdownRenderer populating
      // assistant message content) and re-scroll each time something changes.
      // Disconnect automatically after 2 s so we don't observe forever.
      const observer = new MutationObserver(() => {
        doScroll();
      });
      observer.observe(this.messagesEl, { childList: true, subtree: true, characterData: true });
      this.scrollObserver = observer;

      setTimeout(() => {
        observer.disconnect();
        if (this.scrollObserver === observer) this.scrollObserver = null;
        doScroll(); // Final scroll after everything has settled.
      }, 2000);
    });
  }
}

/** Format a timestamp as a short relative string: "just now", "5m", "2h", "3d". */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

/** Format a timestamp as a human-readable "time ago" string for the summary banner. */
function relativeTimeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

/** Resize an image file to max 1024px on longest side, returning a base64 JPEG. */
async function resizeImage(file: File): Promise<{ base64: string; mediaType: 'image/jpeg'; name: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1024;
      let { width, height } = img;
      if (width > MAX || height > MAX) {
        if (width >= height) { height = Math.round(height * MAX / width); width = MAX; }
        else { width = Math.round(width * MAX / height); height = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      resolve({ base64: dataUrl.split(',')[1], mediaType: 'image/jpeg', name: file.name });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
  });
}

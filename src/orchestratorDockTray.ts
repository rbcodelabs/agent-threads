/**
 * orchestratorDockTray.ts
 *
 * The Needs-you tray pinned above the composer inside the reply sheet. One card per thread that is awaiting the
 * user (the list the dot and the board's Needs-you lane use, see dockTrayModel):
 *
 *   - PERMISSION request: the SAME buttons as the board card, built by appendPermissionButtons (one implementation,
 *     one resolution path: manager.resolvePermission). Resolving here or on the board resolves both, because both
 *     read the same manager state; the card leaves on `permission_resolved` (the dock re-renders).
 *   - question / plan: ONE hand-off button that opens the thread. Never answered or approved inline.
 *
 * Nothing here calls resolvePermission except a click handler inside appendPermissionButtons.
 * Thread titles and tool details are model/user-controlled text: only ever set with textContent.
 */
import { setIcon } from 'obsidian';
import type { ThreadManager } from './ThreadManager';
import { isFullyShownDetail } from './permissionDetail';
import { appendPermissionButtons, summarizePermissionDetail, type PendingPermissionInfo, type PermissionButtonDeps } from './permissionCard';
import { formatToolName } from './toolNameUtils';
import { announcementFor, handoffAriaLabel, handoffLabel, TRAY_COLLAPSE_AT, visibleTrayItems, type TrayItem } from './dockTrayModel';

export interface TrayEntry {
  item: TrayItem;
  /** Present only for a permission item that can render buttons; absent = hand off to the thread instead. */
  permission?: PendingPermissionInfo;
}

export interface TrayDeps {
  /**
   * Resolution goes through resolvePermission exactly like the board's cards (also for remote threads: the
   * ...ByRequestId variant is the relay client's path for mobile clients, not a card path). getPendingPermission feeds
   * the stale-click guard.
   */
  manager: Pick<ThreadManager, 'resolvePermission' | 'getRemoteScope' | 'getPendingPermission'>;
  permissionCard?: Omit<PermissionButtonDeps, 'manager' | 'hostExecAllowAlways'> & { hostExecAllowAlways(): boolean };
  openThread(threadId: string): void;
  /** Polite screen-reader text for cards that arrived after the tray was first shown. */
  announce(text: string): void;
  /** A click found its request no longer pending: re-derive the dock so the card shows what is pending now (or leaves). */
  refresh(): void;
  /** Where focus goes when the focused card disappears and no other card is left. */
  focusFallback(): void;
}

interface Card { li: HTMLElement; key: string }

const ICONS: Record<TrayItem['kind'], string> = { permission: 'shield-alert', question: 'message-circle-question', plan: 'clipboard-list' };
const NOTES: Record<TrayItem['kind'], string> = { permission: 'Permission request waiting', question: 'Question ready', plan: 'Plan ready to review' };
let traySeq = 0;

export class DockTray {
  private section: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private toggleEl: HTMLButtonElement | null = null;
  private barEl: HTMLElement | null = null;
  private readonly cards = new Map<string, Card>();
  private readonly listId = `ct-orch-tray-list-${++traySeq}`;
  private expanded = false;
  /** False until the first render after (re)opening: what is already listed is the content, not news. */
  private primed = false;
  private known = new Set<string>();
  private destroyed = false;
  private lastEntries: readonly TrayEntry[] = [];

  constructor(private readonly host: HTMLElement, private readonly deps: TrayDeps) {}

  /** The sheet closed: the next render is a fresh look (silent, collapsed). */
  reset(): void {
    this.primed = false;
    this.known = new Set();
    this.expanded = false;
  }

  destroy(): void {
    this.destroyed = true;
    this.section?.remove();
    this.section = this.titleEl = this.listEl = this.toggleEl = this.barEl = null;
    this.cards.clear();
  }

  render(entries: readonly TrayEntry[]): void {
    if (this.destroyed) return;
    const doc = this.host.ownerDocument;
    const hadFocus = !!this.section && this.section.contains(doc.activeElement);
    const focusedId = hadFocus ? (doc.activeElement as HTMLElement).closest<HTMLElement>('.ct-orch-tray-card')?.dataset.threadId : undefined;
    const oldOrder = [...this.cards.keys()];

    if (entries.length === 0) {
      this.section?.remove();
      this.section = this.titleEl = this.listEl = this.toggleEl = this.barEl = null;
      this.cards.clear();
      this.expanded = false;
      this.announceNew(entries);
      if (hadFocus) this.deps.focusFallback();
      return;
    }
    if (entries.length <= TRAY_COLLAPSE_AT) this.expanded = false;
    this.ensureSection();
    this.titleEl!.textContent = `Needs you (${entries.length})`;

    const { shown, hidden } = visibleTrayItems(entries, this.expanded);
    const wanted = new Set(shown.map((e) => e.item.threadId));
    for (const [id, card] of this.cards) {
      if (wanted.has(id)) continue;
      card.li.remove();
      this.cards.delete(id);
    }
    shown.forEach((entry, i) => {
      const key = cardKey(entry);
      let card = this.cards.get(entry.item.threadId);
      if (!card || card.key !== key) {
        card?.li.remove();
        card = { li: this.buildCard(entry), key };
        this.cards.set(entry.item.threadId, card);
      }
      const at = this.listEl!.children[i] ?? null;
      if (at !== card.li) this.listEl!.insertBefore(card.li, at);
    });
    this.renderToggle(entries.length, hidden);
    this.announceNew(entries);

    // The focused control was in a card that is gone (resolved) or was rebuilt: never strand focus on <body>.
    if (hadFocus && !this.section!.contains(doc.activeElement)) this.rescueFocus(focusedId, oldOrder, shown.map((e) => e.item.threadId));
  }

  private ensureSection(): void {
    if (this.section) return;
    const section = this.host.createEl('section', {
      cls: 'ct-orch-tray',
      attr: { role: 'region', 'aria-label': 'Needs you', 'data-testid': 'orchestrator-tray' },
    });
    // One sticky unit: the heading and the Show more / fewer control stay at the top of the tray's own scroller.
    this.barEl = section.createDiv('ct-orch-tray-bar');
    this.titleEl = this.barEl.createEl('h3', { cls: 'ct-orch-tray-title' });
    this.listEl = section.createEl('ul', { cls: 'ct-orch-tray-list', attr: { id: this.listId } });
    this.section = section;
  }

  private renderToggle(total: number, hidden: number): void {
    const needed = total > TRAY_COLLAPSE_AT;
    if (!needed) { this.toggleEl?.remove(); this.toggleEl = null; return; }
    if (!this.toggleEl) {
      const btn = this.barEl!.createEl('button', { cls: 'ct-orch-tray-toggle', attr: { type: 'button', 'aria-controls': this.listId } });
      btn.addEventListener('click', () => {
        this.expanded = !this.expanded;
        this.rerender();
      });
      this.toggleEl = btn;
    }
    this.toggleEl.textContent = this.expanded ? 'Show fewer' : `Show ${hidden} more`;
    this.toggleEl.setAttribute('aria-expanded', String(this.expanded));
  }

  /** The toggle changes what is shown, not the data: replay the last entries. */
  private rerender(): void { this.render(this.lastEntries); }

  private announceNew(entries: readonly TrayEntry[]): void {
    this.lastEntries = entries;
    const idOf = (e: TrayEntry): string => `${e.item.threadId}|${e.item.kind}|${e.permission?.promptId ?? ''}`;
    const now = new Set(entries.map(idOf));
    if (this.primed) {
      // A new PROMPT on a thread that already had a card (queued permissions) is news; an unchanged card is not.
      const fresh = entries.filter((e) => !this.known.has(idOf(e)));
      if (fresh.length > 0) this.deps.announce(joinAnnouncements(fresh.map((e) => announcementFor(e.item))));
    }
    this.known = now;
    this.primed = true;
  }

  private rescueFocus(focusedId: string | undefined, oldOrder: string[], newOrder: string[]): void {
    const idx = focusedId ? oldOrder.indexOf(focusedId) : -1;
    const nextId = (focusedId && newOrder.includes(focusedId)) ? focusedId : newOrder[Math.min(Math.max(idx, 0), newOrder.length - 1)];
    const target = nextId ? this.cards.get(nextId)?.li.querySelector<HTMLElement>('button') : null;
    if (target) target.focus();
    else if (this.toggleEl) this.toggleEl.focus();
    else this.deps.focusFallback();
  }

  private buildCard(entry: TrayEntry): HTMLElement {
    const { item, permission } = entry;
    const li = this.listEl!.createEl('li', { cls: 'ct-orch-tray-card', attr: { 'data-thread-id': item.threadId, 'data-kind': item.kind } });
    const main = li.createDiv('ct-orch-tray-main');
    const head = main.createDiv('ct-orch-tray-head');
    const icon = head.createSpan({ cls: 'ct-orch-tray-icon', attr: { 'aria-hidden': 'true' } });
    setIcon(icon, ICONS[item.kind]);
    head.createSpan({ cls: 'ct-orch-tray-name', text: item.title, attr: { title: item.title } });

    const card = this.deps.permissionCard;
    if (item.kind === 'permission' && permission && card) {
      const tool = main.createDiv('ct-orch-tray-tool');
      tool.createSpan({ cls: 'ct-agents-permission-tool', text: formatToolName(permission.toolName) });
      const reviewInThread = !isFullyShownDetail(permission.detail);
      if (permission.detail) {
        // The full text is always reachable (title) and wraps to a few lines instead of a one-line ellipsis.
        tool.createSpan({ cls: 'ct-agents-permission-detail ct-orch-tray-detail', text: summarizePermissionDetail(permission.detail), attr: { title: permission.detail } });
      }
      const actions = li.createDiv('ct-orch-tray-actions');
      const threadId = item.threadId;
      let heldFocus: HTMLElement | null = null;
      appendPermissionButtons(actions, threadId, permission, {
        manager: this.deps.manager,
        getSettings: card.getSettings,
        saveSettings: card.saveSettings,
        hostExecAllowAlways: card.hostExecAllowAlways(),
        guard: {
          getPending: () => this.deps.manager.getPendingPermission(threadId),
          onStale: () => this.deps.refresh(),
          setBusy: (busy) => {
            const doc = li.ownerDocument;
            // Disabling the focused button drops keyboard focus: remember it and give it back when re-enabled.
            if (busy && actions.contains(doc.activeElement)) heldFocus = doc.activeElement as HTMLElement;
            li.toggleAttribute('aria-busy', busy);
            for (const b of Array.from(actions.querySelectorAll('button'))) b.disabled = busy;
            if (!busy && heldFocus) { if (heldFocus.isConnected) heldFocus.focus(); heldFocus = null; }
          },
        },
      });
      const toolLabel = formatToolName(permission.toolName);
      if (reviewInThread) {
        // What the user cannot see in full (cut text, OR fields the summary leaves out) is not approved blind: Deny stays, approving happens in the thread.
        actions.querySelectorAll('.ct-permission-allow, .ct-permission-always').forEach((b) => b.remove());
        const review = actions.createEl('button', {
          cls: 'ct-orch-tray-handoff', text: 'Review in thread',
          attr: { type: 'button', 'aria-label': `Review the full ${toolLabel} request for ${item.title} in its thread` },
        });
        review.addEventListener('click', (e) => { e.stopPropagation(); this.deps.openThread(threadId); });
      }
      for (const btn of Array.from(actions.querySelectorAll('button.ct-permission-btn'))) {
        btn.setAttribute('aria-label', `${btn.textContent ?? ''} ${toolLabel} for ${item.title}`);
      }
      return li;
    }
    main.createDiv({ cls: 'ct-orch-tray-note', text: NOTES[item.kind] });
    const actions = li.createDiv('ct-orch-tray-actions');
    const btn = actions.createEl('button', {
      cls: 'ct-orch-tray-handoff',
      text: handoffLabel(item.kind),
      attr: { type: 'button', 'aria-label': handoffAriaLabel(item.kind, item.title) },
    });
    btn.addEventListener('click', (e) => { e.stopPropagation(); this.deps.openThread(item.threadId); });
    return li;
  }
}

/** A new prompt (even with identical tool + detail) rebuilds the card, so a queued request never inherits the previous one's disabled / clicked buttons. */
function cardKey(e: TrayEntry): string {
  return `${e.item.kind}|${e.item.title}|${e.permission ? `${e.permission.toolName}|${e.permission.detail}|${e.permission.promptId ?? ''}` : '-'}`;
}

/** Several arrivals at once: two named, the rest counted (one screen-reader utterance, not a wall of text). */
export function joinAnnouncements(texts: string[]): string {
  if (texts.length <= 2) return texts.join('. ');
  return `${texts.slice(0, 2).join('. ')}, and ${texts.length - 2} more need attention`;
}

import { App, Modal } from 'obsidian';
import {
  bulkArchiveSummary, clearSelection, initialSelection, pruneSelection, selectAll, selectionAfterToggle,
  type ArchiveSuggestion, type BulkArchiveResult, type SuggestionThreadFacts,
} from './archiveSuggestions';

export interface ArchiveSuggestionsDeps {
  /** Current candidates, oldest first. Re-read after every archive run. */
  getCandidates: () => ArchiveSuggestion[];
  projectLabel: (thread: SuggestionThreadFacts) => string;
  /** Confirms, re-checks eligibility and archives. Never archives without the confirm. */
  archiveSelected: (ids: string[]) => Promise<BulkArchiveResult>;
  /** Called once when the drawer closes, so the board can restore focus to its entry button. */
  onClosed: () => void;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * In-board drawer listing archive suggestions with checkboxes. Nothing is
 * preselected; archiving is an explicit button that opens a confirm first.
 */
export class ArchiveSuggestionsModal extends Modal {
  private selected = initialSelection();
  private listEl!: HTMLElement;
  private archiveBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private busy = false;
  private closedNotified = false;
  private docKeydown = (e: KeyboardEvent) => this.trapTab(e);

  constructor(app: App, private deps: ArchiveSuggestionsDeps) {
    super(app);
  }

  onOpen(): void {
    const root = this.contentEl;
    root.addClass('ct-archive-suggestions');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Archive suggestions');
    root.createEl('h2', { text: 'Archive suggestions', cls: 'ct-archive-suggestions-title' });
    root.createEl('p', {
      cls: 'ct-archive-suggestions-sub',
      text: 'Concluded threads unchanged for 3+ days. Nothing is archived until you check threads and confirm.',
    });

    const tools = root.createDiv('ct-archive-suggestions-tools');
    const selAll = tools.createEl('button', { text: 'Select all', attr: { type: 'button', 'data-testid': 'archive-select-all' } });
    selAll.addEventListener('click', () => { this.selected = selectAll(this.deps.getCandidates().map((s) => s.thread.id)); this.refresh(); });
    const clear = tools.createEl('button', { text: 'Clear', attr: { type: 'button', 'data-testid': 'archive-clear' } });
    clear.addEventListener('click', () => { this.selected = clearSelection(); this.refresh(); });

    this.listEl = root.createDiv({ cls: 'ct-archive-suggestions-list', attr: { 'data-testid': 'archive-suggestions-list' } });
    this.statusEl = root.createDiv({ cls: 'ct-archive-suggestions-status', attr: { role: 'status', 'aria-live': 'polite', 'data-testid': 'archive-result' } });

    const footer = root.createDiv('ct-archive-suggestions-footer');
    footer.createEl('button', { text: 'Close', attr: { type: 'button', 'data-testid': 'archive-close' } }).addEventListener('click', () => this.close());
    this.archiveBtn = footer.createEl('button', { cls: 'mod-cta', attr: { type: 'button', 'data-testid': 'archive-selected' } });
    this.archiveBtn.addEventListener('click', () => { void this.archive(); });

    root.addEventListener('keydown', (e: KeyboardEvent) => this.onKeydown(e));
    // Focus can fall to <body> (e.g. a confirm dialog dismissed by Escape or an outside click); the drawer's own
    // listener would then never see Tab, so the trap also listens on the document while the drawer is open.
    document.addEventListener('keydown', this.docKeydown, true);
    this.refresh();
    (this.listEl.querySelector<HTMLElement>('input') ?? selAll).focus({ preventScroll: true });
  }

  private onKeydown(e: KeyboardEvent): void {
    if (this.busy) return; // a confirm dialog is on top and owns the keyboard
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key === 'Tab') this.trapTab(e);
  }

  private trapTab(e: KeyboardEvent): void {
    if (e.key !== 'Tab' || this.busy || e.defaultPrevented) return;
    const active = document.activeElement;
    const inside = !!active && this.contentEl.contains(active);
    const lost = !active || active === document.body;
    if (!inside && !lost) return; // focus is in another dialog
    // Keep Tab inside the drawer.
    const items = Array.from(this.contentEl.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (lost) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  private refresh(): void {
    const candidates = this.deps.getCandidates();
    this.selected = pruneSelection(this.selected, candidates.map((s) => s.thread.id));
    this.listEl.empty();
    if (candidates.length === 0) {
      this.listEl.createDiv({ cls: 'ct-archive-suggestions-empty', text: 'No archive suggestions right now.' });
    }
    for (const { thread, reason } of candidates) {
      const label = this.listEl.createEl('label', { cls: 'ct-archive-suggestions-item', attr: { 'data-testid': 'archive-item' } });
      const box = label.createEl('input', { attr: { type: 'checkbox', 'data-thread-id': thread.id } });
      box.checked = this.selected.has(thread.id);
      box.addEventListener('change', () => { this.selected = selectionAfterToggle(this.selected, thread.id); this.updateButton(); });
      const text = label.createDiv('ct-archive-suggestions-text');
      text.createDiv({ cls: 'ct-archive-suggestions-item-title', text: thread.title });
      text.createDiv({ cls: 'ct-archive-suggestions-item-meta', text: `${this.deps.projectLabel(thread)} · ${reason}` });
    }
    this.updateButton();
  }

  private updateButton(): void {
    const n = this.selected.size;
    this.archiveBtn.setText(`Archive ${n} selected`);
    this.archiveBtn.disabled = n === 0 || this.busy;
    this.listEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
      cb.checked = this.selected.has(cb.dataset.threadId ?? '');
    });
  }

  private async archive(): Promise<void> {
    if (this.busy || this.selected.size === 0) return;
    this.busy = true;
    this.updateButton();
    try {
      const result = await this.deps.archiveSelected([...this.selected]);
      if (result.confirmed) {
        this.statusEl.setText(bulkArchiveSummary(result));
        // Failed threads stay selected so a retry is one click.
        this.selected = new Set(result.failed);
      }
    } finally {
      this.busy = false;
      this.refresh();
      // The confirm dialog (however dismissed) and the re-render drop focus; put it back inside the drawer, and
      // once more next frame to win the race with the dialog's own focus restore.
      this.refocus();
      requestAnimationFrame(() => { if (!this.closedNotified) this.refocus(); });
    }
  }

  private refocus(): void {
    (this.listEl.querySelector<HTMLElement>('input') ?? this.contentEl.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
  }

  onClose(): void {
    document.removeEventListener('keydown', this.docKeydown, true);
    this.contentEl.empty();
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.deps.onClosed();
  }
}

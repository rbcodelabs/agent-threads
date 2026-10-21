import { setIcon } from 'obsidian';
import {
  buildPickerEntries,
  initialHighlight,
  moveHighlight,
  type PickerEntry,
  type PickerProject,
  type ProjectSortMode,
} from './projectPickerLogic';

export interface ProjectPickerOptions {
  /** The control the popover is anchored to; focus returns here on close. */
  anchor: HTMLElement;
  /** Live list so projects created while open (or renamed) show up on re-render. */
  getProjects: () => PickerProject[];
  /** Last-used timestamps for the 'recent' sort. */
  getLastUsed: () => ReadonlyMap<string, number>;
  /** Currently selected project id, or null for "No Project". */
  selectedId: string | null;
  sort: ProjectSortMode;
  /** Persist the user's sort choice. */
  onSortChange: (mode: ProjectSortMode) => void;
  /** Called with a project id, or null for "No Project". The popover closes first. */
  onSelect: (projectId: string | null) => void;
  onNewProject: () => void;
  /** Hide the "No Project" row (default: shown). */
  allowNone?: boolean;
  /** Label for the "No Project" row. */
  noneLabel?: string;
  onClose?: () => void;
}

const SORT_LABELS: Record<ProjectSortMode, string> = { recent: 'Recent', alphabetical: 'A–Z' };
const SORT_TITLES: Record<ProjectSortMode, string> = {
  recent: 'Sort by most recently used',
  alphabetical: 'Sort alphabetically',
};

let pickerSequence = 0;

/**
 * Searchable Project chooser: a text filter that is focused on open, a sort
 * toggle (most recently used / alphabetical), and a keyboard-navigable
 * listbox ("No Project", the projects, then "New Project…").
 *
 * Replaces the plain `Menu` project lists, which cannot be filtered and get
 * unwieldy past a handful of projects.
 */
export class ProjectPicker {
  private rootEl: HTMLElement | null = null;
  private inputEl!: HTMLInputElement;
  private listEl!: HTMLElement;
  private sortButtons = new Map<ProjectSortMode, HTMLButtonElement>();
  private entries: PickerEntry[] = [];
  private highlighted = -1;
  private mode: ProjectSortMode;
  private readonly id = `ct-project-picker-${++pickerSequence}`;
  private outsideHandler: ((e: MouseEvent) => void) | null = null;
  private outsideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ProjectPickerOptions) {
    this.mode = options.sort;
  }

  get isOpen(): boolean {
    return this.rootEl !== null;
  }

  open(): void {
    if (this.rootEl) return;
    const root = document.body.createDiv({
      cls: 'ct-project-picker',
      attr: { role: 'dialog', 'aria-label': 'Choose project', id: this.id },
    });
    this.rootEl = root;

    const header = root.createDiv('ct-project-picker-header');
    const searchWrap = header.createDiv('ct-project-picker-search');
    const searchIcon = searchWrap.createSpan('ct-project-picker-search-icon');
    searchIcon.setAttribute('aria-hidden', 'true');
    setIcon(searchIcon, 'search');
    this.inputEl = searchWrap.createEl('input', {
      cls: 'ct-project-picker-input',
      attr: {
        type: 'text',
        placeholder: 'Filter projects…',
        'aria-label': 'Filter projects',
        role: 'combobox',
        'aria-expanded': 'true',
        'aria-controls': `${this.id}-list`,
        'aria-autocomplete': 'list',
        autocomplete: 'off',
        spellcheck: 'false',
      },
    });
    this.inputEl.addEventListener('input', () => this.render(true));
    this.inputEl.addEventListener('keydown', (e) => this.onKeyDown(e));

    const sort = header.createDiv({
      cls: 'ct-project-picker-sort',
      attr: { role: 'group', 'aria-label': 'Sort projects' },
    });
    for (const mode of ['recent', 'alphabetical'] as const) {
      const btn = sort.createEl('button', {
        cls: 'ct-project-picker-sort-btn',
        text: SORT_LABELS[mode],
        attr: { type: 'button', title: SORT_TITLES[mode], 'aria-label': SORT_TITLES[mode] },
      });
      btn.addEventListener('click', () => this.setSort(mode));
      this.sortButtons.set(mode, btn);
    }

    this.listEl = root.createDiv({
      cls: 'ct-project-picker-list',
      attr: { role: 'listbox', id: `${this.id}-list`, 'aria-label': 'Projects' },
    });

    this.position();
    this.render(false);
    this.inputEl.focus();

    // Attach on the next tick so the click that opened the picker does not close it.
    this.outsideTimer = setTimeout(() => {
      this.outsideTimer = null;
      if (!this.rootEl) return;
      this.outsideHandler = (e: MouseEvent) => {
        const target = e.target as Node;
        if (!this.rootEl?.contains(target) && !this.options.anchor.contains(target)) this.close();
      };
      document.addEventListener('mousedown', this.outsideHandler, true);
    }, 0);
  }

  close(restoreFocus = true): void {
    if (!this.rootEl) return;
    if (this.outsideTimer !== null) clearTimeout(this.outsideTimer);
    this.outsideTimer = null;
    if (this.outsideHandler) document.removeEventListener('mousedown', this.outsideHandler, true);
    this.outsideHandler = null;
    this.rootEl.remove();
    this.rootEl = null;
    this.sortButtons.clear();
    if (restoreFocus) this.options.anchor.focus();
    this.options.onClose?.();
  }

  private position(): void {
    const root = this.rootEl;
    if (!root) return;
    const rect = this.options.anchor.getBoundingClientRect();
    const width = Math.max(280, Math.min(360, window.innerWidth - 16));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    root.style.width = `${width}px`;
    root.style.left = `${left}px`;
    // The composer sits at the bottom of the panel, so open upward when the
    // anchor is in the lower half of the window.
    const openUp = rect.top > window.innerHeight / 2;
    if (openUp) {
      root.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
      root.style.top = 'auto';
    } else {
      root.style.top = `${rect.bottom + 6}px`;
      root.style.bottom = 'auto';
    }
    root.toggleClass('ct-project-picker-up', openUp);
  }

  private setSort(mode: ProjectSortMode): void {
    if (mode === this.mode) {
      this.inputEl.focus();
      return;
    }
    this.mode = mode;
    this.options.onSortChange(mode);
    this.render(false);
    this.inputEl.focus();
  }

  private render(queryChanged: boolean): void {
    if (!this.rootEl) return;
    const query = this.inputEl.value;
    this.entries = buildPickerEntries({
      projects: this.options.getProjects(),
      query,
      mode: this.mode,
      lastUsed: this.options.getLastUsed(),
      allowNone: this.options.allowNone,
    });
    if (queryChanged || this.highlighted < 0 || this.highlighted >= this.entries.length) {
      this.highlighted = initialHighlight(this.entries, this.options.selectedId, query);
    }
    for (const [mode, btn] of this.sortButtons) {
      btn.setAttribute('aria-pressed', String(mode === this.mode));
      btn.toggleClass('is-active', mode === this.mode);
    }

    this.listEl.empty();
    const hasProjects = this.entries.some((entry) => entry.kind === 'project');
    this.entries.forEach((entry, index) => {
      if (entry.kind === 'new' && (hasProjects || this.entries.length > 1)) {
        this.listEl.createDiv({ cls: 'ct-project-picker-sep', attr: { role: 'separator' } });
      }
      this.renderRow(entry, index);
    });
    if (!hasProjects && query.trim()) {
      this.listEl.createDiv({
        cls: 'ct-project-picker-empty',
        text: `No projects match "${query.trim()}"`,
        attr: { role: 'status' },
      });
    }
    this.syncHighlight();
  }

  private renderRow(entry: PickerEntry, index: number): void {
    const selected =
      entry.kind === 'none' ? this.options.selectedId === null
        : entry.kind === 'project' ? entry.project.id === this.options.selectedId
          : false;
    const row = this.listEl.createDiv({
      cls: `ct-project-picker-row${entry.kind === 'new' ? ' ct-project-picker-row-new' : ''}`,
      attr: {
        role: 'option',
        id: `${this.id}-opt-${index}`,
        'aria-selected': String(selected),
        'data-kind': entry.kind,
      },
    });
    const icon = row.createSpan('ct-project-picker-row-icon');
    icon.setAttribute('aria-hidden', 'true');
    setIcon(icon, entry.kind === 'none' ? 'folder-minus' : entry.kind === 'new' ? 'folder-plus' : 'folder');
    const label = entry.kind === 'none'
      ? (this.options.noneLabel ?? 'No Project')
      : entry.kind === 'new' ? 'New Project…' : entry.project.name;
    row.createSpan({ cls: 'ct-project-picker-row-name', text: label });
    if (selected) {
      const check = row.createSpan('ct-project-picker-row-check');
      check.setAttribute('aria-hidden', 'true');
      setIcon(check, 'check');
    }
    row.addEventListener('mousemove', () => {
      if (this.highlighted !== index) {
        this.highlighted = index;
        this.syncHighlight();
      }
    });
    row.addEventListener('click', () => this.choose(index));
  }

  private syncHighlight(): void {
    const rows = this.listEl.querySelectorAll<HTMLElement>('[role="option"]');
    rows.forEach((row, index) => row.toggleClass('is-highlighted', index === this.highlighted));
    const active = rows[this.highlighted];
    if (active) {
      this.inputEl.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView?.({ block: 'nearest' });
    } else {
      this.inputEl.removeAttribute('aria-activedescendant');
    }
  }

  private choose(index: number): void {
    const entry = this.entries[index];
    if (!entry) return;
    this.close(entry.kind !== 'new');
    if (entry.kind === 'none') this.options.onSelect(null);
    else if (entry.kind === 'project') this.options.onSelect(entry.project.id);
    else this.options.onNewProject();
  }

  private onKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        this.highlighted = moveHighlight(this.highlighted, e.key === 'ArrowDown' ? 1 : -1, this.entries.length);
        this.syncHighlight();
        break;
      case 'Enter':
        e.preventDefault();
        if (this.highlighted >= 0) this.choose(this.highlighted);
        break;
      case 'Escape':
        // Keep the composer's own Escape handling (stop / dismiss) from also firing.
        e.preventDefault();
        e.stopPropagation();
        this.close();
        break;
      case 'Tab':
        this.close(false);
        break;
    }
  }
}

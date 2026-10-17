/**
 * Custom DOM popovers for the composer: the settings popover opened by the
 * settings indicator, and the project popover opened by the project/cwd chip.
 *
 * They are plain DOM (not an Obsidian `Menu`) so rows can expand in place and
 * the project list can carry a filter input. ThreadsView supplies the content
 * and the handlers; nothing here knows about threads.
 */
import { setIcon } from 'obsidian';
import { filterProjects, sortProjects } from './composerSettings';

export interface PopoverOption {
  label: string;
  checked?: boolean;
  disabled?: boolean;
  /** Runs when chosen. A returned promise keeps nothing open: the popover re-renders once it settles. */
  onSelect: () => void | Promise<void>;
  /** Close the popover instead of re-rendering it (for choices that open a confirm modal). */
  closeOnSelect?: boolean;
}

export interface PopoverOptionGroup {
  title?: string;
  options: PopoverOption[];
  /** Informational line above the options (e.g. a stale-CLI notice). */
  note?: string;
}

export interface PopoverSetting {
  id: string;
  label: string;
  icon: string;
  /** Current value, shown on the collapsed row. */
  value: string;
  groups: PopoverOptionGroup[];
}

export interface PopoverAction {
  id: string;
  label: string;
  icon: string;
  onActivate: () => void;
}

export interface SettingsPopoverModel {
  settings: PopoverSetting[];
  actions: PopoverAction[];
}

interface PopoverOptions {
  /** Positioned ancestor the popover is appended to (must not clip overflow). */
  host: HTMLElement;
  /** The button that opened it: excluded from outside-click and refocused on Escape. */
  anchor: HTMLElement;
  onClose?: () => void;
}

/** Shared open/dismiss plumbing: outside click, Escape, focus return, aria-expanded. */
abstract class PopoverBase {
  protected el: HTMLElement | null = null;
  private outside: ((e: MouseEvent) => void) | null = null;
  private outsideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(protected readonly opts: PopoverOptions) {}

  get isOpen(): boolean { return this.el !== null; }

  protected mount(cls: string, label: string): HTMLElement {
    const el = this.opts.host.createDiv(cls);
    el.setAttribute('aria-label', label);
    el.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.el = el;
    this.opts.anchor.setAttribute('aria-expanded', 'true');
    // Registered next tick so the click that opened the popover does not close it again.
    this.outsideTimer = setTimeout(() => {
      this.outside = (e: MouseEvent) => {
        const target = e.target as Node;
        if (!el.contains(target) && !this.opts.anchor.contains(target)) this.close();
      };
      document.addEventListener('mousedown', this.outside, true);
    }, 0);
    return el;
  }

  close(returnFocus = false): void {
    if (!this.el) return;
    if (this.outsideTimer) clearTimeout(this.outsideTimer);
    if (this.outside) document.removeEventListener('mousedown', this.outside, true);
    this.outside = null;
    this.outsideTimer = null;
    this.el.remove();
    this.el = null;
    this.opts.anchor.setAttribute('aria-expanded', 'false');
    if (returnFocus) this.opts.anchor.focus();
    this.opts.onClose?.();
  }

  protected abstract onKeyDown(e: KeyboardEvent): void;

  /** Focusable controls in DOM order. */
  protected focusables(): HTMLElement[] {
    if (!this.el) return [];
    return [...this.el.querySelectorAll<HTMLElement>('[data-ct-nav]')].filter(n => !n.hasAttribute('disabled'));
  }

  /** Arrow/Home/End roving focus over focusables(); returns true when handled. */
  protected handleRoving(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
      return true;
    }
    if (e.key === 'Tab') { this.close(); return true; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return false;
    const items = this.focusables();
    if (!items.length) return false;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next = i;
    if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % items.length;
    else if (e.key === 'ArrowUp') next = i <= 0 ? items.length - 1 : i - 1;
    else if (e.key === 'Home') next = 0;
    else next = items.length - 1;
    items[next].focus();
    return true;
  }
}

function iconSpan(parent: HTMLElement, icon: string, cls: string): void {
  const span = parent.createSpan(cls);
  span.setAttribute('aria-hidden', 'true');
  setIcon(span, icon);
}

/** One narrow list: expandable settings rows, a divider, then plain actions. */
export class ComposerSettingsPopover extends PopoverBase {
  private expandedId: string | null = null;

  constructor(opts: PopoverOptions, private readonly build: () => SettingsPopoverModel) {
    super(opts);
  }

  open(): void {
    if (this.el) return;
    this.mount('ct-settings-popover', 'Composer settings').setAttribute('role', 'menu');
    this.render();
    this.focusables()[0]?.focus();
  }

  /** Re-reads the model (values changed) while keeping expansion and focus. */
  refresh(): void {
    if (!this.el) return;
    const focusedKey = (document.activeElement as HTMLElement | null)?.dataset?.ctKey;
    this.render();
    if (focusedKey) this.el.querySelector<HTMLElement>(`[data-ct-key="${CSS.escape(focusedKey)}"]`)?.focus();
  }

  private render(): void {
    const root = this.el;
    if (!root) return;
    root.empty();
    const model = this.build();
    for (const setting of model.settings) this.renderSetting(root, setting);
    if (model.actions.length) {
      root.createDiv('ct-sp-divider').setAttribute('role', 'separator');
      for (const action of model.actions) {
        const btn = root.createEl('button', { cls: 'ct-sp-item', attr: { type: 'button', role: 'menuitem', 'data-ct-nav': '', 'data-ct-key': `action:${action.id}` } });
        iconSpan(btn, action.icon, 'ct-sp-icon');
        btn.createSpan({ cls: 'ct-sp-label', text: action.label });
        btn.addEventListener('click', () => { this.close(); action.onActivate(); });
      }
    }
  }

  private renderSetting(root: HTMLElement, setting: PopoverSetting): void {
    const expanded = this.expandedId === setting.id;
    const row = root.createEl('button', {
      cls: 'ct-sp-item ct-sp-row',
      attr: { type: 'button', role: 'menuitem', 'aria-haspopup': 'true', 'aria-expanded': String(expanded), 'data-ct-nav': '', 'data-ct-key': `row:${setting.id}` },
    });
    iconSpan(row, setting.icon, 'ct-sp-icon');
    row.createSpan({ cls: 'ct-sp-label', text: setting.label });
    row.createSpan({ cls: 'ct-sp-value', text: setting.value });
    iconSpan(row, expanded ? 'chevron-up' : 'chevron-down', 'ct-sp-chevron');
    row.addEventListener('click', () => {
      this.expandedId = expanded ? null : setting.id;
      this.refresh();
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' && !expanded) { e.preventDefault(); row.click(); }
      else if (e.key === 'ArrowLeft' && expanded) { e.preventDefault(); row.click(); }
    });
    if (!expanded) return;

    const panel = root.createDiv('ct-sp-options');
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', setting.label);
    let n = 0;
    for (const group of setting.groups) {
      if (group.title) panel.createDiv({ cls: 'ct-sp-group-title', text: group.title });
      if (group.note) panel.createDiv({ cls: 'ct-sp-note', text: group.note });
      for (const option of group.options) {
        const btn = panel.createEl('button', {
          cls: 'ct-sp-item ct-sp-option',
          attr: {
            type: 'button', role: 'menuitemradio', 'aria-checked': String(!!option.checked),
            'data-ct-key': `opt:${setting.id}:${n++}`,
            ...(option.disabled ? { disabled: '' } : { 'data-ct-nav': '' }),
          },
        });
        const check = btn.createSpan('ct-sp-check');
        check.setAttribute('aria-hidden', 'true');
        if (option.checked) setIcon(check, 'check');
        btn.createSpan({ cls: 'ct-sp-label', text: option.label });
        btn.addEventListener('click', () => {
          if (option.closeOnSelect) { this.close(); void option.onSelect(); return; }
          // Collapse back to the row so the new value is visible, then re-render.
          this.expandedId = null;
          void Promise.resolve(option.onSelect()).finally(() => this.refresh());
          this.refresh();
          this.el?.querySelector<HTMLElement>(`[data-ct-key="row:${setting.id}"]`)?.focus();
        });
      }
    }
  }

  protected onKeyDown(e: KeyboardEvent): void {
    this.handleRoving(e);
  }
}

export interface ProjectPopoverModel {
  cwd: string;
  currentProjectId: string | undefined;
  currentProjectName: string | undefined;
  projects: Array<{ id: string; name: string; createdAt: number }>;
  threads: Array<{ projectId?: string; updatedAt: number }>;
  /** False for orchestrator threads: they are pinned to their scope, so the list is read-only. */
  canChange: boolean;
}

export interface ProjectPopoverHandlers {
  onSelect: (projectId: string | null) => void;
  onNewProject: () => void;
  getSortMode: () => 'recent' | 'alpha';
  setSortMode: (mode: 'recent' | 'alpha') => void;
}

/** Project chip popover: filter, Recent / A-Z, No Project, project list, New Project. */
export class ComposerProjectPopover extends PopoverBase {
  private query = '';
  private listEl: HTMLElement | null = null;

  constructor(opts: PopoverOptions, private readonly build: () => ProjectPopoverModel, private readonly handlers: ProjectPopoverHandlers) {
    super(opts);
  }

  open(): void {
    if (this.el) return;
    const root = this.mount('ct-project-popover', 'Project');
    const model = this.build();

    const info = root.createDiv('ct-pp-info');
    info.createDiv({ cls: 'ct-pp-info-label', text: 'Working directory' });
    info.createDiv({ cls: 'ct-pp-cwd', text: model.cwd, attr: { title: model.cwd } });

    if (!model.canChange) {
      root.createDiv({
        cls: 'ct-sp-note ct-pp-pinned',
        text: `${model.currentProjectName ? `Project: ${model.currentProjectName}. ` : ''}Orchestrator threads are pinned to their scope.`,
      });
      return;
    }

    const bar = root.createDiv('ct-pp-bar');
    const input = bar.createEl('input', {
      cls: 'ct-pp-filter',
      // No aria-label: the host renders aria-labels as a tooltip on focus, and this input is
      // autofocused on open, so the tooltip would sit over the first project row. The
      // placeholder is the accessible name.
      attr: { type: 'text', placeholder: 'Filter projects', 'data-ct-nav': '', spellcheck: 'false' },
    });
    input.value = this.query;
    input.addEventListener('input', () => { this.query = input.value; this.renderList(); });

    const sort = bar.createDiv('ct-pp-sort');
    sort.setAttribute('role', 'group');
    sort.setAttribute('aria-label', 'Sort projects');
    for (const [mode, label] of [['recent', 'Recent'], ['alpha', 'A–Z']] as const) {
      const btn = sort.createEl('button', { cls: 'ct-pp-sort-btn', text: label, attr: { type: 'button', 'data-sort': mode, 'data-ct-nav': '' } });
      btn.addEventListener('click', () => { this.handlers.setSortMode(mode); this.syncSort(); this.renderList(); });
    }
    this.syncSort();

    this.listEl = root.createDiv('ct-pp-list');
    this.listEl.setAttribute('role', 'menu');
    this.renderList();
    input.focus();
  }

  private syncSort(): void {
    const mode = this.handlers.getSortMode();
    this.el?.querySelectorAll<HTMLElement>('.ct-pp-sort-btn').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.sort === mode));
    });
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    const model = this.build();
    const addRow = (key: string, icon: string, label: string, checked: boolean, run: () => void) => {
      const btn = list.createEl('button', {
        cls: 'ct-sp-item ct-sp-option',
        attr: { type: 'button', role: 'menuitemradio', 'aria-checked': String(checked), 'data-ct-nav': '', 'data-ct-key': key },
      });
      const check = btn.createSpan('ct-sp-check');
      check.setAttribute('aria-hidden', 'true');
      if (checked) setIcon(check, 'check');
      iconSpan(btn, icon, 'ct-sp-icon');
      btn.createSpan({ cls: 'ct-sp-label', text: label });
      btn.addEventListener('click', () => { this.close(); run(); });
    };

    addRow('project:none', 'folder-minus', 'No Project', !model.currentProjectId, () => this.handlers.onSelect(null));
    const visible = sortProjects(filterProjects(model.projects, this.query), model.threads, this.handlers.getSortMode());
    for (const project of visible) {
      addRow(`project:${project.id}`, 'folder', project.name, project.id === model.currentProjectId, () => this.handlers.onSelect(project.id));
    }
    if (!visible.length && this.query.trim()) {
      list.createDiv({ cls: 'ct-sp-note', text: 'No matching projects' });
    }
    list.createDiv('ct-sp-divider').setAttribute('role', 'separator');
    const create = list.createEl('button', { cls: 'ct-sp-item', attr: { type: 'button', role: 'menuitem', 'data-ct-nav': '', 'data-ct-key': 'project:new' } });
    iconSpan(create, 'folder-plus', 'ct-sp-icon');
    create.createSpan({ cls: 'ct-sp-label', text: 'New Project…' });
    create.addEventListener('click', () => { this.close(); this.handlers.onNewProject(); });
  }

  protected onKeyDown(e: KeyboardEvent): void {
    // Home/End belong to the filter input's caret while it has focus.
    if (document.activeElement instanceof HTMLInputElement && (e.key === 'Home' || e.key === 'End')) return;
    this.handleRoving(e);
  }
}

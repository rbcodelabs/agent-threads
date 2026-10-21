/**
 * @vitest-environment jsdom
 *
 * Behavioural contract of the composer popovers: roles/aria, drill-down levels,
 * keyboard navigation, Escape focus return, outside-click dismissal and the
 * project filter / sort / read-only states.
 */
import '../setup/obsidian-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerProjectPopover, ComposerSettingsPopover, type SettingsPopoverModel } from '../../src/composerPopovers';

// jsdom has no CSS.escape.
if (!(globalThis as any).CSS) (globalThis as any).CSS = { escape: (v: string) => v.replace(/([^\w-])/g, '\\$1') };

let host: HTMLElement;
let anchor: HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.body.appendChild(document.createElement('div'));
  anchor = host.appendChild(document.createElement('button'));
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

function settingsModel(state: { model: string }, onFork = vi.fn()): () => SettingsPopoverModel {
  return () => ({
    settings: [{
      id: 'model', label: 'Model', icon: 'cpu', value: state.model,
      groups: [{ options: ['Default', 'Opus'].map(label => ({ label, checked: state.model === label, onSelect: () => { state.model = label; } })) }],
    }, {
      id: 'permissions', label: 'Permissions', icon: 'shield', value: 'Global default', groups: [{ options: [{ label: 'Plan', onSelect: () => {} }] }],
    }],
    actions: [{ id: 'fork', label: 'Fork conversation', icon: 'git-branch', onActivate: onFork }],
  });
}

describe('ComposerSettingsPopover', () => {
  it('opens a menu with rows showing current values, a divider and actions', () => {
    const p = new ComposerSettingsPopover({ host, anchor }, settingsModel({ model: 'Default' }));
    p.open();
    const root = host.querySelector('.ct-settings-popover')!;
    expect(root.getAttribute('role')).toBe('menu');
    expect(root.querySelectorAll('[role="menuitem"]').length).toBe(3);
    expect(root.querySelector('.ct-sp-row .ct-sp-value')!.textContent).toBe('Default');
    expect(root.querySelector('[role="separator"]')).not.toBeNull();
    expect(anchor.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(root.querySelector('.ct-sp-row'));
  });

  it('drills into a row (replacing the content), applies a choice, returns to the root and shows the new value', () => {
    const state = { model: 'Default' };
    const p = new ComposerSettingsPopover({ host, anchor }, settingsModel(state));
    p.open();
    host.querySelector<HTMLButtonElement>('[data-ct-key="row:model"]')!.click();
    // Level view: back header + options only; the other rows and actions are gone.
    expect(host.querySelector('.ct-sp-row')).toBeNull();
    expect(host.querySelector('[data-ct-key="action:fork"]')).toBeNull();
    expect(host.querySelector('.ct-sp-back .ct-sp-label')!.textContent).toBe('Model');
    const options = host.querySelectorAll('[role="menuitemradio"]');
    expect([...options].map(o => o.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(document.activeElement).toBe(host.querySelector('.ct-sp-back'));
    (options[1] as HTMLButtonElement).click();
    expect(state.model).toBe('Opus');
    expect(host.querySelector('.ct-sp-back')).toBeNull();
    expect(host.querySelector('[data-ct-key="row:model"] .ct-sp-value')!.textContent).toBe('Opus');
    expect(document.activeElement).toBe(host.querySelector('[data-ct-key="row:model"]'));
    expect(host.querySelector('.ct-settings-popover')).not.toBeNull();
  });

  it('root rows carry icon, label, value and a chevron', () => {
    const p = new ComposerSettingsPopover({ host, anchor }, settingsModel({ model: 'Default' }));
    p.open();
    const row = host.querySelector('[data-ct-key="row:model"]')!;
    expect(row.querySelector('.ct-sp-icon')!.getAttribute('data-icon')).toBe('cpu');
    expect(row.querySelector('.ct-sp-label')!.textContent).toBe('Model');
    expect(row.querySelector('.ct-sp-value')!.textContent).toBe('Default');
    expect(row.querySelector('.ct-sp-chevron')!.getAttribute('data-icon')).toBe('chevron-right');
    expect(row.getAttribute('aria-haspopup')).toBe('menu');
  });

  it('Right drills in, Left goes back, Escape goes back and only closes at the root', () => {
    const onClose = vi.fn();
    const p = new ComposerSettingsPopover({ host, anchor, onClose }, settingsModel({ model: 'Default' }));
    p.open();
    const row = () => host.querySelector<HTMLElement>('[data-ct-key="row:model"]')!;
    key(row(), 'ArrowRight');
    expect(host.querySelector('.ct-sp-back')).not.toBeNull();
    key(document.activeElement!, 'ArrowLeft');
    expect(host.querySelector('.ct-sp-back')).toBeNull();
    expect(document.activeElement).toBe(row());
    key(row(), 'ArrowRight');
    key(document.activeElement!, 'Escape');
    expect(p.isOpen).toBe(true);
    expect(host.querySelector('.ct-sp-back')).toBeNull();
    expect(document.activeElement).toBe(row());
    key(row(), 'Escape');
    expect(p.isOpen).toBe(false);
    expect(document.activeElement).toBe(anchor);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Enter on a row drills in (native button activation)', () => {
    const p = new ComposerSettingsPopover({ host, anchor }, settingsModel({ model: 'Default' }));
    p.open();
    // A real Enter on a focused button fires click; jsdom does not synthesise it.
    host.querySelector<HTMLButtonElement>('[data-ct-key="row:permissions"]')!.click();
    expect(host.querySelector('.ct-sp-back .ct-sp-label')!.textContent).toBe('Permissions');
  });

  it('Up/Down roam within the level, including the back header', () => {
    const p = new ComposerSettingsPopover({ host, anchor }, settingsModel({ model: 'Default' }));
    p.open();
    host.querySelector<HTMLButtonElement>('[data-ct-key="row:model"]')!.click();
    const back = host.querySelector<HTMLElement>('[data-ct-key="back"]')!;
    key(back, 'ArrowDown');
    expect(document.activeElement).toBe(host.querySelector('[data-ct-key="opt:model:0"]'));
    key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(back);
  });

  it('keeps the height of the root level while drilled in, and drops it on return', () => {
    const p = new ComposerSettingsPopover({ host, anchor }, settingsModel({ model: 'Default' }));
    p.open();
    const root = host.querySelector<HTMLElement>('.ct-settings-popover')!;
    Object.defineProperty(root, 'offsetHeight', { configurable: true, get: () => 180 });
    host.querySelector<HTMLButtonElement>('[data-ct-key="row:model"]')!.click();
    expect(root.style.minHeight).toBe('180px');
    host.querySelector<HTMLButtonElement>('.ct-sp-back')!.click();
    expect(root.style.minHeight).toBe('');
  });

  it('closeOnSelect options close the popover; stayOnLevel options keep the level and re-render', () => {
    const state = { value: 'a' };
    const close = vi.fn();
    const p = new ComposerSettingsPopover({ host, anchor }, () => ({
      settings: [{ id: 'r', label: 'Run on', icon: 'server', value: state.value, groups: [{ options: [
        { label: 'stay', checked: state.value === 'a', stayOnLevel: true, onSelect: () => { state.value = 'a'; } },
        { label: 'other', checked: state.value === 'b', stayOnLevel: true, onSelect: () => { state.value = 'b'; } },
        { label: 'gone', closeOnSelect: true, onSelect: close },
      ] }] }],
      actions: [],
    }));
    p.open();
    host.querySelector<HTMLButtonElement>('[data-ct-key="row:r"]')!.click();
    host.querySelector<HTMLButtonElement>('[data-ct-key="opt:r:1"]')!.click();
    expect(host.querySelector('.ct-sp-back')).not.toBeNull();
    expect(host.querySelector('[data-ct-key="opt:r:1"]')!.getAttribute('aria-checked')).toBe('true');
    host.querySelector<HTMLButtonElement>('[data-ct-key="opt:r:2"]')!.click();
    expect(close).toHaveBeenCalledOnce();
    expect(p.isOpen).toBe(false);
  });

  it('renders a group\'s custom content below its options and does not treat keys inside it as menu navigation', () => {
    const typed = vi.fn();
    const p = new ComposerSettingsPopover({ host, anchor }, () => ({
      settings: [{ id: 'r', label: 'Run on', icon: 'server', value: 'x', groups: [{
        options: [{ label: 'box', checked: true, onSelect: () => {} }],
        render: (el, ctl) => {
          const input = el.createEl('input', { attr: { type: 'text' } });
          input.addEventListener('keydown', (e) => { typed(e.key); if (e.key === 'Enter') ctl.close(); });
        },
      }] }],
      actions: [],
    }));
    p.open();
    host.querySelector<HTMLButtonElement>('[data-ct-key="row:r"]')!.click();
    const opt = host.querySelector('.ct-sp-option')!;
    const custom = host.querySelector('.ct-sp-custom')!;
    expect(opt.compareDocumentPosition(custom) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const input = custom.querySelector('input')!;
    key(input, 'ArrowLeft');
    expect(host.querySelector('.ct-sp-back')).not.toBeNull(); // still in the level
    key(input, 'Enter');
    expect(typed).toHaveBeenCalledWith('Enter');
    expect(p.isOpen).toBe(false);
  });

  it('refresh keeps the level and falls back to the root when the setting disappears', () => {
    let hasRow = true;
    const p = new ComposerSettingsPopover({ host, anchor }, () => ({
      settings: hasRow ? [{ id: 'r', label: 'Run on', icon: 'server', value: 'x', groups: [{ options: [{ label: 'a', onSelect: () => {} }] }] }, { id: 'm', label: 'Model', icon: 'cpu', value: '', groups: [] }] : [{ id: 'm', label: 'Model', icon: 'cpu', value: '', groups: [] }],
      actions: [],
    }));
    p.open();
    host.querySelector<HTMLButtonElement>('[data-ct-key="row:r"]')!.click();
    p.refresh();
    expect(host.querySelector('.ct-sp-back')).not.toBeNull();
    hasRow = false;
    p.refresh();
    expect(host.querySelector('.ct-sp-back')).toBeNull();
    expect(host.querySelector('[data-ct-key="row:m"]')).not.toBeNull();
  });

  it('shows disabled options with their reason, unfocusable and inert, as a radio or an action', () => {
    const run = vi.fn();
    const p = new ComposerSettingsPopover({ host, anchor }, () => ({
      settings: [{ id: 'r', label: 'Run on', icon: 'server', value: 'x', groups: [{ options: [
        { label: 'box \u2014 no Codex on it', disabled: true, onSelect: run },
        { label: 'Set up\u2026', action: true, dividerBefore: true, closeOnSelect: true, onSelect: run },
      ] }] }],
      actions: [],
    }));
    p.open();
    host.querySelector<HTMLButtonElement>('[data-ct-key="row:r"]')!.click();
    expect(host.querySelector('[data-ct-key="opt:r:0"]')!.textContent).toContain('\u2014 no Codex on it');
    expect(host.querySelector('[data-ct-key="opt:r:1"]')!.getAttribute('role')).toBe('menuitem');
    expect(host.querySelector('.ct-sp-options [role="separator"]')).not.toBeNull();
  });

  it('moves focus with arrows, Home and End (wrapping)', () => {
    const p = new ComposerSettingsPopover({ host, anchor }, settingsModel({ model: 'Default' }));
    p.open();
    const root = host.querySelector('.ct-settings-popover')!;
    const items = [...root.querySelectorAll<HTMLElement>('[data-ct-nav]')];
    key(items[0], 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    key(items[1], 'End');
    expect(document.activeElement).toBe(items[items.length - 1]);
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    key(items[0], 'ArrowUp');
    expect(document.activeElement).toBe(items[items.length - 1]);
    key(items[0], 'Home');
    expect(document.activeElement).toBe(items[0]);
  });

  it('Escape closes and returns focus to the indicator', () => {
    const onClose = vi.fn();
    const p = new ComposerSettingsPopover({ host, anchor, onClose }, settingsModel({ model: 'Default' }));
    p.open();
    key(document.activeElement!, 'Escape');
    expect(host.querySelector('.ct-settings-popover')).toBeNull();
    expect(document.activeElement).toBe(anchor);
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on an outside mousedown but not on one inside or on the anchor', () => {
    const p = new ComposerSettingsPopover({ host, anchor }, settingsModel({ model: 'Default' }));
    p.open();
    vi.runAllTimers();
    host.querySelector('.ct-sp-row')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    anchor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(p.isOpen).toBe(true);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(p.isOpen).toBe(false);
  });

  it('runs an action and closes', () => {
    const onFork = vi.fn();
    const p = new ComposerSettingsPopover({ host, anchor }, settingsModel({ model: 'Default' }, onFork));
    p.open();
    host.querySelector<HTMLButtonElement>('[data-ct-key="action:fork"]')!.click();
    expect(onFork).toHaveBeenCalledOnce();
    expect(p.isOpen).toBe(false);
  });

  it('skips disabled options in keyboard navigation and does not run them', () => {
    const run = vi.fn();
    const p = new ComposerSettingsPopover({ host, anchor }, () => ({
      settings: [{ id: 'h', label: 'Harness', icon: 'bot', value: 'Claude', groups: [{ options: [
        { label: 'Claude', checked: true, onSelect: run },
        { label: 'Codex — busy', disabled: true, onSelect: run },
      ] }] }],
      actions: [],
    }));
    p.open();
    host.querySelector<HTMLButtonElement>('[data-ct-key="row:h"]')!.click();
    const navs = [...host.querySelectorAll('[data-ct-nav]')];
    expect(navs.length).toBe(2); // back header + enabled option
    host.querySelector<HTMLButtonElement>('[data-ct-key="opt:h:1"]')!.click();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('ComposerProjectPopover', () => {
  const projects = [
    { id: 'a', name: 'Zeta', createdAt: 1 },
    { id: 'b', name: 'Alpha', createdAt: 2 },
  ];
  function make(over: Partial<ReturnType<ConstructorParameters<typeof ComposerProjectPopover>[1]>> = {}) {
    let mode: 'recent' | 'alpha' = 'recent';
    const handlers = { onSelect: vi.fn(), onNewProject: vi.fn(), getSortMode: () => mode, setSortMode: (m: 'recent' | 'alpha') => { mode = m; } };
    const popover = new ComposerProjectPopover({ host, anchor }, () => ({
      cwd: '/work', currentProjectId: 'a', currentProjectName: 'Zeta', projects,
      threads: [{ projectId: 'a', updatedAt: 10 }], canChange: true, ...over,
    }), handlers);
    return { popover, handlers };
  }
  const labels = () => [...host.querySelectorAll('.ct-pp-list .ct-sp-label')].map(e => e.textContent);

  it('lists No Project, projects (recent first) and New Project, marking the current one', () => {
    make().popover.open();
    expect(labels()).toEqual(['No Project', 'Zeta', 'Alpha', 'New Project…']);
    expect(host.querySelector('[data-ct-key="project:a"]')!.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(host.querySelector('.ct-pp-filter'));
  });

  it('toggles A-Z sorting and filters live', () => {
    make().popover.open();
    host.querySelector<HTMLButtonElement>('[data-sort="alpha"]')!.click();
    expect(labels()).toEqual(['No Project', 'Alpha', 'Zeta', 'New Project…']);
    expect(host.querySelector('[data-sort="alpha"]')!.getAttribute('aria-pressed')).toBe('true');
    const input = host.querySelector<HTMLInputElement>('.ct-pp-filter')!;
    input.value = 'zet';
    input.dispatchEvent(new Event('input'));
    expect(labels()).toEqual(['No Project', 'Zeta', 'New Project…']);
    input.value = 'nothing';
    input.dispatchEvent(new Event('input'));
    expect(host.textContent).toContain('No matching projects');
  });

  it('selects a project, No Project and New Project through the handlers, closing each time', () => {
    const { popover, handlers } = make();
    popover.open();
    host.querySelector<HTMLButtonElement>('[data-ct-key="project:b"]')!.click();
    expect(handlers.onSelect).toHaveBeenLastCalledWith('b');
    expect(popover.isOpen).toBe(false);
    popover.open();
    host.querySelector<HTMLButtonElement>('[data-ct-key="project:none"]')!.click();
    expect(handlers.onSelect).toHaveBeenLastCalledWith(null);
    popover.open();
    host.querySelector<HTMLButtonElement>('[data-ct-key="project:new"]')!.click();
    expect(handlers.onNewProject).toHaveBeenCalledOnce();
  });

  it('is read-only for orchestrator threads (no filter, no list)', () => {
    make({ canChange: false }).popover.open();
    expect(host.querySelector('.ct-pp-filter')).toBeNull();
    expect(host.querySelector('.ct-pp-list')).toBeNull();
    expect(host.textContent).toContain('pinned to their scope');
    expect(host.textContent).toContain('/work');
  });

  it('Escape closes and refocuses the chip', () => {
    make().popover.open();
    key(host.querySelector('.ct-pp-filter')!, 'Escape');
    expect(document.activeElement).toBe(anchor);
  });
});

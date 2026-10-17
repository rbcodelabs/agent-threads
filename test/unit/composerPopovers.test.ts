/**
 * @vitest-environment jsdom
 *
 * Behavioural contract of the composer popovers: roles/aria, in-place expansion,
 * keyboard roving, Escape focus return, outside-click dismissal and the
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

  it('expands a row in place, applies a choice, collapses, and shows the new value', () => {
    const state = { model: 'Default' };
    const p = new ComposerSettingsPopover({ host, anchor }, settingsModel(state));
    p.open();
    const row = host.querySelector<HTMLButtonElement>('[data-ct-key="row:model"]')!;
    row.click();
    expect(host.querySelector('[data-ct-key="row:model"]')!.getAttribute('aria-expanded')).toBe('true');
    const options = host.querySelectorAll('[role="menuitemradio"]');
    expect([...options].map(o => o.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    (options[1] as HTMLButtonElement).click();
    expect(state.model).toBe('Opus');
    expect(host.querySelector('[data-ct-key="row:model"]')!.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.ct-sp-row .ct-sp-value')!.textContent).toBe('Opus');
    expect(host.querySelector('.ct-settings-popover')).not.toBeNull();
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
    expect(navs.length).toBe(2); // row + enabled option
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

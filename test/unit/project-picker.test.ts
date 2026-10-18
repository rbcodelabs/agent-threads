/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectPicker } from '../../src/ProjectPicker';
import { openProjectPicker, type ProjectPickerHost } from '../../src/projectPickerHost';
import type { Project, Thread } from '../../src/types';

const project = (id: string, name: string, createdAt = 0): Project => ({ id, name, vaultFolder: `Projects/${name}`, createdAt } as Project);
const PROJECTS = [project('a', 'Alpha'), project('b', 'Beta'), project('g', 'Gamma'), project('z', 'Zed')];

let anchor: HTMLButtonElement;
beforeEach(() => {
  document.body.innerHTML = '';
  anchor = document.body.createEl('button', { text: 'chip' });
});
afterEach(() => { document.body.innerHTML = ''; });

const root = () => document.querySelector<HTMLElement>('.ct-project-picker');
const input = () => document.querySelector<HTMLInputElement>('.ct-project-picker-input')!;
const rows = () => [...document.querySelectorAll<HTMLElement>('.ct-project-picker [role="option"]')];
const labels = () => rows().map((r) => r.querySelector('.ct-project-picker-row-name')!.textContent);
const highlighted = () => rows().find((r) => r.classList.contains('is-highlighted'))?.querySelector('.ct-project-picker-row-name')?.textContent;
const key = (k: string) => input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const type = (value: string) => { input().value = value; input().dispatchEvent(new Event('input', { bubbles: true })); };

function open(overrides: Partial<ConstructorParameters<typeof ProjectPicker>[0]> = {}) {
  const onSelect = vi.fn();
  const onNewProject = vi.fn();
  const onSortChange = vi.fn();
  const picker = new ProjectPicker({
    anchor,
    getProjects: () => PROJECTS,
    getLastUsed: () => new Map<string, number>(),
    selectedId: null,
    sort: 'alphabetical',
    onSelect,
    onNewProject,
    onSortChange,
    ...overrides,
  });
  picker.open();
  return { picker, onSelect, onNewProject, onSortChange };
}

describe('ProjectPicker', () => {
  it('opens as an accessible dialog with a focused combobox filter and a listbox', () => {
    open();
    expect(root()!.getAttribute('role')).toBe('dialog');
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute('role')).toBe('combobox');
    expect(input().getAttribute('aria-controls')).toBe(document.querySelector('[role="listbox"]')!.id);
    expect(labels()).toEqual(['No Project', 'Alpha', 'Beta', 'Gamma', 'Zed', 'New Project…']);
  });

  it('marks the selected project with aria-selected and highlights it on open', () => {
    open({ selectedId: 'g' });
    const selected = rows().filter((r) => r.getAttribute('aria-selected') === 'true');
    expect(selected.map((r) => r.textContent)).toEqual(['Gamma']);
    expect(highlighted()).toBe('Gamma');
  });

  it('filters as you type, case-insensitively, and shows an empty state', () => {
    open();
    type('GAM');
    expect(labels()).toEqual(['Gamma', 'New Project…']);
    expect(highlighted()).toBe('Gamma');
    type('qqq');
    expect(labels()).toEqual(['New Project…']);
    expect(document.querySelector('.ct-project-picker-empty')!.textContent).toContain('qqq');
  });

  it('ArrowDown / ArrowUp move the highlight (wrapping) and track aria-activedescendant', () => {
    open();
    expect(highlighted()).toBe('No Project');
    key('ArrowDown');
    expect(highlighted()).toBe('Alpha');
    expect(input().getAttribute('aria-activedescendant')).toBe(rows()[1].id);
    key('ArrowUp');
    key('ArrowUp');
    expect(highlighted()).toBe('New Project…');
  });

  it('Enter selects the highlighted project and closes', () => {
    const { onSelect } = open();
    type('zed');
    key('Enter');
    expect(onSelect).toHaveBeenCalledWith('z');
    expect(root()).toBeNull();
  });

  it('Enter on No Project selects null', () => {
    const { onSelect } = open({ selectedId: 'a' });
    key('ArrowUp');
    expect(highlighted()).toBe('No Project');
    key('Enter');
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('clicking a row selects it', () => {
    const { onSelect } = open();
    rows().find((r) => r.textContent === 'Beta')!.click();
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(root()).toBeNull();
  });

  it('New Project… calls onNewProject, not onSelect', () => {
    const { onSelect, onNewProject } = open();
    rows().find((r) => r.dataset.kind === 'new')!.click();
    expect(onNewProject).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('Escape closes without selecting, stops the event, and returns focus to the anchor', () => {
    const { onSelect } = open();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const stop = vi.spyOn(event, 'stopPropagation');
    input().dispatchEvent(event);
    expect(root()).toBeNull();
    expect(stop).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(anchor);
  });

  it('the sort toggle re-orders the list, reports the change, and exposes aria-pressed', () => {
    const lastUsed = new Map([['z', 900], ['g', 500]]);
    const { onSortChange } = open({ sort: 'alphabetical', getLastUsed: () => lastUsed });
    const recent = document.querySelector<HTMLButtonElement>('.ct-project-picker-sort-btn[title="Sort by most recently used"]')!;
    const az = document.querySelector<HTMLButtonElement>('.ct-project-picker-sort-btn[title="Sort alphabetically"]')!;
    expect(az.getAttribute('aria-pressed')).toBe('true');
    expect(recent.getAttribute('aria-pressed')).toBe('false');

    recent.click();
    expect(onSortChange).toHaveBeenCalledWith('recent');
    expect(labels()).toEqual(['No Project', 'Zed', 'Gamma', 'Alpha', 'Beta', 'New Project…']);
    expect(recent.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(input());
  });

  it('keeps the filter text when the sort changes', () => {
    open({ sort: 'alphabetical' });
    type('ga');
    document.querySelector<HTMLButtonElement>('.ct-project-picker-sort-btn[title="Sort by most recently used"]')!.click();
    expect(input().value).toBe('ga');
    expect(labels()).toEqual(['Gamma', 'New Project…']);
  });

  it('closes on an outside mousedown but not on one inside', async () => {
    open();
    await new Promise((r) => setTimeout(r, 5));
    root()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(root()).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(root()).toBeNull();
  });

  it('reflects projects created while it is open once the list re-renders', () => {
    const live = [...PROJECTS];
    open({ getProjects: () => live });
    live.push(project('n', 'Newcomer'));
    type('new');
    expect(labels()).toEqual(['Newcomer', 'New Project…']);
  });

  it('can hide No Project and relabel it', () => {
    open({ allowNone: false });
    expect(labels()).not.toContain('No Project');
    document.body.innerHTML = '';
    anchor = document.body.createEl('button');
    open({ noneLabel: 'Unassigned' });
    expect(labels()[0]).toBe('Unassigned');
  });
});

describe('openProjectPicker (plugin wiring)', () => {
  function host(settings: ProjectPickerHost['settings'] = {}, threads: Partial<Thread>[] = []) {
    const saveSettings = vi.fn(async () => undefined);
    const openNewProjectSettings = vi.fn();
    const h: ProjectPickerHost = {
      manager: { getProjects: () => PROJECTS, getThreads: () => threads as Thread[] },
      settings,
      saveSettings,
      openNewProjectSettings,
    };
    return { h, saveSettings, openNewProjectSettings };
  }

  it('starts in the persisted sort mode and defaults to recent', () => {
    const { h } = host({ projectPickerSort: 'alphabetical' });
    openProjectPicker(h, { anchor, selectedId: null, onSelect: vi.fn() });
    expect(document.querySelector('.ct-project-picker-sort-btn.is-active')!.textContent).toBe('A–Z');
    document.body.innerHTML = '';
    anchor = document.body.createEl('button');
    openProjectPicker(host().h, { anchor, selectedId: null, onSelect: vi.fn() });
    expect(document.querySelector('.ct-project-picker-sort-btn.is-active')!.textContent).toBe('Recent');
  });

  it('orders recent by thread activity', () => {
    const { h } = host({}, [{ projectId: 'g', updatedAt: 50 }, { projectId: 'b', updatedAt: 10 }]);
    openProjectPicker(h, { anchor, selectedId: null, onSelect: vi.fn() });
    expect(labels()).toEqual(['No Project', 'Gamma', 'Beta', 'Alpha', 'Zed', 'New Project…']);
  });

  it('persists a sort change and stamps a chosen project as recently used', () => {
    const { h, saveSettings } = host();
    const onSelect = vi.fn();
    openProjectPicker(h, { anchor, selectedId: null, onSelect });

    document.querySelector<HTMLButtonElement>('.ct-project-picker-sort-btn[title="Sort alphabetically"]')!.click();
    expect(h.settings.projectPickerSort).toBe('alphabetical');

    rows().find((r) => r.textContent === 'Zed')!.click();
    expect(onSelect).toHaveBeenCalledWith('z');
    expect(h.settings.projectLastUsed?.z).toBeGreaterThan(0);
    expect(saveSettings).toHaveBeenCalledTimes(2);
  });

  it('does not stamp usage for No Project, and New Project… opens Settings', () => {
    const { h, openNewProjectSettings } = host();
    openProjectPicker(h, { anchor, selectedId: 'a', onSelect: vi.fn() });
    rows()[0].click();
    expect(h.settings.projectLastUsed).toBeUndefined();

    document.body.innerHTML = '';
    anchor = document.body.createEl('button');
    openProjectPicker(h, { anchor, selectedId: null, onSelect: vi.fn() });
    rows().find((r) => r.dataset.kind === 'new')!.click();
    expect(openNewProjectSettings).toHaveBeenCalledOnce();
  });
});

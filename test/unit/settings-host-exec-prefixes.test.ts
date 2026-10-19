/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { describe, it, expect, vi } from 'vitest';
import { App } from 'obsidian';
import { ClaudeThreadsSettingTab } from '../../src/SettingsTab';
import type ClaudeThreadsPlugin from '../../src/main';

interface Row { name: string; remove?: () => Promise<void> }
const rows: Row[] = [];

vi.mock('obsidian', async importOriginal => {
  const actual = await importOriginal<typeof import('obsidian')>();
  class DomSetting {
    private row: Row = { name: '' };
    constructor() { rows.push(this.row); }
    setName(name: string) { this.row.name = name; return this; }
    setDesc() { return this; }
    setHeading() { return this; }
    setClass() { return this; }
    setTooltip() { return this; }
    addButton(cb: (c: unknown) => void) {
      const c: Record<string, unknown> = {
        setButtonText: (t: string) => { if (t === 'Remove') this.row.remove = undefined; return c; },
        setWarning: () => c,
        setCta: () => c,
        onClick: (fn: () => Promise<void>) => { this.row.remove = fn; return c; },
      };
      cb(c);
      return this;
    }
    private loose(cb: (c: unknown) => void) {
      const c: unknown = new Proxy(function () {}, { get: (_t, prop) => (prop === 'inputEl' || prop === 'selectEl' ? document.createElement('input') : () => c) });
      cb(c); return this;
    }
    addToggle(cb: (c: unknown) => void) { return this.loose(cb); }
    addSlider(cb: (c: unknown) => void) { return this.loose(cb); }
    addText(cb: (c: unknown) => void) { return this.loose(cb); }
    addTextArea(cb: (c: unknown) => void) { return this.loose(cb); }
    addDropdown(cb: (c: unknown) => void) { return this.loose(cb); }
    addExtraButton(cb: (c: unknown) => void) { return this.loose(cb); }
  }
  return { ...actual, Setting: DomSetting };
});

function render(prefixes: string[]) {
  rows.length = 0;
  const saveSettings = vi.fn(async () => {});
  const settings = { disallowedTools: [], alwaysAllowedTools: [], hostExecAlwaysAllowedPrefixes: prefixes };
  const plugin = { app: new App(), settings, saveSettings } as unknown as ClaudeThreadsPlugin;
  const tab = new ClaudeThreadsSettingTab(new App(), plugin);
  const el = document.createElement('div');
  (tab as unknown as { renderToolsTab(el: HTMLElement): void }).renderToolsTab(el);
  return { el, settings, saveSettings };
}

describe('Always-allowed host commands settings', () => {
  it('shows an empty state when none are saved', () => {
    const { el } = render([]);
    expect(rows.some(r => r.name === 'Always-allowed host commands')).toBe(true);
    expect(el.textContent).toContain('No host command prefixes always allowed yet.');
  });

  it('lists each prefix and Remove revokes only that one and persists', async () => {
    const { settings, saveSettings } = render(['git status', 'npm test']);
    const row = rows.find(r => r.name === 'npm test');
    expect(rows.some(r => r.name === 'git status')).toBe(true);
    await row!.remove!();
    expect(settings.hostExecAlwaysAllowedPrefixes).toEqual(['git status']);
    expect(saveSettings).toHaveBeenCalledOnce();
  });
});

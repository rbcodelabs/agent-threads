/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { App } from 'obsidian';
import { ClaudeThreadsSettingTab } from '../../src/SettingsTab';
import type ClaudeThreadsPlugin from '../../src/main';

interface Rec { name: string; control?: 'toggle' | 'slider'; disabled?: boolean }
const rendered: Rec[] = [];

// Records each Setting's name and whether its toggle/slider was disabled.
vi.mock('obsidian', async importOriginal => {
  const actual = await importOriginal<typeof import('obsidian')>();
  class DomSetting {
    private rec: Rec = { name: '' };
    constructor() { rendered.push(this.rec); }
    setName(name: string) { this.rec.name = name; return this; }
    setDesc() { return this; }
    setHeading() { return this; }
    setClass() { return this; }
    setTooltip() { return this; }
    private component(kind: 'toggle' | 'slider', cb: (c: unknown) => void) {
      this.rec.control = kind;
      const c: Record<string, unknown> = new Proxy({}, {
        get: (_t, prop) => prop === 'setDisabled'
          ? (d: boolean) => { this.rec.disabled = d; return c; }
          : () => c,
      });
      cb(c);
      return this;
    }
    addToggle(cb: (c: unknown) => void) { return this.component('toggle', cb); }
    addSlider(cb: (c: unknown) => void) { return this.component('slider', cb); }
    private loose(cb: (c: unknown) => void) {
      const c: unknown = new Proxy(function () {}, { get: (_t, prop) => (prop === 'inputEl' || prop === 'selectEl' ? document.createElement('input') : () => c) });
      cb(c); return this;
    }
    addText(cb: (c: unknown) => void) { return this.loose(cb); }
    addTextArea(cb: (c: unknown) => void) { return this.loose(cb); }
    addDropdown(cb: (c: unknown) => void) { return this.loose(cb); }
    addButton(cb: (c: unknown) => void) { return this.loose(cb); }
    addExtraButton(cb: (c: unknown) => void) { return this.loose(cb); }
  }
  return { ...actual, Setting: DomSetting };
});

function renderTools(): Rec[] {
  rendered.length = 0;
  const plugin = { app: new App(), settings: { disallowedTools: [], alwaysAllowedTools: [] }, saveSettings: vi.fn() } as unknown as ClaudeThreadsPlugin;
  const tab = new ClaudeThreadsSettingTab(new App(), plugin);
  const el = document.createElement('div');
  (tab as unknown as { renderToolsTab(el: HTMLElement): void }).renderToolsTab(el);
  return [...rendered];
}

afterEach(() => { delete (window as unknown as { geode?: unknown }).geode; });

describe('Agent browser settings on the Tools tab', () => {
  it.each([
    ['without Geode process diagnostics', undefined, true],
    ['with Geode process diagnostics', { getFdPressure: () => ({}) }, false],
  ])('always lists the session cap and private-network controls %s', (_label, geode, disabled) => {
    if (geode) (window as unknown as { geode?: unknown }).geode = geode;
    const rows = renderTools();
    const max = rows.find(r => r.name === 'Maximum browser sessions');
    const priv = rows.find(r => r.name === 'Allow private network access');
    expect(max?.control).toBe('slider');
    expect(priv?.control).toBe('toggle');
    expect(max?.disabled).toBe(disabled);
    expect(priv?.disabled).toBe(disabled);
  });
});

/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { describe, it, expect, vi } from 'vitest';
import { App } from 'obsidian';
import { ClaudeThreadsSettingTab } from '../../src/SettingsTab';
import type ClaudeThreadsPlugin from '../../src/main';

interface Row { name: string; desc?: string; remove?: () => Promise<void> }
const rows: Row[] = [];

vi.mock('obsidian', async importOriginal => {
  const actual = await importOriginal<typeof import('obsidian')>();
  class DomSetting {
    private row: Row = { name: '' };
    constructor() { rows.push(this.row); }
    setName(name: string) { this.row.name = name; return this; }
    setDesc(d: string) { this.row.desc = d; return this; }
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

function render(remote: Record<string, string[]>) {
  rows.length = 0;
  const saveSettings = vi.fn(async () => {});
  const settings = {
    disallowedTools: [], alwaysAllowedTools: ['LocalTool'], hostExecAlwaysAllowedPrefixes: [],
    remoteAlwaysAllowedTools: remote,
    remoteDaemons: [{ id: 'd1', name: 'claude-box', url: 'ws://x', tokenSecretName: 't' }],
  };
  const plugin = { app: new App(), settings, saveSettings } as unknown as ClaudeThreadsPlugin;
  const tab = new ClaudeThreadsSettingTab(new App(), plugin);
  const el = document.createElement('div');
  (tab as unknown as { renderToolsTab(el: HTMLElement): void }).renderToolsTab(el);
  return { el, settings, saveSettings };
}

describe('Always-allowed tools on remote daemons settings', () => {
  it('shows an empty state when none are saved', () => {
    const { el } = render({});
    expect(el.textContent).toContain('No tools always allowed on remote daemons yet.');
  });

  it('lists each tool under its daemon name and Remove revokes only that daemon entry', async () => {
    const { settings, saveSettings } = render({ d1: ['mcp__a__x', 'mcp__a__y'], gone: ['mcp__a__x'] });
    expect(rows.some(r => r.desc === 'claude-box')).toBe(true);
    expect(rows.some(r => r.desc?.includes('no longer configured'))).toBe(true);
    const boxRows = rows.filter(r => r.desc === 'claude-box');
    expect(boxRows).toHaveLength(2);
    await boxRows[0].remove!();
    expect(settings.remoteAlwaysAllowedTools).toEqual({ d1: ['mcp__a__y'], gone: ['mcp__a__x'] });
    expect(settings.alwaysAllowedTools).toEqual(['LocalTool']);
    expect(saveSettings).toHaveBeenCalledOnce();
  });
});

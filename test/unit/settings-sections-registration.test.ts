/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { App } from 'obsidian';
import ClaudeThreadsPlugin from '../../src/main';
import { ClaudeThreadsSettingTab, SETTINGS_SECTIONS } from '../../src/SettingsTab';
import { DEFAULT_SETTINGS } from '../../src/types';

const EXPECTED_ORDER = ['general', 'claude', 'tools', 'vault', 'features', 'projects', 'secrets', 'scheduled', 'skills', 'mcp', 'remote'];

type Host = { addSettingSection?: ReturnType<typeof vi.fn>; addSettingTab: ReturnType<typeof vi.fn> };

/** Minimal plugin: real onload() with every startup side effect stubbed out. */
function makePlugin(withSections: boolean) {
  const plugin = Object.create(ClaudeThreadsPlugin.prototype) as ClaudeThreadsPlugin & Host;
  const p = plugin as unknown as Record<string, unknown>;
  p.settings = { ...DEFAULT_SETTINGS, threads: [] };
  p.manifest = { id: 'claude-threads' };
  p.app = new App();
  p.settingSectionTabs = new Map();
  p.loadSettings = vi.fn().mockResolvedValue(undefined);
  p.onloadDesktop = vi.fn().mockResolvedValue(undefined);
  p.addCommand = vi.fn();
  p.addSettingTab = vi.fn();
  if (withSections) p.addSettingSection = vi.fn((s: { id: string }) => `tab-${s.id}`);
  return plugin;
}

afterEach(() => vi.restoreAllMocks());

describe('settings section registration (onload)', () => {
  it('SETTINGS_SECTIONS lists all 11 sections in sidebar order', () => {
    expect(SETTINGS_SECTIONS.map(s => s.id)).toEqual(EXPECTED_ORDER);
  });

  it('registers all 11 sections in order with distinct ids and never calls addSettingTab when the host supports sections', async () => {
    const plugin = makePlugin(true);
    await plugin.onload();
    const calls = plugin.addSettingSection!.mock.calls.map(c => c[0] as { id: string; name: string; tab: unknown });
    expect(calls).toHaveLength(11);
    expect(calls.map(c => c.id)).toEqual(EXPECTED_ORDER);
    expect(new Set(calls.map(c => c.id)).size).toBe(11);
    expect(calls.every(c => c.tab instanceof ClaudeThreadsSettingTab)).toBe(true);
    expect(new Set(calls.map(c => c.tab)).size).toBe(11);
    expect(plugin.addSettingTab).not.toHaveBeenCalled();
  });

  it('falls back to a single addSettingTab when the host has no addSettingSection', async () => {
    const plugin = makePlugin(false);
    await plugin.onload();
    expect(plugin.addSettingTab).toHaveBeenCalledTimes(1);
    expect(plugin.addSettingTab.mock.calls[0][0]).toBeInstanceOf(ClaudeThreadsSettingTab);
  });

  it('openNewProjectSettings opens the host-assigned projects section id', async () => {
    const plugin = makePlugin(true);
    await plugin.onload();
    const openTabById = vi.fn();
    (plugin.app as unknown as { setting: unknown }).setting = { open: vi.fn(), openTabById };
    const show = vi.spyOn(ClaudeThreadsSettingTab.prototype, 'showNewProject').mockImplementation(() => {});
    plugin.openNewProjectSettings();
    expect(show).toHaveBeenCalledTimes(1);
    expect(openTabById).toHaveBeenCalledWith('tab-projects');
  });
});

describe('fixed-section settings tab display()', () => {
  it('renders only its section body and no in-pane compact nav', () => {
    const plugin = makePlugin(false);
    const tab = new ClaudeThreadsSettingTab(new App(), plugin, 'projects');
    const spies = {
      projects: vi.spyOn(tab as never, 'renderProjectsTab').mockImplementation(() => {}),
      general: vi.spyOn(tab as never, 'renderGeneralTab').mockImplementation(() => {}),
      mcp: vi.spyOn(tab as never, 'renderMcpTab').mockImplementation(() => {}),
    };
    tab.display();
    expect(spies.projects).toHaveBeenCalledTimes(1);
    expect(spies.general).not.toHaveBeenCalled();
    expect(spies.mcp).not.toHaveBeenCalled();
    expect(tab.containerEl.querySelector('.ct-settings-compact-nav')).toBeNull();
    expect(tab.containerEl.querySelector('.ct-settings-shell')).toBeNull();
    expect(tab.containerEl.querySelectorAll('.ct-settings-tab-body')).toHaveLength(1);
  });

  it('without a fixed section the in-pane nav is still rendered (Obsidian fallback)', () => {
    const plugin = makePlugin(false);
    const tab = new ClaudeThreadsSettingTab(new App(), plugin);
    vi.spyOn(tab as never, 'renderGeneralTab').mockImplementation(() => {});
    tab.display();
    expect(tab.containerEl.querySelector('.ct-settings-compact-nav')).not.toBeNull();
  });
});

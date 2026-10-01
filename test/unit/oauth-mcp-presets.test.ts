/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { describe, it, expect, vi } from 'vitest';
import { App } from 'obsidian';
import { OAUTH_MCP_PRESETS } from '../../src/oauthMcpPresets';
import { mcpRegistrationSchema } from '../../src/mcpServerStore';
import { McpServerModal, ClaudeThreadsSettingTab } from '../../src/SettingsTab';
import type ClaudeThreadsPlugin from '../../src/main';

/** The entry the form would build for a preset, with a placeholder where the user must supply a client ID. */
function entryFor(p: (typeof OAUTH_MCP_PRESETS)[number]) {
  return {
    name: p.name,
    type: 'oauth' as const,
    url: p.url,
    ...(p.scopes ? { scopes: p.scopes } : {}),
    ...(p.redirectUri ? { redirectUri: p.redirectUri } : {}),
    ...(p.clientId ? { clientId: p.clientId } : {}),
    ...(p.requiresClientId && !p.clientId ? { clientId: 'user-supplied-client-id' } : {}),
  };
}

// The shared obsidian mock's Setting renders nothing and Modal.open() is a no-op;
// this file needs both to produce DOM, so it overrides just those two.
vi.mock('obsidian', async importOriginal => {
  const actual = await importOriginal<typeof import('obsidian')>();
  class DomButton {
    buttonEl = document.createElement('button');
    setButtonText(text: string) { this.buttonEl.textContent = text; return this; }
    setWarning() { return this; }
    setCta() { return this; }
    setDisabled(disabled: boolean) { this.buttonEl.disabled = disabled; return this; }
    onClick(cb: () => unknown) { this.buttonEl.addEventListener('click', () => { void cb(); }); return this; }
  }
  class DomSetting {
    settingEl: HTMLElement; nameEl: HTMLElement; descEl: HTMLElement; controlEl: HTMLElement;
    constructor(container: HTMLElement) {
      this.settingEl = container.createDiv('setting-item');
      const info = this.settingEl.createDiv('setting-item-info');
      this.nameEl = info.createDiv('setting-item-name');
      this.descEl = info.createDiv('setting-item-description');
      this.controlEl = this.settingEl.createDiv('setting-item-control');
    }
    setName(name: string) { this.nameEl.textContent = name; return this; }
    setDesc(desc: string) { this.descEl.textContent = desc; return this; }
    setHeading() { return this; }
    addButton(cb: (btn: DomButton) => void) { const b = new DomButton(); this.controlEl.appendChild(b.buttonEl); cb(b); return this; }
    // Components the MCP tab uses but these tests don't inspect: chainable no-ops.
    private loose(cb: (c: unknown) => void) {
      const c: unknown = new Proxy(function () {}, { get: (_t, prop) => (prop === 'inputEl' || prop === 'selectEl' ? document.createElement('input') : () => c) });
      cb(c); return this;
    }
    addToggle(cb: (c: unknown) => void) { return this.loose(cb); }
    addText(cb: (c: unknown) => void) { return this.loose(cb); }
    addTextArea(cb: (c: unknown) => void) { return this.loose(cb); }
    addDropdown(cb: (c: unknown) => void) { return this.loose(cb); }
    addExtraButton(cb: (c: unknown) => void) { return this.loose(cb); }
  }
  class DomModal extends actual.Modal {
    override open() { document.body.appendChild(this.contentEl); (this as unknown as { onOpen?: () => void }).onOpen?.(); }
  }
  return { ...actual, Setting: DomSetting, Modal: DomModal };
});

describe('OAUTH_MCP_PRESETS data', () => {
  it('has unique ids and names', () => {
    expect(new Set(OAUTH_MCP_PRESETS.map(p => p.id)).size).toBe(OAUTH_MCP_PRESETS.length);
    expect(new Set(OAUTH_MCP_PRESETS.map(p => p.name)).size).toBe(OAUTH_MCP_PRESETS.length);
  });

  it.each(OAUTH_MCP_PRESETS.map(p => [p.id, p] as const))('%s passes the shared registration schema', (_id, p) => {
    const parsed = mcpRegistrationSchema.safeParse(entryFor(p));
    expect(parsed.success, parsed.success ? '' : parsed.error.issues[0]?.message).toBe(true);
  });

  it('uses https URLs and cites a source for each preset', () => {
    for (const p of OAUTH_MCP_PRESETS) {
      expect(p.url.startsWith('https://')).toBe(true);
      expect(p.source.startsWith('https://')).toBe(true);
    }
  });

  it('never ships a client ID for presets that require the user\'s own', () => {
    for (const p of OAUTH_MCP_PRESETS.filter(x => x.requiresClientId)) {
      expect(p.clientId).toBeUndefined();
      expect(p.redirectUri).toBeTruthy();
    }
  });
});

describe('Quick connect section on the MCP settings screen', () => {
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  function render(opts: { connected?: Record<string, { url: string }>; registerServer?: ReturnType<typeof vi.fn> } = {}) {
    const registerServer = opts.registerServer ?? vi.fn(async () => ({ success: true, status: 'registered', message: 'ok' }));
    const disconnect = vi.fn(async () => {});
    const plugin = {
      settings: { mcpServers: {}, oauthMcpServers: opts.connected ?? {}, oauthMcpState: {}, secretEnvKeys: [] },
      saveSettings: vi.fn(),
      oauthMcpRegistry: {
        registerServer, disconnect,
        status: () => ({ serverName: 'x', clientId: 'c', asMetadataUrl: 'u', proxyPort: 1, status: 'connected', hasRefreshToken: true }),
      },
    } as unknown as ClaudeThreadsPlugin;
    const tab = new ClaudeThreadsSettingTab(new App(), plugin);
    const el = document.createElement('div');
    document.body.appendChild(el);
    (tab as unknown as { renderMcpTab(el: HTMLElement): void }).renderMcpTab(el);
    const rows = () => [...el.querySelectorAll('.ct-oauth-mcp-presets-list .setting-item')] as HTMLElement[];
    const rowFor = (label: string) => rows().find(r => r.querySelector('.setting-item-name')?.textContent?.startsWith(label))!;
    const btn = (row: HTMLElement) => row.querySelector('button')!;
    return { el, registerServer, disconnect, rows, rowFor, btn };
  }

  it('renders a Quick connect heading and one row per preset with its URL', () => {
    const { el, rows, btn } = render();
    expect([...el.querySelectorAll('h3')].map(h => h.textContent)).toContain('Quick connect');
    expect(rows()).toHaveLength(OAUTH_MCP_PRESETS.length);
    for (const [i, p] of OAUTH_MCP_PRESETS.entries()) {
      expect(rows()[i]!.textContent).toContain(p.label);
      expect(rows()[i]!.textContent).toContain(p.url);
      expect(btn(rows()[i]!).textContent).toBe('Connect');
    }
  });

  it('connects a preset with no extra requirements in one click, with the merged config', async () => {
    const { rowFor, btn, registerServer } = render();
    btn(rowFor('Linear')).click();
    await flush();
    expect(registerServer).toHaveBeenCalledTimes(1);
    expect(registerServer.mock.calls[0]![0]).toMatchObject({ name: 'linear', url: 'https://mcp.linear.app/mcp' });
  });

  it('prompts for a Client ID and secret before connecting a requiresClientId preset', async () => {
    const { rowFor, btn, registerServer } = render();
    btn(rowFor('Asana')).click();
    await flush();
    expect(registerServer).not.toHaveBeenCalled();
    const modal = document.body.textContent ?? '';
    expect(modal).toContain('Client ID (required)');
    expect(modal).toContain('Client secret');
  });

  it('does not render preset chips in the Add MCP server modal any more', () => {
    const plugin = { settings: { mcpServers: {}, oauthMcpServers: {}, oauthMcpState: {} }, saveSettings: vi.fn(), oauthMcpRegistry: { registerServer: vi.fn() } } as unknown as ClaudeThreadsPlugin;
    const modal = new McpServerModal(new App(), plugin, null, vi.fn());
    modal.close = () => {};
    modal.onOpen();
    [...modal.contentEl.querySelectorAll('button')].find(b => b.textContent === 'OAuth')!.click();
    expect(modal.contentEl.querySelector('.ct-modal-preset-row')).toBeNull();
    const labels = [...modal.contentEl.querySelectorAll('button')].map(b => b.textContent);
    for (const p of OAUTH_MCP_PRESETS) expect(labels).not.toContain(p.label);
  });

  it('shows status and Disconnect for a connected preset, and disconnects through the registry', async () => {
    const { rowFor, btn, disconnect } = render({ connected: { linear: { url: 'https://mcp.linear.app/mcp' } } });
    const row = rowFor('Linear');
    expect(row.querySelector('.ct-oauth-status-dot--green')).not.toBeNull();
    expect(btn(row).textContent).toBe('Disconnect');
    btn(row).click();
    await flush();
    expect(disconnect).toHaveBeenCalledWith('linear');
  });
});

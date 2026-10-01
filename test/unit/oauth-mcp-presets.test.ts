/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { describe, it, expect, vi } from 'vitest';
import { App } from 'obsidian';
import { OAUTH_MCP_PRESETS } from '../../src/oauthMcpPresets';
import { mcpRegistrationSchema } from '../../src/mcpServerStore';
import { McpServerModal } from '../../src/SettingsTab';
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

describe('Add MCP server modal presets', () => {
  function open() {
    const registerServer = vi.fn(async () => ({ success: true, status: 'registered', message: 'ok' }));
    const plugin = {
      settings: { mcpServers: {}, oauthMcpServers: {}, oauthMcpState: {} },
      saveSettings: vi.fn(),
      oauthMcpRegistry: { registerServer },
    } as unknown as ClaudeThreadsPlugin;
    const modal = new McpServerModal(new App(), plugin, null, vi.fn());
    modal.close = () => {};
    modal.onOpen();
    const button = (label: string) =>
      [...modal.contentEl.querySelectorAll('button')].find(b => b.textContent === label)!;
    button('OAuth').click();
    return { modal, registerServer, button };
  }

  it('prefills the form without submitting', () => {
    const { modal, registerServer, button } = open();
    button('Linear').click();
    const inputs = [...modal.contentEl.querySelectorAll<HTMLInputElement>('input')];
    expect(inputs.some(i => i.value === 'linear')).toBe(true);
    expect(inputs.some(i => i.value === 'https://mcp.linear.app/mcp')).toBe(true);
    expect(registerServer).not.toHaveBeenCalled();
  });

  it('opens Advanced, prefills the redirect URI and shows a note for Slack', () => {
    const { modal, button } = open();
    button('Slack').click();
    expect(modal.contentEl.querySelector('details')!.open).toBe(true);
    const inputs = [...modal.contentEl.querySelectorAll<HTMLInputElement>('input')];
    expect(inputs.some(i => i.value === 'http://localhost:3118/callback')).toBe(true);
    expect(modal.contentEl.textContent).toContain('does not support Dynamic Client Registration');
  });

  it('clears the previous preset\'s redirect URI when switching to one without', () => {
    const { modal, button } = open();
    button('Slack').click();
    button('Linear').click();
    const inputs = [...modal.contentEl.querySelectorAll<HTMLInputElement>('input')];
    expect(inputs.some(i => i.value === 'http://localhost:3118/callback')).toBe(false);
  });
});

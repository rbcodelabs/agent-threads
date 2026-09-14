/** @vitest-environment jsdom */
/**
 * The OAuth arm of the "Add MCP server" modal. This form is the settings-side
 * twin of the `mcp_register_server` tool path, so the assertions here lean on
 * the two things that would silently rot: that it delegates to
 * `OAuthMcpRegistry.registerServer()` rather than writing settings itself, and
 * that it validates through the same shared schema the tool path uses.
 */
import '../setup/obsidian-dom';
import { describe, it, expect, vi } from 'vitest';
import { App } from 'obsidian';
import { McpServerModal } from '../../src/SettingsTab';
import type ClaudeThreadsPlugin from '../../src/main';

type RegisterResult = { success: boolean; status?: string; message: string };

function openModal(options: {
  registerServer?: (entry: Record<string, unknown>) => Promise<RegisterResult>;
  withoutRegistry?: boolean;
  existing?: { name: string; type: 'stdio'; command: string } | null;
} = {}) {
  const registerServer = options.registerServer
    ?? vi.fn(async () => ({ success: true, status: 'registered', message: 'ok' }));
  const onSaved = vi.fn();
  const plugin = {
    settings: { mcpServers: {}, oauthMcpServers: {}, oauthMcpState: {} },
    saveSettings: vi.fn(),
    ...(options.withoutRegistry ? {} : { oauthMcpRegistry: { registerServer } }),
  } as unknown as ClaudeThreadsPlugin;

  const modal = new McpServerModal(new App(), plugin, options.existing ?? null, onSaved);
  let closed = false;
  modal.close = () => { closed = true; };
  modal.onOpen();

  const button = (label: string) =>
    [...modal.contentEl.querySelectorAll('button')].find(b => b.textContent === label);
  const field = (placeholder: string) =>
    modal.contentEl.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;

  return { modal, registerServer, onSaved, button, field, isClosed: () => closed };
}

/** Switch to the OAuth tab and fill in a valid minimal entry. */
function fillValidOAuth(h: ReturnType<typeof openModal>, over: { name?: string; url?: string } = {}) {
  h.button('OAuth')!.click();
  h.field('vercel').value = over.name ?? 'vercel';
  h.field('https://mcp.vercel.com/').value = over.url ?? 'https://mcp.vercel.com/';
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('OAuth tab visibility', () => {
  it('is offered when adding a server', () => {
    const h = openModal();
    expect(h.button('OAuth')).toBeDefined();
    expect(h.button('Command (stdio)')).toBeDefined();
    expect(h.button('HTTP or SSE')).toBeDefined();
  });

  it('is hidden when editing, since a connected server is reconnected rather than edited', () => {
    const h = openModal({ existing: { name: 'existing', type: 'stdio', command: 'npx' } });
    expect(h.button('OAuth')).toBeUndefined();
    expect(h.button('Command (stdio)')).toBeDefined();
  });
});

describe('validation', () => {
  it.each([
    ['name is missing', { name: '' }, 'Name is required.'],
    ['url is missing', { url: '' }, 'URL is required.'],
  ])('refuses to connect when %s', async (_label, over, expected) => {
    const h = openModal();
    fillValidOAuth(h, over);
    h.button('Connect')!.click();
    await flush();

    expect(h.registerServer).not.toHaveBeenCalled();
    expect(h.modal.contentEl.textContent).toContain(expected);
    expect(h.isClosed()).toBe(false);
  });

  it('rejects a non-https URL through the shared schema', async () => {
    const h = openModal();
    fillValidOAuth(h, { url: 'http://mcp.vercel.com/' });
    h.button('Connect')!.click();
    await flush();

    expect(h.registerServer).not.toHaveBeenCalled();
    expect(h.isClosed()).toBe(false);
  });

  it('rejects a URL carrying embedded credentials', async () => {
    const h = openModal();
    fillValidOAuth(h, { url: 'https://user:pw@mcp.vercel.com/' });
    h.button('Connect')!.click();
    await flush();

    expect(h.registerServer).not.toHaveBeenCalled();
  });

  it('rejects a reserved server name', async () => {
    const h = openModal();
    fillValidOAuth(h, { name: 'obsidian' });
    h.button('Connect')!.click();
    await flush();

    expect(h.registerServer).not.toHaveBeenCalled();
  });
});

describe('connecting', () => {
  it('delegates to the registry and closes on success', async () => {
    const h = openModal();
    fillValidOAuth(h);
    h.button('Connect')!.click();
    await flush();

    expect(h.registerServer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'vercel', url: 'https://mcp.vercel.com/' }),
    );
    expect(h.isClosed()).toBe(true);
    expect(h.onSaved).toHaveBeenCalledOnce();
  });

  it('passes scopes and a deny filter through to the registry', async () => {
    const h = openModal();
    fillValidOAuth(h);
    h.field('openid profile email').value = 'openid profile';
    const select = h.modal.contentEl.querySelector<HTMLSelectElement>('select')!;
    select.value = 'deny';
    select.dispatchEvent(new Event('change'));
    h.modal.contentEl.querySelector<HTMLTextAreaElement>('textarea')!.value = 'buy_pro\n\nbuy_credits\n';

    h.button('Connect')!.click();
    await flush();

    expect(h.registerServer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        scopes: 'openid profile',
        tools: { deny: ['buy_pro', 'buy_credits'] },
      }),
    );
  });

  it('passes an Advanced redirect URI through to the registry', async () => {
    const h = openModal();
    fillValidOAuth(h);
    h.field('http://localhost:3118/callback').value = 'http://localhost:3118/callback';

    h.button('Connect')!.click();
    await flush();

    expect(h.registerServer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ redirectUri: 'http://localhost:3118/callback' }),
    );
  });

  it('omits redirectUri entirely when the Advanced field is left blank', async () => {
    const h = openModal();
    fillValidOAuth(h);

    h.button('Connect')!.click();
    await flush();

    expect(h.registerServer.mock.calls[0][0].redirectUri).toBeUndefined();
  });

  it('rejects a non-loopback redirect URI through the shared schema', async () => {
    const h = openModal();
    fillValidOAuth(h);
    h.field('http://localhost:3118/callback').value = 'http://evil.example.com:3118/callback';

    h.button('Connect')!.click();
    await flush();

    expect(h.registerServer).not.toHaveBeenCalled();
    expect(h.modal.contentEl.textContent).toContain('loopback');
    expect(h.isClosed()).toBe(false);
  });

  it('omits the tool filter entirely when the mode is "No filter"', async () => {
    const h = openModal();
    fillValidOAuth(h);
    h.modal.contentEl.querySelector<HTMLTextAreaElement>('textarea')!.value = 'buy_pro';

    h.button('Connect')!.click();
    await flush();

    expect(h.registerServer.mock.calls[0][0]).not.toHaveProperty('tools.deny');
    expect(h.registerServer.mock.calls[0][0].tools).toBeUndefined();
  });

  it('surfaces the failure message and stays open when the registry declines', async () => {
    const h = openModal({
      registerServer: vi.fn(async () => ({ success: false, status: 'failed', message: 'Consent window timed out.' })),
    });
    fillValidOAuth(h);
    h.button('Connect')!.click();
    await flush();

    expect(h.modal.contentEl.textContent).toContain('Consent window timed out.');
    expect(h.isClosed()).toBe(false);
    expect(h.onSaved).not.toHaveBeenCalled();
  });

  it('surfaces a thrown error rather than leaving the button stuck on "Connecting…"', async () => {
    const h = openModal({
      registerServer: vi.fn(async () => { throw new Error('network unreachable'); }),
    });
    fillValidOAuth(h);
    h.button('Connect')!.click();
    await flush();

    expect(h.modal.contentEl.textContent).toContain('network unreachable');
    expect(h.button('Connect')).toBeDefined();
    expect(h.button('Connect')!.hasAttribute('disabled')).toBe(false);
    expect(h.isClosed()).toBe(false);
  });

  it('ignores a second click while the first consent round-trip is still open', async () => {
    let release!: (r: RegisterResult) => void;
    const h = openModal({
      registerServer: vi.fn(() => new Promise<RegisterResult>(resolve => { release = resolve; })),
    });
    fillValidOAuth(h);

    h.button('Connect')!.click();
    await flush();
    // Mid-flight: the button reports progress and is disabled.
    const inFlight = h.button('Connecting…');
    expect(inFlight).toBeDefined();
    expect(inFlight!.hasAttribute('disabled')).toBe(true);

    inFlight!.click();
    await flush();
    expect(h.registerServer).toHaveBeenCalledOnce();

    release({ success: true, message: 'ok' });
    await flush();
    expect(h.isClosed()).toBe(true);
  });

  it('submits on Enter, like the stdio and HTTP forms', async () => {
    const h = openModal();
    fillValidOAuth(h);
    h.field('vercel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();

    expect(h.registerServer).toHaveBeenCalledOnce();
    expect(h.isClosed()).toBe(true);
  });

  it('ignores Enter while a consent round-trip is open, which a disabled button cannot block', async () => {
    let release!: (r: RegisterResult) => void;
    const h = openModal({
      registerServer: vi.fn(() => new Promise<RegisterResult>(resolve => { release = resolve; })),
    });
    fillValidOAuth(h);
    h.button('Connect')!.click();
    await flush();

    // A keypress reaches the handler even though the button is disabled.
    h.field('vercel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(h.registerServer).toHaveBeenCalledOnce();

    release({ success: true, message: 'ok' });
    await flush();
    expect(h.isClosed()).toBe(true);
  });

  it('reports unavailability instead of throwing when no registry is wired up', async () => {
    const h = openModal({ withoutRegistry: true });
    fillValidOAuth(h);
    h.button('Connect')!.click();
    await flush();

    expect(h.modal.contentEl.textContent).toContain('unavailable');
    expect(h.isClosed()).toBe(false);
  });
});

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
  /**
   * By aria-label, not by position: the form has more than one `<select>`, so a
   * bare `querySelector('select')` silently retargets whenever a new one is added
   * ahead of the intended one.
   */
  const select = (ariaLabel: string) =>
    modal.contentEl.querySelector<HTMLSelectElement>(`select[aria-label="${ariaLabel}"]`)!;
  const labelText = (text: string) =>
    [...modal.contentEl.querySelectorAll('label')].find(l => l.textContent === text);
  /**
   * Several Advanced inputs carry no placeholder, so they are reachable only
   * through the label that precedes them — which is also what a sighted user
   * relies on, making the lookup fail if the two are ever separated.
   */
  const inputAfterLabel = (text: string) =>
    labelText(text)?.nextElementSibling as HTMLInputElement | undefined;
  const secretInput = () => modal.contentEl.querySelector<HTMLInputElement>('input[type="password"]')!;
  const advanced = () => modal.contentEl.querySelector('details')!;

  return {
    modal, registerServer, onSaved, button, field, select, labelText,
    inputAfterLabel, secretInput, advanced, isClosed: () => closed,
  };
}

/** Switch to the OAuth tab and fill in a valid minimal entry. */
function fillValidOAuth(h: ReturnType<typeof openModal>, over: { name?: string; url?: string } = {}) {
  h.button('OAuth')!.click();
  h.field('vercel').value = over.name ?? 'vercel';
  h.field('https://mcp.vercel.com/').value = over.url ?? 'https://mcp.vercel.com/';
}

/** Select the machine-to-machine grant the way a user does, firing `change`. */
function chooseClientCredentials(h: ReturnType<typeof openModal>) {
  const grant = h.select('Grant type');
  grant.value = 'client_credentials';
  grant.dispatchEvent(new Event('change'));
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
    const select = h.select('Tool filter');
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

/**
 * The client_credentials grant reshapes the form rather than adding to it: there
 * is no browser leg, so Redirect URI becomes meaningless (and schema-invalid),
 * while Client ID and secret stop being optional overrides and become the whole
 * of the credentials. Both halves are asserted here because a form that merely
 * *ignored* the wrong fields would send an entry the shared schema rejects, with
 * nothing on screen explaining why.
 */
describe('client credentials grant', () => {
  it('hides the Redirect URI field, which the shared schema rejects for this grant', () => {
    const h = openModal();
    fillValidOAuth(h);
    const redirectLabel = h.labelText('Redirect URI (optional — e.g. http://localhost:3118/callback for Slack)')!;
    const redirectField = h.field('http://localhost:3118/callback');
    expect(redirectLabel.style.display).toBe('');

    chooseClientCredentials(h);
    expect(redirectLabel.style.display).toBe('none');
    expect(redirectField.style.display).toBe('none');
  });

  it('relabels Client ID and secret as required, and opens Advanced so they are visible at all', () => {
    const h = openModal();
    fillValidOAuth(h);
    expect(h.advanced().open).toBe(false);

    chooseClientCredentials(h);
    expect(h.advanced().open).toBe(true);
    expect(h.labelText('Client ID (required)')).toBeDefined();
    expect(h.labelText('Client secret (required)')).toBeDefined();
    expect(h.labelText('Audience (required by some providers — e.g. an Auth0 API identifier)')).toBeDefined();
  });

  it('replaces the sign-in explanation, which is false when no browser opens', () => {
    const h = openModal();
    fillValidOAuth(h);
    expect(h.modal.contentEl.textContent).toContain('sign-in page in the Web Viewer');

    chooseClientCredentials(h);
    expect(h.modal.contentEl.textContent).not.toContain('sign-in page in the Web Viewer');
    expect(h.modal.contentEl.textContent).toContain('no browser and no sign-in');
    expect(h.modal.contentEl.textContent).toContain('never in this plugin\'s data.json');
  });

  it('switching back to authorization code restores the browser-flow form', () => {
    const h = openModal();
    fillValidOAuth(h);
    chooseClientCredentials(h);

    const grant = h.select('Grant type');
    grant.value = 'authorization_code';
    grant.dispatchEvent(new Event('change'));

    expect(h.field('http://localhost:3118/callback').style.display).toBe('');
    expect(h.labelText('Client ID (skips Dynamic Client Registration)')).toBeDefined();
    expect(h.modal.contentEl.textContent).toContain('sign-in page in the Web Viewer');
  });

  /**
   * The schema cannot catch this: the typed literal is deliberately kept out of
   * the validated entry so it never reaches a transcript-logged tool argument,
   * which leaves this check as the only thing between the user and a round-trip
   * failure from registerServer().
   */
  it('refuses to connect without a client secret, since a machine client cannot be public', async () => {
    const h = openModal();
    fillValidOAuth(h);
    chooseClientCredentials(h);
    h.inputAfterLabel('Client ID (required)')!.value = 'm2m';

    h.button('Connect')!.click();
    await flush();

    expect(h.registerServer).not.toHaveBeenCalled();
    expect(h.modal.contentEl.textContent).toContain('requires a client secret');
    expect(h.isClosed()).toBe(false);
  });

  it('refuses to connect without a client ID, before any network round trip', async () => {
    const h = openModal();
    fillValidOAuth(h);
    chooseClientCredentials(h);
    h.secretInput().value = 'shh-abc';

    h.button('Connect')!.click();
    await flush();

    expect(h.registerServer).not.toHaveBeenCalled();
    expect(h.isClosed()).toBe(false);
  });

  it('passes grantType, clientId, audience and the typed secret through to the registry', async () => {
    const h = openModal();
    fillValidOAuth(h, { name: 'bankrate', url: 'https://products-mcp.bankrate.com/mcp' });
    chooseClientCredentials(h);
    h.inputAfterLabel('Client ID (required)')!.value = 'reTmVHKuhRrGiXOo3lqvS4zMUxagdXZC';
    h.secretInput().value = 'shh-abc';
    h.field('bankrate-api').value = 'bankrate-api';

    h.button('Connect')!.click();
    await flush();

    expect(h.registerServer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: 'bankrate',
        url: 'https://products-mcp.bankrate.com/mcp',
        grantType: 'client_credentials',
        clientId: 'reTmVHKuhRrGiXOo3lqvS4zMUxagdXZC',
        clientSecret: 'shh-abc',
        audience: 'bankrate-api',
      }),
    );
    expect(h.isClosed()).toBe(true);
  });

  /**
   * A redirect URI typed before the grant was switched stays in the DOM, and the
   * schema rejects the field outright for this grant — so the handler has to drop
   * it rather than read whatever the hidden input still holds.
   */
  it('drops a redirect URI typed before the grant was switched', async () => {
    const h = openModal();
    fillValidOAuth(h);
    h.field('http://localhost:3118/callback').value = 'http://localhost:3118/callback';
    chooseClientCredentials(h);
    h.inputAfterLabel('Client ID (required)')!.value = 'm2m';
    h.secretInput().value = 'shh-abc';

    h.button('Connect')!.click();
    await flush();

    expect(h.registerServer).toHaveBeenCalledOnce();
    expect(h.registerServer.mock.calls[0][0].redirectUri).toBeUndefined();
  });

  it('reports token progress rather than a sign-in prompt while the request is open', async () => {
    let release!: (r: RegisterResult) => void;
    const h = openModal({
      registerServer: vi.fn(() => new Promise<RegisterResult>(resolve => { release = resolve; })),
    });
    fillValidOAuth(h);
    chooseClientCredentials(h);
    h.inputAfterLabel('Client ID (required)')!.value = 'm2m';
    h.secretInput().value = 'shh-abc';

    h.button('Connect')!.click();
    await flush();
    expect(h.modal.contentEl.textContent).toContain('Requesting a token…');
    expect(h.modal.contentEl.textContent).not.toContain('signing in');

    release({ success: true, message: 'ok' });
    await flush();
    expect(h.isClosed()).toBe(true);
  });

  /** Backward compatibility: an untouched form must submit exactly as before. */
  it('leaves grantType and audience unset on the default grant', async () => {
    const h = openModal();
    fillValidOAuth(h);
    h.button('Connect')!.click();
    await flush();

    expect(h.registerServer.mock.calls[0][0].grantType).toBeUndefined();
    expect(h.registerServer.mock.calls[0][0].audience).toBeUndefined();
  });
});

/**
 * @vitest-environment jsdom
 *
 * The status dot and label on each OAuth MCP server row in Settings. This is the
 * only place the UI explains an OAuth connection's health, and it had no test at
 * all before the client_credentials grant arrived — a grant whose expectations it
 * inverts. For an interactive connection an approaching expiry is a warning,
 * because clearing it needs the user at a consent screen; for a machine-to-machine
 * one the same timestamp is routine, since the plugin re-mints from the stored
 * secret with nobody present. Showing "Expires soon" there would nag about
 * something already handled, and "Needs re-authorization" would point at a
 * consent screen this grant never had.
 */
import '../setup/obsidian-dom';
import { describe, it, expect } from 'vitest';
import { describeOAuthMcpStatus } from '../../src/SettingsTab';
import type { OAuthMcpState } from '../../src/types';

function state(over: Partial<OAuthMcpState> = {}): OAuthMcpState {
  return {
    serverName: 'vercel',
    clientId: 'client-abc',
    asMetadataUrl: 'https://vercel.com/.well-known/oauth-authorization-server',
    proxyPort: 51234,
    status: 'connected',
    hasRefreshToken: true,
    ...over,
  };
}

describe('describeOAuthMcpStatus — no state yet', () => {
  it('is grey and "Not configured" for a server that has never connected', () => {
    expect(describeOAuthMcpStatus(undefined)).toEqual({ label: 'Not configured', tone: 'grey' });
  });
});

describe('describeOAuthMcpStatus — authorization_code', () => {
  it('reports the remaining lifetime in hours and minutes', () => {
    expect(describeOAuthMcpStatus(state({ accessTokenExpiresAt: Date.now() + 90 * 60_000 })))
      .toEqual({ label: 'Connected · expires in 1h 30m', tone: 'green' });
  });

  /** The user has to be present to fix it, so an imminent expiry is worth a warning. */
  it('warns with "Expires soon" inside the last 15 minutes', () => {
    expect(describeOAuthMcpStatus(state({ accessTokenExpiresAt: Date.now() + 10 * 60_000 })))
      .toEqual({ label: 'Expires soon', tone: 'yellow' });
  });

  it('treats an already-passed expiry as expiring soon rather than reporting negative time', () => {
    expect(describeOAuthMcpStatus(state({ accessTokenExpiresAt: Date.now() - 60_000 })))
      .toEqual({ label: 'Expires soon', tone: 'yellow' });
  });

  it('says plain "Connected" when the provider issued no expiry', () => {
    expect(describeOAuthMcpStatus(state())).toEqual({ label: 'Connected', tone: 'green' });
  });

  it.each(['needs-auth', 'expired', 'error'] as const)('sends the user back to consent when %s', (status) => {
    expect(describeOAuthMcpStatus(state({ status })))
      .toEqual({ label: 'Needs re-authorization', tone: 'red' });
  });

  it('treats an absent grantType as interactive, so pre-existing servers keep their wording', () => {
    const { label } = describeOAuthMcpStatus(state({ accessTokenExpiresAt: Date.now() + 90 * 60_000 }));
    expect(label).toContain('expires in');
  });

  it('still warns on an explicit authorization_code grantType', () => {
    expect(describeOAuthMcpStatus(state({ grantType: 'authorization_code', accessTokenExpiresAt: Date.now() + 60_000 })))
      .toEqual({ label: 'Expires soon', tone: 'yellow' });
  });
});

describe('describeOAuthMcpStatus — client_credentials', () => {
  const m2m = (over: Partial<OAuthMcpState> = {}) =>
    describeOAuthMcpStatus(state({ grantType: 'client_credentials', hasRefreshToken: false, ...over }));

  it('describes the expiry as a renewal, since the plugin re-mints it unattended', () => {
    expect(m2m({ accessTokenExpiresAt: Date.now() + 24 * 60 * 60_000 }))
      .toEqual({ label: 'Connected · renews in 24h 0m', tone: 'green' });
  });

  /**
   * The case the 15-minute warning gets wrong: renewal happens 5 minutes before
   * expiry with no user involved, so a yellow dot here would nag about something
   * already in hand.
   */
  it('stays green inside the window that would warn an interactive connection', () => {
    expect(m2m({ accessTokenExpiresAt: Date.now() + 10 * 60_000 }))
      .toEqual({ label: 'Connected · renews in 0h 10m', tone: 'green' });
  });

  it('is green and connected even with no refresh token, which this grant never issues', () => {
    expect(m2m().tone).toBe('green');
    expect(m2m().label).toBe('Connected');
  });

  it.each(['needs-auth', 'expired', 'error'] as const)('asks for new credentials, not consent, when %s', (status) => {
    expect(m2m({ status })).toEqual({ label: 'Needs new credentials', tone: 'red' });
  });
});

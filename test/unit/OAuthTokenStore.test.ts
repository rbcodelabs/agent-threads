import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthTokenStore, type TokenSet } from '../../src/OAuthTokenStore';
import { secretStorageKey } from '../../src/secretUtils';

function fakeSecretStorage() {
  const store = new Map<string, string>();
  return {
    setSecret: vi.fn((id: string, secret: string) => { store.set(id, secret); }),
    getSecret: vi.fn((id: string) => store.get(id) ?? null),
    store,
  };
}

describe('OAuthTokenStore — keychain key naming', () => {
  it('writes access/refresh/expiry/clientId under OAUTH_MCP_{NAME}_* keys, normalized through secretStorageKey', () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn();
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    tokenStore.storeClientId('vercel', 'client-abc');
    tokenStore.store('vercel', { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 });

    expect(secretStorage.setSecret).toHaveBeenCalledWith(secretStorageKey('OAUTH_MCP_VERCEL_CLIENT_ID'), 'client-abc');
    expect(secretStorage.setSecret).toHaveBeenCalledWith(secretStorageKey('OAUTH_MCP_VERCEL_ACCESS_TOKEN'), 'at');
    expect(secretStorage.setSecret).toHaveBeenCalledWith(secretStorageKey('OAUTH_MCP_VERCEL_REFRESH_TOKEN'), 'rt');
    expect(secretStorage.setSecret).toHaveBeenCalledWith(secretStorageKey('OAUTH_MCP_VERCEL_EXPIRES_AT'), expect.any(String));
  });

  it('writes a client secret under OAUTH_MCP_{NAME}_CLIENT_SECRET and reads it back', () => {
    const secretStorage = fakeSecretStorage();
    const tokenStore = new OAuthTokenStore(secretStorage, vi.fn());
    tokenStore.storeClientSecret('vercel', 'shh-abc');

    expect(secretStorage.setSecret).toHaveBeenCalledWith(secretStorageKey('OAUTH_MCP_VERCEL_CLIENT_SECRET'), 'shh-abc');
    expect(tokenStore.getClientSecret('vercel')).toBe('shh-abc');
  });

  it('reports no client secret for a public client', () => {
    const tokenStore = new OAuthTokenStore(fakeSecretStorage(), vi.fn());
    tokenStore.storeClientId('vercel', 'client-abc');
    expect(tokenStore.getClientSecret('vercel')).toBeUndefined();
  });

  it('uppercases a mixed-case server name into the key', () => {
    const secretStorage = fakeSecretStorage();
    const tokenStore = new OAuthTokenStore(secretStorage, vi.fn());
    tokenStore.store('My-Server', { accessToken: 'at' });
    expect(secretStorage.setSecret).toHaveBeenCalledWith(secretStorageKey('OAUTH_MCP_MY-SERVER_ACCESS_TOKEN'), 'at');
  });
});

describe('OAuthTokenStore — getAccessToken', () => {
  it('returns the current token unchanged when far from expiry', async () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn();
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 });
    await expect(tokenStore.getAccessToken('vercel')).resolves.toBe('at-1');
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('returns null when nothing is stored', async () => {
    const tokenStore = new OAuthTokenStore(fakeSecretStorage(), vi.fn());
    await expect(tokenStore.getAccessToken('vercel')).resolves.toBeNull();
  });

  it('proactively refreshes when fewer than 5 minutes remain', async () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn(async (): Promise<TokenSet> => ({ accessToken: 'at-2', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 }));
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt', expiresAt: Date.now() + 4 * 60_000 });
    await expect(tokenStore.getAccessToken('vercel')).resolves.toBe('at-2');
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('does not refresh when near expiry but no refresh token is available', async () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn();
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    tokenStore.store('vercel', { accessToken: 'at-1', expiresAt: Date.now() + 60_000 });
    await expect(tokenStore.getAccessToken('vercel')).resolves.toBe('at-1');
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('falls back to the current access token when refresh fails', async () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn(async () => { throw new Error('AS unreachable'); });
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt', expiresAt: Date.now() + 60_000 });
    await expect(tokenStore.getAccessToken('vercel')).resolves.toBe('at-1');
  });

  /**
   * The client_credentials grant has no refresh token by construction (RFC 6749
   * §4.4.3), so the guard above would hand back an expired token forever. The
   * third constructor argument opts such a server back into renewal, which
   * re-mints from the client's own credentials instead.
   */
  it('renews near expiry with no refresh token when the grant can re-mint from client credentials', async () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn(async (): Promise<TokenSet> => ({ accessToken: 'at-2', expiresAt: Date.now() + 86_400_000 }));
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn, (name) => name === 'bankrate');
    tokenStore.store('bankrate', { accessToken: 'at-1', expiresAt: Date.now() + 60_000 });
    await expect(tokenStore.getAccessToken('bankrate')).resolves.toBe('at-2');
    expect(refreshFn).toHaveBeenCalledWith('bankrate');
  });

  it('applies the opt-in per server name, so a sibling authorization_code server still short-circuits', async () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn(async (): Promise<TokenSet> => ({ accessToken: 'at-2', expiresAt: Date.now() + 86_400_000 }));
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn, (name) => name === 'bankrate');
    tokenStore.store('vercel', { accessToken: 'at-1', expiresAt: Date.now() + 60_000 });
    await expect(tokenStore.getAccessToken('vercel')).resolves.toBe('at-1');
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('defaults to not renewing without a refresh token when the hook is omitted', async () => {
    const refreshFn = vi.fn();
    const tokenStore = new OAuthTokenStore(fakeSecretStorage(), refreshFn);
    tokenStore.store('vercel', { accessToken: 'at-1', expiresAt: Date.now() + 60_000 });
    await expect(tokenStore.getAccessToken('vercel')).resolves.toBe('at-1');
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('dedups concurrent refresh calls into a single refreshFn invocation', async () => {
    const secretStorage = fakeSecretStorage();
    let resolveRefresh!: (tokens: TokenSet) => void;
    const refreshFn = vi.fn(() => new Promise<TokenSet>((resolve) => { resolveRefresh = resolve; }));
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt', expiresAt: Date.now() + 60_000 });

    const first = tokenStore.getAccessToken('vercel');
    const second = tokenStore.getAccessToken('vercel');
    expect(refreshFn).toHaveBeenCalledTimes(1);
    resolveRefresh({ accessToken: 'at-2', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 });
    expect(await first).toBe('at-2');
    expect(await second).toBe('at-2');
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });
});

describe('OAuthTokenStore — scheduled refresh timing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('schedules the refresh for expires_in - 300 seconds, not before and not much after', async () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn(async (): Promise<TokenSet> => ({ accessToken: 'at-2', expiresAt: Date.now() + 3600_000 }));
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    const expiresInMs = 20 * 60_000; // expires_in = 1200s
    tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt', expiresAt: Date.now() + expiresInMs });

    // (expires_in - 300)s = 900s = 15 minutes.
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1000);
    expect(refreshFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('re-scheduling replaces a still-pending timer instead of stacking another one', async () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn(async (): Promise<TokenSet> => ({ accessToken: 'at-2', expiresAt: Date.now() + 3600_000 }));
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt', expiresAt: Date.now() + 20 * 60_000 });
    tokenStore.scheduleRefresh('vercel', Date.now() + 20 * 60_000);

    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1000);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('does not schedule a background timer for a token whose lifetime never exceeds the proactive window', async () => {
    // Regression test: a token with expires_in <= 300s used to make store()/scheduleRefresh()
    // compute delayMs=0 forever — refresh() resolves, its (equally short-lived) result is handed
    // straight back to store(), which reschedules at 0ms again, and so on. This hammered the AS's
    // token endpoint continuously and raced real proxy requests (a request's just-fetched access
    // token could be rotated out from under it by this background loop before the HTTP forward
    // even completed), observed as a real, load-dependent 401 flake in the integration suite.
    // getAccessToken()'s own near-expiry check already covers refreshing such a token on access,
    // so scheduleRefresh() should simply decline to arm a timer for it.
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn(async (): Promise<TokenSet> => ({ accessToken: 'at-2', refreshToken: 'rt', expiresAt: Date.now() + 2000 }));
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);

    // expires_in = 2s, far inside the 5-minute proactive window.
    tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt', expiresAt: Date.now() + 2000 });

    // If the old bug were present, a 0ms timer would already have fired (and rescheduled itself)
    // well within this window; advancing a generous few seconds of fake time with no external
    // getAccessToken() call must produce zero refreshFn invocations.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('does not schedule when expiresAt has already passed', async () => {
    const secretStorage = fakeSecretStorage();
    const refreshFn = vi.fn(async (): Promise<TokenSet> => ({ accessToken: 'at-2', expiresAt: Date.now() + 3600_000 }));
    const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
    tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt', expiresAt: Date.now() - 1000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshFn).not.toHaveBeenCalled();
  });
});

describe('OAuthTokenStore — clear', () => {
  it('blanks every keychain field and cancels the scheduled refresh', () => {
    vi.useFakeTimers();
    try {
      const secretStorage = fakeSecretStorage();
      const refreshFn = vi.fn(async (): Promise<TokenSet> => ({ accessToken: 'at-2' }));
      const tokenStore = new OAuthTokenStore(secretStorage, refreshFn);
      tokenStore.storeClientId('vercel', 'client-abc');
      tokenStore.store('vercel', { accessToken: 'at-1', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 });

      tokenStore.clear('vercel');

      expect(tokenStore.getCurrentTokens('vercel')).toBeUndefined();
      expect(tokenStore.getClientId('vercel')).toBeUndefined();

      vi.advanceTimersByTime(3600_000);
      expect(refreshFn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('wipes the client secret too, so disconnect leaves no confidential credential behind', () => {
    const secretStorage = fakeSecretStorage();
    const tokenStore = new OAuthTokenStore(secretStorage, vi.fn());
    tokenStore.storeClientId('vercel', 'client-abc');
    tokenStore.storeClientSecret('vercel', 'shh-abc');

    tokenStore.clear('vercel');

    expect(tokenStore.getClientSecret('vercel')).toBeUndefined();
    expect(secretStorage.store.get(secretStorageKey('OAUTH_MCP_VERCEL_CLIENT_SECRET'))).toBe('');
  });

  it('is a safe no-op for a server that was never stored', () => {
    const tokenStore = new OAuthTokenStore(fakeSecretStorage(), vi.fn());
    expect(() => tokenStore.clear('ghost')).not.toThrow();
  });
});

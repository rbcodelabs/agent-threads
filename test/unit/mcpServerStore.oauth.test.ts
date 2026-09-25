import { describe, expect, it } from 'vitest';
import { clientSecretVariableName, mcpRegistrationSchema } from '../../src/mcpServerStore';

const base = { name: 'vercel', type: 'oauth' as const, url: 'https://mcp.vercel.com/' };

describe('mcpRegistrationSchema — oauth type', () => {
  it('accepts a minimal oauth entry', () => {
    const result = mcpRegistrationSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it('accepts scopes, an allow list, clientId and authorizationServerUrl overrides', () => {
    const result = mcpRegistrationSchema.safeParse({
      ...base,
      scopes: 'openid profile email',
      tools: { allow: ['list_projects', 'get_deployment'] },
      clientId: 'known-public-client',
      authorizationServerUrl: 'https://vercel.com/.well-known/oauth-authorization-server',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a loopback redirectUri on an oauth entry', () => {
    // Slack's real registered value — see slack-mcp-plugin's .mcp.json.
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectUri: 'http://localhost:3118/callback' }).success).toBe(true);
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectUri: 'http://127.0.0.1:3118/callback' }).success).toBe(true);
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectUri: 'http://[::1]:3118/callback' }).success).toBe(true);
    // A non-/callback path is allowed — providers do not all agree on it.
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectUri: 'http://localhost:3118/oauth/cb' }).success).toBe(true);
  });

  it('rejects a redirectUri that is not a valid absolute URL', () => {
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectUri: 'not a url' }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectUri: '/callback' }).success).toBe(false);
  });

  it('rejects a non-http redirectUri scheme, including https the callback server cannot serve', () => {
    for (const redirectUri of ['https://localhost:3118/callback', 'ftp://localhost:3118/callback', 'file:///callback']) {
      const result = mcpRegistrationSchema.safeParse({ ...base, redirectUri });
      expect(result.success).toBe(false);
    }
  });

  /**
   * The security-critical rule: this URI decides both where the authorization
   * code is delivered and which interface we bind a listener to.
   */
  it('rejects a non-loopback redirectUri host, including 0.0.0.0 and LAN/public hosts', () => {
    for (const redirectUri of [
      'http://0.0.0.0:3118/callback',
      'http://192.168.1.50:3118/callback',
      'http://evil.example.com:3118/callback',
      'http://169.254.169.254:80/callback',
      'http://localhost.evil.com:3118/callback',
    ]) {
      const result = mcpRegistrationSchema.safeParse({ ...base, redirectUri });
      expect(result.success, `expected ${redirectUri} to be rejected`).toBe(false);
    }
  });

  it('rejects a redirectUri with embedded credentials', () => {
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectUri: 'http://user:pw@localhost:3118/callback' }).success).toBe(false);
  });

  it('rejects a redirectUri carrying a query string or fragment, which would collide with code/state', () => {
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectUri: 'http://localhost:3118/callback?foo=bar' }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectUri: 'http://localhost:3118/callback#frag' }).success).toBe(false);
  });

  it('rejects a redirectUri with no explicit port', () => {
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectUri: 'http://localhost/callback' }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectUri: 'http://127.0.0.1/callback' }).success).toBe(false);
  });

  it('rejects redirectUri on a non-oauth entry', () => {
    const redirectUri = 'http://localhost:3118/callback';
    expect(mcpRegistrationSchema.safeParse({ name: 'x', type: 'stdio', command: 'npx', redirectUri }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ name: 'x', type: 'http', url: 'https://x.test', redirectUri }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ name: 'x', type: 'sse', url: 'https://x.test', redirectUri }).success).toBe(false);
  });

  /**
   * Tool-call arguments are recorded verbatim in the thread transcript and the raw
   * JSONL log, so a literal secret typed by an agent would be persisted in plain
   * text. Only a `${NAME}` reference to an already-stored keychain secret passes.
   */
  it('accepts a ${NAME} placeholder clientSecret and rejects a literal one', () => {
    expect(mcpRegistrationSchema.safeParse({ ...base, clientSecret: '${VERCEL_CLIENT_SECRET}' }).success).toBe(true);

    for (const clientSecret of ['sk-live-abc123', 'VERCEL_CLIENT_SECRET', '${TWO} ${VARS}', 'prefix-${VAR}', '${lower ok but spaces not}']) {
      const result = mcpRegistrationSchema.safeParse({ ...base, clientSecret });
      expect(result.success, `expected ${clientSecret} to be rejected`).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(i => i.message.includes('placeholder'))).toBe(true);
      }
    }
  });

  it('rejects clientSecret on a non-oauth entry', () => {
    const clientSecret = '${SOME_SECRET}';
    expect(mcpRegistrationSchema.safeParse({ name: 'x', type: 'stdio', command: 'npx', clientSecret }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ name: 'x', type: 'http', url: 'https://x.test', clientSecret }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ name: 'x', type: 'sse', url: 'https://x.test', clientSecret }).success).toBe(false);
  });

  it('accepts a client_credentials entry with a clientId, audience and placeholder secret', () => {
    const result = mcpRegistrationSchema.safeParse({
      ...base,
      grantType: 'client_credentials',
      clientId: 'reTmVHKuhRrGiXOo3lqvS4zMUxagdXZC',
      clientSecret: '${OAUTH_MCP_BANKRATE_CLIENT_SECRET}',
      audience: 'bankrate-api',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an explicit authorization_code grantType, the default', () => {
    expect(mcpRegistrationSchema.safeParse({ ...base, grantType: 'authorization_code' }).success).toBe(true);
  });

  it('rejects an unknown grantType', () => {
    for (const grantType of ['password', 'implicit', 'refresh_token', 'client-credentials', '']) {
      expect(mcpRegistrationSchema.safeParse({ ...base, grantType }).success, grantType).toBe(false);
    }
  });

  /**
   * There is no browser leg, so no dynamic-registration round trip either: the
   * client has to already exist at the AS and be named here.
   */
  it('rejects a client_credentials entry with no clientId', () => {
    const result = mcpRegistrationSchema.safeParse({
      ...base, grantType: 'client_credentials', clientSecret: '${SOME_SECRET}',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'clientId')).toBe(true);
    }
  });

  /**
   * Nothing redirects anywhere in a machine-to-machine grant, so accepting a
   * redirectUri would imply a callback that is never registered nor listened on.
   */
  it('rejects a redirectUri on a client_credentials entry', () => {
    const result = mcpRegistrationSchema.safeParse({
      ...base,
      grantType: 'client_credentials',
      clientId: 'm2m',
      clientSecret: '${SOME_SECRET}',
      redirectUri: 'http://localhost:3118/callback',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.path.join('.') === 'redirectUri')).toBe(true);
    }
  });

  /**
   * The schema deliberately does not require a clientSecret here — the Settings
   * modal keeps the typed literal out of the entry it validates, so a rule here
   * would make the schema unsatisfiable from the UI. `registerServer()` enforces
   * it instead, at the one point that holds the resolved literal.
   */
  it('accepts a client_credentials entry with no clientSecret, leaving that rule to registerServer', () => {
    expect(mcpRegistrationSchema.safeParse({
      ...base, grantType: 'client_credentials', clientId: 'm2m',
    }).success).toBe(true);
  });

  it('still rejects a literal clientSecret under the client_credentials grant', () => {
    const result = mcpRegistrationSchema.safeParse({
      ...base, grantType: 'client_credentials', clientId: 'm2m', clientSecret: 'sk-live-abc123',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('placeholder'))).toBe(true);
    }
  });

  it('rejects grantType and audience on non-oauth entries', () => {
    expect(mcpRegistrationSchema.safeParse({ name: 'x', type: 'stdio', command: 'npx', grantType: 'client_credentials' }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ name: 'x', type: 'http', url: 'https://x.test', grantType: 'authorization_code' }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ name: 'x', type: 'sse', url: 'https://x.test', audience: 'bankrate-api' }).success).toBe(false);
  });

  it('rejects a blank audience rather than sending an empty parameter', () => {
    expect(mcpRegistrationSchema.safeParse({ ...base, audience: '' }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ ...base, audience: '   ' }).success).toBe(false);
  });

  it('accepts a bare audience on an authorization_code entry — some providers want it there too', () => {
    expect(mcpRegistrationSchema.safeParse({ ...base, audience: 'bankrate-api' }).success).toBe(true);
  });

  it('accepts a deny list', () => {
    const result = mcpRegistrationSchema.safeParse({ ...base, tools: { deny: ['buy_pro', 'buy_credits'] } });
    expect(result.success).toBe(true);
  });

  it('rejects tools.allow and tools.deny set together', () => {
    const result = mcpRegistrationSchema.safeParse({ ...base, tools: { allow: ['a'], deny: ['b'] } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('mutually exclusive'))).toBe(true);
    }
  });

  it('rejects a missing url', () => {
    expect(mcpRegistrationSchema.safeParse({ name: 'vercel', type: 'oauth' }).success).toBe(false);
  });

  it('rejects a non-https url', () => {
    expect(mcpRegistrationSchema.safeParse({ ...base, url: 'http://mcp.vercel.com/' }).success).toBe(false);
  });

  it('rejects a url with embedded credentials', () => {
    expect(mcpRegistrationSchema.safeParse({ ...base, url: 'https://user:pass@mcp.vercel.com/' }).success).toBe(false);
  });

  it('rejects stdio/http/sse fields on an oauth entry', () => {
    expect(mcpRegistrationSchema.safeParse({ ...base, command: 'npx' }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ ...base, args: ['-y'] }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ ...base, env: { X: 'y' } }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ ...base, headers: { 'x-api-key': '${KEY}' } }).success).toBe(false);
  });

  it('rejects a non-https authorizationServerUrl override', () => {
    expect(mcpRegistrationSchema.safeParse({ ...base, authorizationServerUrl: 'http://vercel.com/as' }).success).toBe(false);
  });

  it('rejects oauth-only fields on stdio/http/sse entries', () => {
    expect(mcpRegistrationSchema.safeParse({ name: 'x', type: 'stdio', command: 'npx', scopes: 'a b' }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ name: 'x', type: 'http', url: 'https://x.test', tools: { allow: ['a'] } }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ name: 'x', type: 'sse', url: 'https://x.test', clientId: 'c' }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ name: 'x', type: 'http', url: 'https://x.test', authorizationServerUrl: 'https://as.test' }).success).toBe(false);
  });

  it('still applies the credential-placeholder check to http/sse header values, unaffected by the oauth branch', () => {
    expect(mcpRegistrationSchema.safeParse({
      name: 'remote', type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer raw-secret' },
    }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({
      name: 'remote', type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer ${TOKEN}' },
    }).success).toBe(true);
  });

  it('rejects unknown extra keys (still .strict())', () => {
    expect(mcpRegistrationSchema.safeParse({ ...base, extra: 'nope' }).success).toBe(false);
  });
});

describe('clientSecretVariableName', () => {
  it('extracts the variable name the placeholder refers to', () => {
    expect(clientSecretVariableName('${VERCEL_CLIENT_SECRET}')).toBe('VERCEL_CLIENT_SECRET');
  });

  it('returns undefined for an absent clientSecret, so a public client stays public', () => {
    expect(clientSecretVariableName(undefined)).toBeUndefined();
  });

  it('returns undefined for anything that is not a bare placeholder', () => {
    for (const value of ['literal-secret', 'Bearer ${TOKEN}', '${}', '']) {
      expect(clientSecretVariableName(value), value).toBeUndefined();
    }
  });
});

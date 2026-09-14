import { describe, expect, it } from 'vitest';
import { mcpRegistrationSchema } from '../../src/mcpServerStore';

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

  it('accepts a valid redirectPort on an oauth entry', () => {
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectPort: 3118 }).success).toBe(true);
  });

  it('rejects an out-of-range redirectPort', () => {
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectPort: 0 }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectPort: 65536 }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectPort: -1 }).success).toBe(false);
  });

  it('rejects a non-integer redirectPort', () => {
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectPort: 3118.5 }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ ...base, redirectPort: '3118' }).success).toBe(false);
  });

  it('rejects redirectPort on a non-oauth entry', () => {
    expect(mcpRegistrationSchema.safeParse({ name: 'x', type: 'stdio', command: 'npx', redirectPort: 3118 }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ name: 'x', type: 'http', url: 'https://x.test', redirectPort: 3118 }).success).toBe(false);
    expect(mcpRegistrationSchema.safeParse({ name: 'x', type: 'sse', url: 'https://x.test', redirectPort: 3118 }).success).toBe(false);
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

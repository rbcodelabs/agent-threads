import { describe, expect, it, vi } from 'vitest';
import { runProbe } from '../../scripts/probe-google-docs-mcp.mjs';

const args = ['--settings-file', '/synthetic/data.json', '--auth-proxy-url', 'https://auth.example.com', '--document-id', 'synthetic-doc'];
const settings = { authProxyUrl: 'https://auth.example.com', tokens: { accessToken: 'SECRET_ACCESS', refreshToken: 'SECRET_REFRESH', expiresAt: 9999999999999 } };
const response = (result: unknown, status = 200) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status });
function fixture(replies: Response[], config = settings) {
  const output: string[] = [];
  const fetch = vi.fn(async () => replies.shift()!);
  return { fetch, output, options: { fetch, readFile: async () => JSON.stringify(config), log: (line: string) => output.push(line) } };
}
const init = () => response({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'docs', version: '1' } });
const notification = () => new Response(null, { status: 202 });
const listed = () => response({ tools: [{ name: 'read_doc' }, { name: 'update_doc' }] });

describe('Google Docs MCP probe', () => {
  it('reads only the supplied document and never prints credentials or content', async () => {
    const f = fixture([init(), notification(), listed(), response({ content: [{ type: 'text', text: 'PRIVATE_DOCUMENT' }] })]);
    expect(await runProbe(args, f.options)).toBe(0);
    const calls = f.fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([, request]) => JSON.parse(request.body as string).method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    expect(JSON.parse(calls[3][1].body as string).params).toEqual({ name: 'read_doc', arguments: { documentId: 'synthetic-doc' } });
    expect(calls.every(([url, request]) => url === 'https://docsmcp.googleapis.com/mcp/v1' && request.redirect === 'error' && request.signal)).toBe(true);
    expect(f.output.join('\n')).toContain('read_doc: PASS');
    expect(f.output.join('\n')).not.toMatch(/SECRET|PRIVATE_DOCUMENT/);
  });
  it('refreshes expired credentials only through the explicitly matched proxy', async () => {
    const f = fixture([new Response(JSON.stringify({ access_token: 'SECRET_NEW' })), init(), notification(), listed(), response({ content: [] })], { ...settings, tokens: { ...settings.tokens, expiresAt: 0 } });
    expect(await runProbe(args, f.options)).toBe(0);
    expect(f.fetch).toHaveBeenNthCalledWith(1, 'https://auth.example.com/api/auth/refresh', expect.objectContaining({ redirect: 'error', body: JSON.stringify({ refresh_token: 'SECRET_REFRESH' }) }));
    expect(f.output.join('\n')).not.toContain('SECRET');
  });
  it.each(['https://other.example.com', 'http://auth.example.com', 'https://user:password@auth.example.com'])('rejects an unsafe or mismatched proxy %s before network calls', async (url) => {
    const f = fixture([]);
    expect(await runProbe(args.map(value => value === 'https://auth.example.com' ? url : value), f.options)).toBe(1);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([
    [response({ isError: true, content: [{ text: 'SECRET: enroll in Google Workspace Developer Preview Program' }] }), 'developer-preview'],
    [response({ isError: true, content: [{ text: 'SECRET: API has not been used or is disabled' }] }, 403), 'api-disabled'],
    [new Response(JSON.stringify({ error: { message: 'SECRET invalid credentials' } }), { status: 401 }), 'authentication'],
    [new Response(JSON.stringify({ error: { code: -32603, message: 'SECRET_OTHER' } })), 'upstream-error'],
    [new Response('<html>SECRET_OTHER</html>'), 'invalid-response'],
  ])('fails safely for HTTP, JSON-RPC, and tool errors', async (failure, classification) => {
    const f = fixture([init(), notification(), listed(), failure as Response]);
    expect(await runProbe(args, f.options)).toBe(1);
    expect(f.output.join('\n')).toContain(classification);
    expect(f.output.join('\n')).not.toContain('SECRET');
  });
  it('sanitizes thrown errors including timeout details', async () => {
    const f = fixture([]);
    f.fetch.mockRejectedValue(new DOMException('SECRET_TIMEOUT', 'TimeoutError'));
    expect(await runProbe(args, f.options)).toBe(1);
    expect(f.output.join('\n')).toContain('timeout');
    expect(f.output.join('\n')).not.toContain('SECRET');
  });
  it('requires an explicit document before accessing saved credentials', async () => {
    const readFile = vi.fn();
    expect(await runProbe(args.slice(0, -2), { readFile, log: () => {} })).toBe(1);
    expect(readFile).not.toHaveBeenCalled();
  });
});

#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const endpoint = 'https://docsmcp.googleapis.com/mcp/v1';
const protocol = '2025-03-26';
const usage = 'Usage: node scripts/probe-google-docs-mcp.mjs --settings-file PATH --auth-proxy-url https://auth.example.com --document-id DOCUMENT_ID';

class ProbeError extends Error {
  constructor(category) { super(category); this.category = category; }
}

function proxyUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ProbeError('invalid-auth-proxy');
  }
  return url.origin;
}

function classify(status, payload) {
  // Only inspect upstream text for fixed categories. Never log it: even errors can contain secrets.
  const text = JSON.stringify(payload).toLowerCase();
  if (/developer preview|developer-preview/.test(text)) return 'developer-preview';
  if (/service_disabled|api.*(?:disabled|not been used)/.test(text)) return 'api-disabled';
  if (status === 401 || /invalid_grant|invalid credentials|unauthenticated/.test(text)) return 'authentication';
  if (status === 403 || /permission_denied|permission denied|insufficient.*scope/.test(text)) return 'permission-or-scope';
  return 'upstream-error';
}

export async function runProbe(argv, dependencies = {}) {
  const fetchRequest = dependencies.fetch ?? globalThis.fetch;
  const read = dependencies.readFile ?? readFile;
  const log = dependencies.log ?? console.log;
  let phase = 'configuration';
  try {
    if (argv.length === 1 && argv[0] === '--help') { log(usage); return 0; }
    const options = {};
    for (let i = 0; i < argv.length; i += 2) {
      const key = argv[i];
      if (!['--settings-file', '--auth-proxy-url', '--document-id'].includes(key) || !argv[i + 1] || options[key]) {
        throw new ProbeError('invalid-arguments');
      }
      options[key] = argv[i + 1];
    }
    if (!options['--settings-file'] || !options['--auth-proxy-url'] || !/^[A-Za-z0-9_-]+$/.test(options['--document-id'] ?? '')) {
      throw new ProbeError('invalid-arguments');
    }
    const expectedProxy = proxyUrl(options['--auth-proxy-url']);
    const settings = JSON.parse(await read(options['--settings-file'], 'utf8'));
    if (proxyUrl(settings.authProxyUrl) !== expectedProxy) throw new ProbeError('auth-proxy-mismatch');
    const tokens = settings.tokens;
    if (!tokens || typeof tokens !== 'object') throw new ProbeError('missing-credentials');
    log('configuration: PASS');

    async function post(url, body, headers = {}, notification = false) {
      const response = await fetchRequest(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(body),
      });
      if (notification && response.ok && (response.status === 202 || response.status === 204)) return;
      let payload;
      try { payload = await response.json(); } catch { throw new ProbeError('invalid-response'); }
      if (!response.ok || payload?.error || payload?.result?.isError) throw new ProbeError(classify(response.status, payload));
      return payload;
    }

    phase = 'authentication';
    let accessToken = tokens.accessToken;
    if (typeof accessToken !== 'string' || !accessToken || !Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= Date.now() + 60_000) {
      if (typeof tokens.refreshToken !== 'string' || !tokens.refreshToken) throw new ProbeError('missing-credentials');
      const refreshed = await post(`${expectedProxy}/api/auth/refresh`, { refresh_token: tokens.refreshToken });
      accessToken = refreshed?.access_token;
      if (typeof accessToken !== 'string' || !accessToken) throw new ProbeError('invalid-refresh-response');
      log('authentication: PASS (refreshed in memory)');
    } else {
      log('authentication: PASS (cached token selected; Google validates it next)');
    }
    let id = 0;
    const headers = { Authorization: `Bearer ${accessToken}`, 'MCP-Protocol-Version': protocol };
    async function rpc(method, params) {
      const result = await post(endpoint, { jsonrpc: '2.0', id: ++id, method, params }, headers);
      if (!result || result.jsonrpc !== '2.0' || !result.result || typeof result.result !== 'object') throw new ProbeError('invalid-response');
      return result.result;
    }
    phase = 'initialize';
    const initialized = await rpc('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'google-docs-connectivity-probe', version: '1.0.0' } });
    if (initialized.protocolVersion !== protocol) throw new ProbeError('unsupported-protocol');
    await post(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers, true);
    log('initialize: PASS');
    phase = 'tools/list';
    const listed = await rpc('tools/list', {});
    if (!Array.isArray(listed.tools) || !listed.tools.some(tool => tool.name === 'read_doc')) throw new ProbeError('read-tool-unavailable');
    log('tools/list: PASS (read_doc available)');
    phase = 'read_doc';
    const result = await rpc('tools/call', { name: 'read_doc', arguments: { documentId: options['--document-id'] } });
    if (!Array.isArray(result.content)) throw new ProbeError('invalid-response');
    log('read_doc: PASS (response received; document content omitted)');
    return 0;
  } catch (error) {
    const category = error instanceof ProbeError ? error.category : error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : phase === 'configuration' ? 'invalid-configuration' : 'network-error';
    log(`${phase}: FAIL (${category})`);
    if (category === 'invalid-arguments') log(usage);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runProbe(process.argv.slice(2));
}

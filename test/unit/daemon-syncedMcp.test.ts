import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDaemonMcpServers } from '../../daemon/mcpServers';
import { SyncedMcpStore, hashMcpDefinition, mergeDaemonMcpServers, policyViolation, type SyncedMcpPolicy } from '../../daemon/syncedMcp';
import { placeholdersOf, validateSyncedMcpShape, canonicalJson } from '../../src/protocol/mcpSync';
import { resolveConfig } from '../../daemon/config';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'synced-mcp-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const OPEN: SyncedMcpPolicy = { allowStdio: true, commandAllowlist: [] };
const HTTP = { type: 'http', url: 'https://docs.example.test/mcp', headers: { Authorization: 'Bearer ${mcpsync-proj.DOCS_TOKEN}' } };
const STDIO = { command: 'npx', args: ['-y', 'srv'], env: { API_KEY: '${mcpsync-proj.TOOLS_KEY}' } };

describe('SyncedMcpStore.replace', () => {
  it('stores definitions with placeholders unresolved, 0600, per-server syncedBy and hash', () => {
    const store = new SyncedMcpStore(dir, OPEN, () => 1000);
    const r = store.replace({ docs: HTTP, tools: STDIO }, 'tok-1');
    expect(r.accepted.sort()).toEqual(['docs', 'tools']);
    expect(r.rejected).toEqual([]);
    expect(r.requiredCreds).toEqual(['mcpsync-proj.DOCS_TOKEN', 'mcpsync-proj.TOOLS_KEY']);
    expect(r.added.sort()).toEqual(['docs', 'tools']);
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(store.file, 'utf8'));
    expect(onDisk.servers.docs).toMatchObject({ syncedBy: 'tok-1', syncedAt: 1000, hash: hashMcpDefinition(onDisk.servers.docs.def) });
    expect(onDisk.servers.docs.def.headers.Authorization).toBe('Bearer ${mcpsync-proj.DOCS_TOKEN}');
  });

  it('is a full replace: absent names are removed and reported', () => {
    const store = new SyncedMcpStore(dir, OPEN);
    store.replace({ docs: HTTP, tools: STDIO }, 't');
    const r = store.replace({ docs: HTTP }, 't');
    expect(r.removed).toEqual(['tools']);
    expect(r.added).toEqual([]);
    expect(Object.keys(store.records())).toEqual(['docs']);
    expect(store.replace({}, 't').removed).toEqual(['docs']);
  });

  it('rejects an invalid or reserved definition by name without stopping the others', () => {
    const store = new SyncedMcpStore(dir, OPEN);
    const r = store.replace({ ok: HTTP, claude_threads: HTTP, bad: { type: 'http' }, 'a b': HTTP }, 't');
    expect(r.accepted).toEqual(['ok']);
    expect(r.rejected.map((x) => x.name).sort()).toEqual(['a b', 'bad', 'claude_threads']);
    expect(r.rejected.find((x) => x.name === 'bad')!.reason).toMatch(/url/);
    expect(r.rejected.find((x) => x.name === 'claude_threads')!.reason).toMatch(/reserved/);
  });

  it('keeps the previous set, untouched on disk, when the request is non-empty and nothing is accepted', () => {
    const store = new SyncedMcpStore(dir, OPEN, () => 1000);
    store.replace({ docs: HTTP, tools: STDIO }, 't');
    const before = readFileSync(store.file, 'utf8');
    const mtime = statSync(store.file).mtimeMs;
    const r = store.replace({ docs: { type: 'http' }, tools: { command: 'x', args: ['${NOPE}'], env: { K: '${bare}' } }, claude_threads: HTTP }, 'other-token');
    expect(r).toMatchObject({ kept: true, accepted: [], added: [], removed: [], requiredCreds: [], shadowed: [] });
    expect(r.rejected.map((x) => x.name).sort()).toEqual(['claude_threads', 'docs', 'tools']);
    expect(readFileSync(store.file, 'utf8')).toBe(before);
    expect(statSync(store.file).mtimeMs).toBe(mtime);
    expect(Object.keys(store.records()).sort()).toEqual(['docs', 'tools']);
  });

  it('keeps the set when the operator turned allowSyncedStdio off and only stdio servers are sent', () => {
    new SyncedMcpStore(dir, OPEN).replace({ tools: STDIO }, 't');
    const strict = new SyncedMcpStore(dir, { allowStdio: false, commandAllowlist: [] });
    const r = strict.replace({ tools: STDIO }, 't');
    expect(r.kept).toBe(true);
    expect(r.rejected[0].reason).toMatch(/allowSyncedStdio/);
    expect(Object.keys(strict.records())).toEqual(['tools']); // stored, though active() will not start it
    expect(strict.active()).toEqual({});
  });

  it('does not report kept for a clear, a first sync that is all rejected, or a partial rejection', () => {
    const store = new SyncedMcpStore(dir, OPEN);
    expect(store.replace({ bad: { type: 'http' } }, 't')).toMatchObject({ kept: true }); // nothing stored yet: still kept (empty), no file written
    expect(existsSync(store.file)).toBe(false);
    store.replace({ docs: HTTP }, 't');
    expect(store.replace({}, 't')).toMatchObject({ removed: ['docs'] });
    expect(store.replace({}, 't').kept).toBeUndefined();
    store.replace({ docs: HTTP, tools: STDIO }, 't');
    expect(store.replace({ docs: HTTP, tools: { command: 'x', env: { K: '${bare}' } } }, 't').kept).toBeUndefined();
  });

  it('on partial rejection a previously synced name that is rejected now is dropped, not kept at its old definition', () => {
    const store = new SyncedMcpStore(dir, OPEN);
    store.replace({ docs: HTTP, tools: STDIO }, 't');
    const r = store.replace({ docs: HTTP, tools: { command: 'x', env: { K: '${bare}' } } }, 't');
    expect(r).toMatchObject({ accepted: ['docs'], removed: ['tools'] });
    expect(Object.keys(store.records())).toEqual(['docs']);
  });

  it('drops a previously stored name that is rejected now', () => {
    const store = new SyncedMcpStore(dir, OPEN);
    store.replace({ x: HTTP, y: HTTP }, 't');
    const r = store.replace({ x: { type: 'http' }, y: HTTP }, 't');
    expect(r.removed).toEqual(['x']);
    expect(Object.keys(store.records())).toEqual(['y']);
  });

  it('keeps syncedAt when the definition is unchanged', () => {
    let t = 1;
    const store = new SyncedMcpStore(dir, OPEN, () => t);
    store.replace({ docs: HTTP }, 'a');
    t = 99;
    store.replace({ docs: HTTP }, 'b');
    expect(store.records().docs.syncedAt).toBe(1);
    expect(store.records().docs.syncedBy).toBe('b');
  });

  it('reports a config.json name as shadowed but still stores it', () => {
    const store = new SyncedMcpStore(dir, OPEN);
    const r = store.replace({ docs: HTTP, other: HTTP }, 't', new Set(['docs']));
    expect(r.shadowed).toEqual(['docs']);
    expect(r.accepted.sort()).toEqual(['docs', 'other']);
  });

  it('reads a missing or damaged file as empty', () => {
    const store = new SyncedMcpStore(dir, OPEN);
    expect(store.records()).toEqual({});
    writeFileSync(store.file, '{not json');
    expect(store.records()).toEqual({});
    expect(store.active()).toEqual({});
  });
});

describe('policy: stdio and command allowlist', () => {
  it('rejects stdio with a named reason when allowSyncedStdio is off, accepts http', () => {
    const store = new SyncedMcpStore(dir, { allowStdio: false, commandAllowlist: [] });
    const r = store.replace({ docs: HTTP, tools: STDIO }, 't');
    expect(r.accepted).toEqual(['docs']);
    expect(r.rejected).toEqual([{ name: 'tools', reason: expect.stringContaining('allowSyncedStdio') }]);
  });

  it('applies the allowlist: a bare name matches a bare command, an absolute path only itself', () => {
    const policy: SyncedMcpPolicy = { allowStdio: true, commandAllowlist: ['npx', '/opt/bin/tool'] };
    const ok = (command: string) => policyViolation({ type: 'stdio', command }, policy);
    expect(ok('npx')).toBeUndefined();
    expect(ok('/opt/bin/tool')).toBeUndefined();
    expect(ok('/tmp/evil/npx')).toMatch(/allowlist/);
    expect(ok('./npx')).toMatch(/allowlist/);
    expect(ok('tool')).toMatch(/allowlist/);
  });

  it('refuses a placeholder inside the command (it would bypass the allowlist)', () => {
    expect(policyViolation({ type: 'stdio', command: '${mcpsync-p.CMD}' }, OPEN)).toMatch(/command/);
  });

  it('only lets a synced server read mcpsync-<project> credentials by their qualified name', () => {
    for (const bad of ['${GH_TOKEN}', '${github.GH_TOKEN}', '${sessenv-p.KEY}', '${mcp.DOCS_TOKEN}']) {
      expect(policyViolation({ type: 'http', url: `https://x.test/${bad}` }, OPEN), bad).toMatch(/mcpsync-<project>/);
    }
    expect(policyViolation({ type: 'http', url: 'https://x.test/${mcpsync-p.KEY}' }, OPEN)).toBeUndefined();
  });

  it('active() re-applies the current policy to what was stored under an older one', () => {
    new SyncedMcpStore(dir, OPEN).replace({ docs: HTTP, tools: STDIO }, 't');
    expect(Object.keys(new SyncedMcpStore(dir, { allowStdio: false, commandAllowlist: [] }).active())).toEqual(['docs']);
    expect(Object.keys(new SyncedMcpStore(dir, { allowStdio: true, commandAllowlist: ['other'] }).active())).toEqual(['docs']);
    expect(Object.keys(new SyncedMcpStore(dir, OPEN).active()).sort()).toEqual(['docs', 'tools']);
  });
});

describe('precedence and resolution', () => {
  it('config.json replaces a synced server of the same name; the rest merge', () => {
    const synced = { docs: { type: 'http' as const, url: 'https://synced.test' }, extra: { type: 'http' as const, url: 'https://extra.test' } };
    const configured = { docs: { type: 'http' as const, url: 'https://operator.test' } };
    const m = mergeDaemonMcpServers(synced, configured);
    expect(m.servers).toEqual({ docs: configured.docs, extra: synced.extra });
    expect(m.shadowed).toEqual(['docs']);
  });

  it('resolves qualified placeholders per project, so one project cannot read another\'s field', () => {
    const lookup = (n: string) => ({ 'mcpsync-a.TOKEN': 'secret-a' } as Record<string, string>)[n];
    const out = resolveDaemonMcpServers({
      a: { type: 'http', url: 'https://a.test', headers: { H: '${mcpsync-a.TOKEN}' } },
      b: { type: 'http', url: 'https://b.test', headers: { H: '${mcpsync-b.TOKEN}' } },
    }, lookup);
    expect(out.servers).toEqual({ a: { type: 'http', url: 'https://a.test', headers: { H: 'secret-a' } } });
    expect(out.unresolved).toEqual([{ name: 'b', missing: ['mcpsync-b.TOKEN'] }]);
  });
});

describe('protocol helpers', () => {
  it('placeholdersOf covers url, headers, args and env, de-duplicated', () => {
    expect(placeholdersOf({ type: 'http', url: 'https://x/${A}', headers: { h: '${B}${A}' } })).toEqual(['A', 'B']);
    expect(placeholdersOf({ command: 'c', args: ['--k=${C}'], env: { E: '${D}' } })).toEqual(['C', 'D']);
  });
  it('canonicalJson ignores key order and undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe(canonicalJson({ a: { d: 2 }, b: 1 }));
    expect(hashMcpDefinition({ type: 'http', url: 'u', headers: { a: '1', b: '2' } })).toBe(hashMcpDefinition({ type: 'http', url: 'u', headers: { b: '2', a: '1' } }));
  });
  it('validateSyncedMcpShape', () => {
    expect(validateSyncedMcpShape({})).toBeNull();
    expect(validateSyncedMcpShape({}, true)).toBeNull();
    expect(validateSyncedMcpShape({ a: {} }, true)).toMatch(/clear/);
    expect(validateSyncedMcpShape([])).toMatch(/object/);
    expect(validateSyncedMcpShape({ a: 3 })).toMatch(/must be an object/);
    expect(validateSyncedMcpShape(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`s${i}`, {}])))).toMatch(/at most/);
  });
});

describe('config', () => {
  it('defaults to no stdio and no allowlist; reads config.json, env and validates the allowlist', () => {
    expect(resolveConfig({ flags: { dataDir: dir }, env: {} })).toMatchObject({ allowSyncedStdio: false, syncedCommandAllowlist: [] });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ allowSyncedStdio: true, syncedCommandAllowlist: ['npx', '/opt/x'] }));
    expect(resolveConfig({ flags: { dataDir: dir }, env: {} })).toMatchObject({ allowSyncedStdio: true, syncedCommandAllowlist: ['npx', '/opt/x'] });
    expect(resolveConfig({ flags: { dataDir: dir }, env: { AGENT_THREADS_ALLOW_SYNCED_STDIO: '1' } }).allowSyncedStdio).toBe(true);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ syncedCommandAllowlist: ['./rel'] }));
    expect(() => resolveConfig({ flags: { dataDir: dir }, env: {} })).toThrow(/syncedCommandAllowlist/);
  });
});

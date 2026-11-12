import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HelpProviderRegistry } from '../../src/help/HelpRegistry';
import { registerAgentThreadsDocs } from '../../src/help/bundledDocs';
import { splitMarkdownSections } from '../../src/help/docIndex';
import { HELP_LIMITS, type HelpHit, type HelpProviderContribution } from '../../src/help/types';

const owner = { pluginId: 'acme.tools', displayName: 'Acme' };
const cb = (hits: HelpHit[] | (() => Promise<unknown>), extra: Partial<HelpProviderContribution> = {}): Pick<HelpProviderContribution, 'search' | 'get' | 'title'> & Partial<HelpProviderContribution> => ({
  title: 'Acme docs',
  search: async () => (typeof hits === 'function' ? hits() : hits) as never,
  get: async (docId) => ({ title: docId, text: `body of ${docId}`, totalChars: `body of ${docId}`.length }),
  ...extra,
});
const hits = (prefix: string, n: number, score?: (i: number) => number): HelpHit[] =>
  Array.from({ length: n }, (_, i) => ({ docId: `${prefix}${i}`, title: `${prefix} ${i}`, snippet: 'snippet', ...(score ? { score: score(i) } : {}) }));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'help-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('registration', () => {
  it('registers, lists, and refuses a duplicate providerId (incumbent wins)', () => {
    const r = new HelpProviderRegistry();
    const first = r.register(owner, { providerId: 'acme.docs', ...cb([]) });
    expect(first).toMatchObject({ success: true, status: 'registered' });
    const dup = r.register({ pluginId: 'other' }, { providerId: 'acme.docs', ...cb([]) });
    expect(dup).toMatchObject({ success: false, status: 'conflict' });
    expect(r.list().map((p) => p.owner.pluginId)).toEqual(['acme.tools']);
  });

  it('dispose removes the provider and a stale dispose cannot retract a later registration', () => {
    const r = new HelpProviderRegistry();
    const first = r.register(owner, { providerId: 'acme.docs', ...cb([]) });
    if (!first.success) throw new Error('setup');
    first.dispose();
    expect(r.has('acme.docs')).toBe(false);
    const second = r.register({ pluginId: 'b' }, { providerId: 'acme.docs', ...cb([]) });
    expect(second.success).toBe(true);
    first.dispose();
    expect(r.has('acme.docs')).toBe(true);
  });

  it('clear() drops everything (host stop)', () => {
    const r = new HelpProviderRegistry();
    r.register(owner, { providerId: 'acme.docs', ...cb([]) });
    r.clear();
    expect(r.list()).toEqual([]);
  });

  it.each([
    ['bad id', { providerId: 'Nodots', ...cb([]) }],
    ['no content', { providerId: 'acme.docs', title: 'x' }],
    ['search without get', { providerId: 'acme.docs', title: 'x', search: async () => [] }],
    ['empty title', { providerId: 'acme.docs', ...cb([]), title: ' ' }],
    ['long summary', { providerId: 'acme.docs', ...cb([]), summary: 'x'.repeat(201) }],
  ])('rejects %s as invalid', (_n, contribution) => {
    expect(new HelpProviderRegistry().register(owner, contribution as never)).toMatchObject({ success: false, status: 'invalid' });
  });

  it('reserves agent-threads.* and geode.* for their publishers', () => {
    const r = new HelpProviderRegistry();
    expect(r.register(owner, { providerId: 'agent-threads.fake', ...cb([]) })).toMatchObject({ status: 'invalid' });
    expect(r.register(owner, { providerId: 'geode.docs', ...cb([]) })).toMatchObject({ status: 'invalid' });
    expect(r.register({ pluginId: 'geode' }, { providerId: 'geode.docs', ...cb([]) })).toMatchObject({ success: true });
    expect(r.register({ pluginId: 'claude-threads' }, { providerId: 'agent-threads.extra', ...cb([]) })).toMatchObject({ success: true });
  });

  it('caps the number of providers', () => {
    const r = new HelpProviderRegistry();
    for (let i = 0; i < HELP_LIMITS.maxProviders; i++) expect(r.register(owner, { providerId: `acme.p${i}`, ...cb([]) }).success).toBe(true);
    expect(r.register(owner, { providerId: 'acme.extra', ...cb([]) })).toMatchObject({ success: false, status: 'invalid' });
  });
});

describe('docRoots restriction', () => {
  const setup = () => {
    const vault = join(dir, 'vault'); const plugin = join(vault, '.geode', 'plugins', 'acme.tools');
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, 'guide.md'), '# Guide\n\n## Install\nrun the installer\n');
    const r = new HelpProviderRegistry({ allowedRootBases: () => [vault, plugin] });
    return { vault, plugin, r };
  };

  it('accepts a root inside the plugin directory or the vault', () => {
    const { r, plugin, vault } = setup();
    expect(r.register(owner, { providerId: 'acme.a', title: 'A', docRoots: [plugin] }).success).toBe(true);
    expect(r.register(owner, { providerId: 'acme.b', title: 'B', docRoots: [vault] }).success).toBe(true);
  });

  it.each(['/', '/etc', 'relative/dir', '/nonexistent-dir-xyz'])('refuses %s', (root) => {
    const { r } = setup();
    expect(r.register(owner, { providerId: 'acme.a', title: 'A', docRoots: [root] })).toMatchObject({ success: false, status: 'invalid' });
  });

  it('refuses ".." escapes and a symlinked root pointing outside', () => {
    const { r, vault } = setup();
    const outside = join(dir, 'outside'); mkdirSync(outside);
    expect(r.register(owner, { providerId: 'acme.a', title: 'A', docRoots: [join(vault, '..', 'outside')] })).toMatchObject({ status: 'invalid' });
    symlinkSync(outside, join(vault, 'link'));
    expect(r.register(owner, { providerId: 'acme.b', title: 'B', docRoots: [join(vault, 'link')] })).toMatchObject({ status: 'invalid' });
  });

  it('refuses every root when the host supplies no bases', () => {
    const { plugin } = setup();
    expect(new HelpProviderRegistry().register(owner, { providerId: 'acme.a', title: 'A', docRoots: [plugin] })).toMatchObject({ status: 'invalid' });
  });

  it('indexes only plain, non-hidden .md files within limits and ignores symlinks', async () => {
    const { r, plugin } = setup();
    const outside = join(dir, 'secret.md'); writeFileSync(outside, '# Secret\nsshkey topsecret');
    symlinkSync(outside, join(plugin, 'leak.md'));
    writeFileSync(join(plugin, '.hidden.md'), '# Hidden\ntopsecret');
    writeFileSync(join(plugin, 'notes.txt'), 'topsecret');
    writeFileSync(join(plugin, 'big.md'), 'x'.repeat(HELP_LIMITS.docRootMaxFileBytes + 1));
    expect(r.register(owner, { providerId: 'acme.a', title: 'A', docRoots: [plugin] }).success).toBe(true);
    const res = await r.search({ text: 'topsecret' });
    expect('hits' in res && res.hits).toEqual([]);
    const found = await r.search({ text: 'installer' });
    expect('hits' in found && found.hits.map((h) => h.id)).toEqual(['acme.a:guide.md#install']);
  });

  it('invalidates the cache when a file changes', async () => {
    const { r, plugin } = setup();
    r.register(owner, { providerId: 'acme.a', title: 'A', docRoots: [plugin] });
    await r.search({ text: 'installer' });
    const file = join(plugin, 'guide.md');
    writeFileSync(file, '# Guide\n\n## Upgrade\nrun the upgrader\n');
    utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const res = await r.search({ text: 'upgrader' });
    expect('hits' in res && res.hits[0]?.id).toBe('acme.a:guide.md#upgrade');
  });
});

describe('search ranking, interleave and caps', () => {
  it('round-robins across providers so a chatty one cannot fill the page', async () => {
    const r = new HelpProviderRegistry();
    r.register(owner, { providerId: 'acme.loud', ...cb(hits('loud', 30, () => 1)) });
    r.register({ pluginId: 'b' }, { providerId: 'beta.quiet', ...cb(hits('quiet', 2, () => 0.5)) });
    const res = await r.search({ text: 'zzz', limit: 6 });
    if (!('hits' in res)) throw new Error('error');
    expect(res.hits.filter((h) => h.provider === 'beta.quiet')).toHaveLength(2);
    expect(res.hits).toHaveLength(6);
    expect(res.hits.slice(0, 2).map((h) => h.provider).sort()).toEqual(['acme.loud', 'beta.quiet']);
  });

  it('is deterministic and breaks ties Agent Threads, then Geode, then peers by id', async () => {
    const r = new HelpProviderRegistry();
    r.register({ pluginId: 'z' }, { providerId: 'zed.docs', ...cb(hits('z', 1, () => 1)) });
    r.register({ pluginId: 'a' }, { providerId: 'alpha.docs', ...cb(hits('a', 1, () => 1)) });
    r.register({ pluginId: 'geode' }, { providerId: 'geode.docs', ...cb(hits('g', 1, () => 1)) });
    registerAgentThreadsDocs(r, { bundled: { 'README.md': '# Readme\n\n## Zzz\nzzz' } });
    const order = async () => { const res = await r.search({ text: 'zzz' }); return 'hits' in res ? res.hits.map((h) => h.provider) : []; };
    const first = await order();
    expect(first).toEqual(['agent-threads.docs', 'geode.docs', 'alpha.docs', 'zed.docs']);
    expect(await order()).toEqual(first);
  });

  it('boosts a title match over a body match', async () => {
    const r = new HelpProviderRegistry();
    r.register(owner, { providerId: 'acme.docs', ...cb([
      { docId: 'body', title: 'Unrelated', snippet: 's', score: 0.9 },
      { docId: 'title', title: 'Daemon routing', snippet: 's', score: 0.8 },
    ]) });
    const res = await r.search({ text: 'daemon' });
    expect('hits' in res && res.hits[0].id).toBe('acme.docs:title');
  });

  it('clamps limit to 20, truncates snippets and titles, drops malformed hits and accepts at most 500', async () => {
    const r = new HelpProviderRegistry();
    r.register(owner, { providerId: 'acme.docs', ...cb(async () => [
      ...Array.from({ length: 600 }, (_, i) => ({ docId: `d${i}`, title: 't'.repeat(500), snippet: 's'.repeat(1000), score: 5 })),
      null, { docId: 3 }, { docId: 'bad\nid', title: 'x' },
    ]) });
    const res = await r.search({ text: 'x', limit: 999 });
    if (!('hits' in res)) throw new Error('error');
    expect(res.hits).toHaveLength(HELP_LIMITS.maxHits);
    expect(res.hits[0].snippet.length).toBeLessThanOrEqual(HELP_LIMITS.snippetChars);
    expect(res.hits[0].title.length).toBeLessThanOrEqual(HELP_LIMITS.titleChars);
    expect(res.hits[0].score).toBeLessThanOrEqual(1.25);
  });

  it('isolates a throwing, hanging or malformed provider and names it', async () => {
    const r = new HelpProviderRegistry({ searchTimeoutMs: 30 });
    r.register(owner, { providerId: 'acme.good', ...cb(hits('g', 2, () => 1)) });
    r.register({ pluginId: 'b' }, { providerId: 'beta.throws', ...cb(async () => { throw new Error('boom'); }) });
    r.register({ pluginId: 'c' }, { providerId: 'gamma.hangs', ...cb(() => new Promise(() => {})) });
    r.register({ pluginId: 'd' }, { providerId: 'delta.malformed', ...cb(async () => 'nope') });
    const res = await r.search({ text: 'x' });
    if (!('hits' in res)) throw new Error('error');
    expect(res.hits.map((h) => h.provider)).toEqual(['acme.good', 'acme.good']);
    expect(res.failures.map((f) => f.providerId)).toEqual(['beta.throws', 'delta.malformed', 'gamma.hangs']);
  });

  it('aborts the signal of a timed-out provider', async () => {
    const r = new HelpProviderRegistry({ searchTimeoutMs: 20 });
    let aborted = false;
    r.register(owner, { providerId: 'acme.slow', title: 'x', get: async () => null, search: (_q, signal) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }) });
    await r.search({ text: 'x' });
    expect(aborted).toBe(true);
  });

  it('filters by provider and rejects an unknown one', async () => {
    const r = new HelpProviderRegistry();
    r.register(owner, { providerId: 'acme.a', ...cb(hits('a', 1)) });
    r.register({ pluginId: 'b' }, { providerId: 'beta.b', ...cb(hits('b', 1)) });
    const only = await r.search({ text: 'x', provider: 'beta.b' });
    expect('hits' in only && only.hits.map((h) => h.provider)).toEqual(['beta.b']);
    expect(await r.search({ text: 'x', provider: 'nope.x' })).toMatchObject({ error: expect.stringContaining('Unknown help provider') });
  });

  it('passes limit, host and harness to the provider', async () => {
    const seen: unknown[] = [];
    const r = new HelpProviderRegistry({ host: () => 'geode' });
    r.register(owner, { providerId: 'acme.a', title: 'A', get: async () => null, search: async (q) => { seen.push(q); return []; } });
    await r.search({ text: 'hello', limit: 3, harness: 'codex' });
    expect(seen).toEqual([{ text: 'hello', limit: 3, host: 'geode', harness: 'codex' }]);
  });
});

describe('get and topics', () => {
  it('caps a get page at 16,000 characters and reports nextOffset', async () => {
    const r = new HelpProviderRegistry();
    const text = 'a'.repeat(40_000);
    r.register(owner, { providerId: 'acme.a', title: 'A', search: async () => [], get: async (_id, { offset, maxChars }) => ({ title: 'T', text: text.slice(offset), totalChars: text.length }) });
    const page = await r.get('acme.a:doc', 0);
    if (!page.ok) throw new Error(page.error);
    expect(page.text).toHaveLength(HELP_LIMITS.getPageChars);
    expect(page.nextOffset).toBe(HELP_LIMITS.getPageChars);
    const last = await r.get('acme.a:doc', 32_000);
    expect(last.ok && last.nextOffset).toBeUndefined();
    expect(last.ok && last.text).toHaveLength(8_000);
  });

  it('reports unknown ids, unknown providers, null docs and provider failures', async () => {
    const r = new HelpProviderRegistry();
    r.register(owner, { providerId: 'acme.a', title: 'A', search: async () => [], get: async (id) => { if (id === 'boom') throw new Error('x'); return null; } });
    expect(await r.get('noprefix', 0)).toMatchObject({ ok: false });
    expect(await r.get('nope.x:doc', 0)).toMatchObject({ ok: false, error: expect.stringContaining('Unknown help provider') });
    expect(await r.get('acme.a:missing', 0)).toMatchObject({ ok: false, error: expect.stringContaining('No document') });
    expect(await r.get('acme.a:boom', 0)).toMatchObject({ ok: false, error: expect.stringContaining('unavailable') });
    expect(await r.get('acme.a:doc', 0, 'other.p')).toMatchObject({ ok: false });
  });

  it('sees providers appearing and disappearing between calls', async () => {
    const r = new HelpProviderRegistry();
    expect(await r.topics({})).toMatchObject({ kind: 'providers', providers: [] });
    const reg = r.register(owner, { providerId: 'acme.a', ...cb([]) });
    expect(await r.topics({})).toMatchObject({ providers: [{ providerId: 'acme.a' }] });
    if (reg.success) reg.dispose();
    expect(await r.topics({})).toMatchObject({ providers: [] });
  });

  it('pages a provider\'s topics', async () => {
    const r = new HelpProviderRegistry();
    r.register(owner, { providerId: 'acme.a', ...cb([], { topics: async () => Array.from({ length: 25 }, (_, i) => ({ docId: `d${i}`, title: `T${i}` })) }) });
    const res = await r.topics({ provider: 'acme.a', limit: 10 });
    expect(res).toMatchObject({ kind: 'docs', total: 25, nextOffset: 10 });
    expect('topics' in res && res.topics[0].id).toBe('acme.a:d0');
  });
});

describe('markdown sections', () => {
  it('splits on H2/H3, ignores headings in code fences and dedupes slugs', () => {
    const { sections, fileTitle } = splitMarkdownSections('a.md', '# Title\nintro\n\n## One\nx\n```\n## not a heading\n```\n### Sub\ny\n\n## One\nz\n');
    expect(fileTitle).toBe('Title');
    expect(sections.map((s) => s.docId)).toEqual(['a.md#top', 'a.md#one', 'a.md#sub', 'a.md#one-1']);
    expect(sections[1].text).toContain('## not a heading');
  });

  it('built-in docs: search finds a section and get reads it by id or whole-file', async () => {
    const r = new HelpProviderRegistry();
    registerAgentThreadsDocs(r, { bundled: { 'docs/remote-daemon.md': '# Remote daemon\n\n## Routing\nTools route to the host.\n\n## Auth\nTokens.' } });
    const res = await r.search({ text: 'routing host' });
    expect('hits' in res && res.hits[0].id).toBe('agent-threads.docs:docs/remote-daemon.md#routing');
    const section = await r.get('agent-threads.docs:docs/remote-daemon.md#routing');
    expect(section.ok && section.text).toContain('Tools route');
    const whole = await r.get('agent-threads.docs:docs/remote-daemon.md');
    expect(whole.ok && whole.text).toContain('Tokens');
    const topics = await r.topics({ provider: 'agent-threads.docs' });
    expect('topics' in topics && topics.topics).toEqual([{ id: 'agent-threads.docs:docs/remote-daemon.md', title: 'Remote daemon' }]);
  });
});

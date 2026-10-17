import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../daemon/cli';
import {
  classifyPullError,
  describePullFailure,
  parseHealthz,
  parseInspectedContainer,
  parseTokenCreate,
  parseTokenList,
  redactSecrets,
  tail,
} from '../../src/localDaemon/parse';

describe('parseInspectedContainer', () => {
  it('reads state and labels', () => {
    const json = JSON.stringify([{ status: 'running', configuration: { labels: { a: '1' } } }]);
    expect(parseInspectedContainer(json)).toEqual({ state: 'running', labels: { a: '1' } });
  });
  it('treats any other positive state as stopped and a missing one as unknown', () => {
    expect(parseInspectedContainer(JSON.stringify([{ status: 'stopped', configuration: { labels: {} } }]))?.state).toBe('stopped');
    expect(parseInspectedContainer(JSON.stringify([{ configuration: { labels: {} } }]))?.state).toBe('unknown');
    expect(parseInspectedContainer(JSON.stringify([{ status: { state: 'running' }, labels: { x: 'y' } }]))).toEqual({ state: 'running', labels: { x: 'y' } });
  });
  it('returns null for junk', () => {
    expect(parseInspectedContainer('not json')).toBeNull();
    expect(parseInspectedContainer('[]')).toBeNull();
  });
});

describe('token output', () => {
  it('parses the real `token create --json` / `token list --json` output of the daemon CLI', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ld-token-'));
    const lines: string[] = [];
    const io = { out: (l: string) => { lines.push(l); }, err: () => undefined };
    expect(await runCli(['token', 'create', '--name', 'geode-local', '--scope', 'control', '--json', '--data-dir', dataDir], io)).toBe(0);
    const created = parseTokenCreate(lines.join('\n'));
    expect(created).toMatchObject({ name: 'geode-local', scope: 'control' });
    expect(created!.token.length).toBeGreaterThan(20);

    lines.length = 0;
    expect(await runCli(['token', 'list', '--json', '--data-dir', dataDir], io)).toBe(0);
    const listed = parseTokenList(lines.join('\n'));
    expect(listed).toEqual([{ id: created!.id, name: 'geode-local', revoked: false }]);

    lines.length = 0;
    expect(await runCli(['token', 'revoke', created!.id, '--data-dir', dataDir], io)).toBe(0);
    lines.length = 0;
    await runCli(['token', 'list', '--json', '--data-dir', dataDir], io);
    expect(parseTokenList(lines.join('\n'))[0]?.revoked).toBe(true);
  });
  it('finds the JSON line among other output and rejects a tokenless object', () => {
    expect(parseTokenCreate('warning\n{"id":"a","name":"n","scope":"control","token":"t0k"}\n')?.token).toBe('t0k');
    expect(parseTokenCreate('{"id":"a","name":"n","scope":"control"}')).toBeNull();
    expect(parseTokenCreate('garbage')).toBeNull();
  });
});

describe('classifyPullError', () => {
  it.each([
    ['Error: pull access denied for ghcr.io/x: unauthorized', 'denied'],
    ['unexpected status 403 Forbidden', 'denied'],
    ['Error: manifest unknown: ghcr.io/x:0.99.0 not found', 'not-found'],
    ['HTTP 404', 'not-found'],
    ['write /var/lib: no space left on device', 'disk'],
    ['dial tcp: lookup ghcr.io: could not resolve host', 'network'],
    ['request timed out', 'network'],
    ['something else entirely', 'unknown'],
  ])('%s -> %s', (text, kind) => {
    expect(classifyPullError(text)).toBe(kind);
  });
  it('gives each kind a distinct, actionable message', () => {
    const ref = 'ghcr.io/rbcodelabs/agent-threads-daemon:0.65.0';
    expect(describePullFailure('denied', ref, '0.65.0')).toMatch(/Public/);
    expect(describePullFailure('not-found', ref, '0.65.0')).toMatch(/not published yet/);
    expect(describePullFailure('network', ref, '0.65.0')).toMatch(/ghcr\.io/);
    expect(describePullFailure('disk', ref, '0.65.0')).toMatch(/disk space/);
  });
});

describe('helpers', () => {
  it('parseHealthz', () => {
    expect(parseHealthz('{"ok":true,"protocol":1}')).toEqual({ ok: true, protocol: 1 });
    expect(parseHealthz('nope')).toEqual({ ok: false });
  });
  it('redactSecrets replaces by content and ignores empties', () => {
    expect(redactSecrets('a SECRET b SECRET', ['SECRET', undefined, ''])).toBe('a <redacted> b <redacted>');
  });
  it('tail keeps the last lines', () => {
    expect(tail('1\n2\n3', 2)).toBe('2\n3');
    expect(tail('  ')).toBe('(no output)');
  });
});

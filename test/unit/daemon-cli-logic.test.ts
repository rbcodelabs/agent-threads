import { describe, expect, it } from 'vitest';
import { parseArgs, toRawIo } from '../../daemon/cli';
import { exitForOutcome, terminalFailure } from '../../daemon/cmd/attach';
import { dataDirCandidates, httpBaseOf, resolveConnectionSettings, type FsLike } from '../../daemon/cmd/connection';
import { CliError, EXIT, exitCodeFor } from '../../daemon/cmd/exit';
import { parseChoice, parseYesNo } from '../../daemon/cmd/follow';
import { formatTable, jsonRecord, resolveThreadId, sortRows, stateOf, type ThreadRow } from '../../daemon/cmd/list';
import { chooseCwd, permissionModeFor } from '../../daemon/cmd/run';
import { DaemonCommandError } from '../../src/remote/DaemonClient';
import { expectGolden } from '../helpers/golden';

const fsOf = (files: Record<string, string>): FsLike => ({
  exists: (p) => Object.keys(files).some((f) => f === p || f.startsWith(`${p}/`)),
  read: (p) => files[p] ?? null,
});

describe('parseArgs', () => {
  it('knows the new boolean flags and keeps value flags', () => {
    const p = parseArgs(['run', '--json', '--detach', '--cwd', '/srv/x', '--unattended', 'do it']);
    expect([...p.bools].sort()).toEqual(['detach', 'json', 'unattended']);
    expect(p.flags.get('cwd')).toEqual(['/srv/x']);
    expect(p.positionals).toEqual(['run', 'do it']);
  });
  it('treats everything after -- as the prompt', () => {
    expect(parseArgs(['run', '--', '--not-a-flag', 'x']).positionals).toEqual(['run', '--not-a-flag', 'x']);
  });
  it('maps -h to help and rejects a value flag with no value', () => {
    expect(parseArgs(['-h']).bools.has('help')).toBe(true);
    expect(() => parseArgs(['run', '--cwd'])).toThrow(/needs a value/);
  });
});

describe('toRawIo', () => {
  it('feeds a line-only Io whole lines, holding back a partial one', () => {
    const lines: string[] = [];
    const raw = toRawIo({ out: (l) => lines.push(l), err: () => {} });
    raw.out('he'); raw.out('llo\nwor'); raw.out('ld\n');
    expect(lines).toEqual(['hello', 'world']);
  });
});

describe('connection settings', () => {
  it('prefers flags, then env, then the local data dir token', () => {
    const fs = fsOf({ '/d/cli-token': 'atd_file\n', '/d/config.json': '{"port":9100}' });
    expect(resolveConnectionSettings({ dataDir: '/d' }, {}, fs)).toMatchObject({ token: 'atd_file', tokenSource: 'data-dir', url: 'ws://127.0.0.1:9100/v1/ws', urlSource: 'data-dir', local: true });
    expect(resolveConnectionSettings({ dataDir: '/d' }, { AGENT_THREADS_TOKEN: 'atd_env' }, fs)).toMatchObject({ token: 'atd_env', tokenSource: 'env' });
    expect(resolveConnectionSettings({ dataDir: '/d', token: 'atd_flag', url: 'my-server:7433' }, { AGENT_THREADS_TOKEN: 'x', AGENT_THREADS_URL: 'ws://other' }, fs))
      .toMatchObject({ token: 'atd_flag', tokenSource: 'flag', url: 'ws://my-server:7433/v1/ws', urlSource: 'flag', local: false });
  });
  it('defaults to ws://127.0.0.1:7433 with no token when nothing is configured', () => {
    expect(resolveConnectionSettings({}, {}, fsOf({}), '/home/user')).toMatchObject({ url: 'ws://127.0.0.1:7433/v1/ws', urlSource: 'default', tokenSource: 'none', token: undefined });
  });
  it('never follows a wildcard listen address from config.json', () => {
    const fs = fsOf({ '/d/config.json': '{"listen":"0.0.0.0","port":8000}' });
    expect(resolveConnectionSettings({ dataDir: '/d' }, {}, fs).url).toBe('ws://127.0.0.1:8000/v1/ws');
  });
  it('lists only data dirs that exist, never creating any', () => {
    const fs = fsOf({ '/home/user/.agent-threads/tokens.json': '[]' });
    expect(dataDirCandidates({}, {}, fs, '/home/user')).toEqual(['/home/user/.agent-threads']);
    expect(dataDirCandidates({ dataDir: '/x' }, { DATA_DIR: '/y' }, fs)).toEqual(['/x']);
  });
  it('derives the http base for /healthz', () => {
    expect(httpBaseOf('wss://box.example.ts.net:8443/v1/ws')).toBe('https://box.example.ts.net:8443');
  });
});

describe('exit codes', () => {
  it('maps daemon errors', () => {
    expect(exitCodeFor(new DaemonCommandError('unauthorized', 'x'))).toBe(EXIT.UNAUTHORIZED);
    expect(exitCodeFor(new DaemonCommandError('forbidden', 'session.open needs scope control'))).toBe(EXIT.UNAUTHORIZED);
    expect(exitCodeFor(new DaemonCommandError('forbidden', 'cwd is outside every workspace'))).toBe(EXIT.FAILED);
    expect(exitCodeFor(new DaemonCommandError('unreachable', 'x'))).toBe(EXIT.UNREACHABLE);
    expect(exitCodeFor(new DaemonCommandError('incompatible', 'x'))).toBe(EXIT.INCOMPATIBLE);
    expect(exitCodeFor(new DaemonCommandError('conflict', 'x'))).toBe(EXIT.FAILED);
    expect(exitCodeFor(new CliError('x', EXIT.USAGE))).toBe(EXIT.USAGE);
  });
  it('maps follow outcomes', () => {
    expect(exitForOutcome('done')).toBe(0);
    expect(exitForOutcome('idle')).toBe(0);
    expect(exitForOutcome('error')).toBe(1);
    expect(exitForOutcome('interrupted')).toBe(6);
    expect(exitForOutcome('needs_input')).toBe(7);
  });
  it('treats only unauthorized/incompatible connection states as terminal', () => {
    expect(terminalFailure({ status: 'unauthorized', attempt: 0 })?.code).toBe(EXIT.UNAUTHORIZED);
    expect(terminalFailure({ status: 'incompatible', attempt: 0 })?.code).toBe(EXIT.INCOMPATIBLE);
    expect(terminalFailure({ status: 'reconnecting', attempt: 1 })).toBeNull();
  });
});

describe('answer parsing', () => {
  it('parses yes/no with no as the default', () => {
    expect(parseYesNo('y')).toBe('yes');
    expect(parseYesNo(' YES ')).toBe('yes');
    expect(parseYesNo('')).toBe('no');
    expect(parseYesNo('maybe')).toBeNull();
  });
  it('maps option numbers to labels, else keeps free text', () => {
    expect(parseChoice('2', ['a', 'b'], false)).toBe('b');
    expect(parseChoice('1, 2', ['a', 'b'], true)).toBe('a, b');
    expect(parseChoice('9', ['a', 'b'], false)).toBe('9');
    expect(parseChoice('something else', ['a'], false)).toBe('something else');
    expect(parseChoice('  ', ['a'], false)).toBeNull();
  });
});

describe('run helpers', () => {
  const ws = [
    { path: '/srv/ro', name: 'ro', readOnly: true, kind: 'folder' as const, isDefault: false },
    { path: '/srv/work', name: 'work', readOnly: false, kind: 'folder' as const, isDefault: true },
  ];
  it('uses the shell folder for a local daemon only when a workspace allows it', () => {
    expect(chooseCwd({ localCwd: '/srv/work/app', local: true, workspaces: ws })).toEqual({ cwd: '/srv/work/app' });
    expect(chooseCwd({ localCwd: '/home/user', local: true, workspaces: ws })).toEqual({ cwd: '/srv/work' });
    expect(chooseCwd({ localCwd: '/home/user/x', local: false, workspaces: ws })).toEqual({ cwd: '/srv/work' });
    expect(chooseCwd({ flag: '/anywhere', localCwd: '/x', local: false, workspaces: ws })).toEqual({ cwd: '/anywhere' });
    expect(chooseCwd({ localCwd: '/x', local: false, workspaces: undefined })).toHaveProperty('error');
  });
  it('picks dontAsk for unattended runs and validates the mode', () => {
    expect(permissionModeFor(undefined, true)).toBe('dontAsk');
    expect(permissionModeFor(undefined, false)).toBe('default');
    expect(permissionModeFor('plan', true)).toBe('plan');
    expect(() => permissionModeFor('yolo', false)).toThrow(CliError);
  });
});

describe('list', () => {
  const rows: ThreadRow[] = [
    { threadId: 'b-idle', lastSeq: 12, open: true, turnInFlight: false, hasPendingPermission: false, cwd: '/srv/workspaces/api', nativeSessionId: 'n1', lastActivityAt: 5 },
    { threadId: 'a-closed', lastSeq: 40, open: false, turnInFlight: false, hasPendingPermission: false, cwd: '/srv/workspaces/web' },
    { threadId: 'c-running', lastSeq: 7, open: true, turnInFlight: true, hasPendingPermission: false },
    { threadId: 'd-waiting', lastSeq: 3, open: true, turnInFlight: true, hasPendingPermission: true, cwd: '/srv/workspaces/api' },
  ];
  it('derives state and sorts needs-you first', () => {
    expect(rows.map(stateOf)).toEqual(['idle', 'closed', 'running', 'waiting']);
    expect(sortRows(rows).map((r) => r.threadId)).toEqual(['d-waiting', 'c-running', 'b-idle', 'a-closed']);
  });
  it('golden: table', () => expectGolden('cli/list.table.txt', `${formatTable(rows).join('\n')}\n${formatTable([]).join('\n')}\n`));
  it('golden: --json', () => expectGolden('cli/list.ndjson', `${sortRows(rows).map((r) => JSON.stringify(jsonRecord(r))).join('\n')}\n`));
  it('resolves exact ids and unique prefixes, and explains ambiguity', () => {
    expect(resolveThreadId(rows, 'b-idle')).toBe('b-idle');
    expect(resolveThreadId(rows, 'd-')).toBe('d-waiting');
    expect(() => resolveThreadId([...rows, { ...rows[0], threadId: 'b-other' }], 'b-')).toThrow(/matches 2 threads/);
    expect(() => resolveThreadId(rows, 'zzz')).toThrow(/no thread/);
  });
});

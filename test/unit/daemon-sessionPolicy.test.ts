import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RemoteSessionSpec } from '../../src/protocol';
import { PolicyError, assertWithinWorkspaces, sanitizeExtraEnv, validateSpec } from '../../daemon/sessionPolicy';

let root: string;
let ws: string;
let outside: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'policy-')));
  ws = join(root, 'ws');
  outside = join(root, 'outside');
  mkdirSync(join(ws, 'repo'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(ws, 'file.txt'), 'x');
  symlinkSync(outside, join(ws, 'escape'));
  symlinkSync(join(ws, 'repo'), join(ws, 'alias'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const spec = (over: Partial<RemoteSessionSpec> = {}): RemoteSessionSpec =>
  ({ harness: 'claude', cwd: join(ws, 'repo'), permissionMode: 'default', extraEnvRaw: '', ...over });
const policy = (over = {}) => ({ workspaces: [ws], allowBypass: false, ...over });
const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return e instanceof PolicyError ? e.code : `other:${String(e)}`; }
  return undefined;
};

describe('workspace allowlist', () => {
  it('accepts the root itself and anything below it', () => {
    expect(assertWithinWorkspaces(ws, [ws])).toBe(ws);
    expect(assertWithinWorkspaces(join(ws, 'repo'), [ws])).toBe(join(ws, 'repo'));
  });
  it('refuses a sibling, a prefix-lookalike, and a parent', () => {
    mkdirSync(join(root, 'ws-evil'), { recursive: true });
    expect(code(() => assertWithinWorkspaces(outside, [ws]))).toBe('forbidden');
    expect(code(() => assertWithinWorkspaces(join(root, 'ws-evil'), [ws]))).toBe('forbidden');
    expect(code(() => assertWithinWorkspaces(root, [ws]))).toBe('forbidden');
  });
  it('refuses `..` traversal that resolves outside', () => {
    expect(code(() => assertWithinWorkspaces(join(ws, 'repo', '..', '..', 'outside'), [ws]))).toBe('forbidden');
  });
  it('follows symlinks before comparing: a link out of the workspace is refused, a link within is fine', () => {
    expect(code(() => assertWithinWorkspaces(join(ws, 'escape'), [ws]))).toBe('forbidden');
    expect(code(() => assertWithinWorkspaces(join(ws, 'alias'), [ws]))).toBeUndefined();
  });
  it('refuses relative, missing, and non-directory paths as bad_frame', () => {
    expect(code(() => assertWithinWorkspaces('repo', [ws]))).toBe('bad_frame');
    expect(code(() => assertWithinWorkspaces(join(ws, 'nope'), [ws]))).toBe('bad_frame');
    expect(code(() => assertWithinWorkspaces(join(ws, 'file.txt'), [ws]))).toBe('bad_frame');
  });
  it('an empty allowlist permits nothing', () => {
    expect(code(() => assertWithinWorkspaces(ws, []))).toBe('forbidden');
  });
});

describe('validateSpec', () => {
  it('passes a normal spec through', () => {
    expect(validateSpec(spec(), policy())).toMatchObject({ harness: 'claude', cwd: join(ws, 'repo'), permissionMode: 'default' });
  });
  it('refuses bypassPermissions unless the operator allowed it', () => {
    expect(code(() => validateSpec(spec({ permissionMode: 'bypassPermissions' }), policy()))).toBe('forbidden');
    expect(code(() => validateSpec(spec({ permissionMode: 'bypassPermissions' }), policy({ allowBypass: true })))).toBeUndefined();
    expect(code(() => validateSpec(spec({ permissionMode: 'dontAsk' }), policy()))).toBeUndefined();
  });
  it('refuses any harness but claude', () => {
    expect(code(() => validateSpec(spec({ harness: 'codex' }), policy()))).toBe('bad_frame');
  });
  it('checks additionalDirectories against the same allowlist', () => {
    expect(code(() => validateSpec(spec({ additionalDirectories: [outside] }), policy()))).toBe('forbidden');
    expect(validateSpec(spec({ additionalDirectories: [join(ws, 'repo')] }), policy()).additionalDirectories).toEqual([join(ws, 'repo')]);
  });
  it('ignores client-supplied environment entirely unless the operator allowlists names', () => {
    const raw = 'FOO=1\nHTTPS_PROXY=http://evil\nBASH_ENV=/tmp/x\nNODE_EXTRA_CA_CERTS=/tmp/ca\nGIT_SSH_COMMAND=evil';
    expect(validateSpec(spec({ extraEnvRaw: raw }), policy()).extraEnvRaw).toBe('');
    expect(validateSpec(spec({ extraEnvRaw: raw }), policy({ allowedClientEnv: [] })).extraEnvRaw).toBe('');
  });
  it('with an allowlist keeps only the listed names, and never a protected one', () => {
    const out = validateSpec(
      spec({ extraEnvRaw: 'FOO=1\nHOME=/tmp/evil\n# c\nclaude_code_oauth_token=x\nBAR=two\nHTTPS_PROXY=http://evil' }),
      policy({ allowedClientEnv: ['FOO', 'BAR', 'HOME', 'CLAUDE_CODE_OAUTH_TOKEN'] }),
    );
    expect(out.extraEnvRaw).toBe('FOO=1\nBAR=two');
  });
  it('refuses a permission mode the daemon does not know', () => {
    expect(code(() => validateSpec(spec({ permissionMode: 'yolo' as never }), policy()))).toBe('bad_frame');
    expect(code(() => validateSpec(spec({ permissionMode: '' as never }), policy()))).toBe('bad_frame');
    for (const m of ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto']) {
      expect(code(() => validateSpec(spec({ permissionMode: m as never }), policy())), m).toBeUndefined();
    }
  });
});

describe('sanitizeExtraEnv', () => {
  it('reports what it dropped', () => {
    expect(sanitizeExtraEnv('PATH=/x\nA=1\nNODE_OPTIONS=--require=/x')).toEqual({ text: 'A=1', dropped: ['PATH', 'NODE_OPTIONS'] });
  });
});

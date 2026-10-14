import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeCredentialSource, findClaudeBinary, resolveCredentialEnv } from '../../daemon/claudeDriver';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cenv-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const fakeClaude = (dir: string) => { mkdirSync(dir, { recursive: true }); const p = join(dir, 'claude'); writeFileSync(p, '#!/bin/sh\n'); chmodSync(p, 0o755); return p; };

describe('findClaudeBinary', () => {
  it('prefers the explicit path, then PATH, then the npm-global install, and reports null when absent', () => {
    const home = tmp();
    const onPath = fakeClaude(join(tmp(), 'bin'));
    const npmGlobal = fakeClaude(join(home, '.npm-global/bin'));
    expect(findClaudeBinary('/opt/x', { PATH: '' }, home)).toBeNull(); // explicit but missing: no silent fallback
    expect(findClaudeBinary(npmGlobal, { PATH: '' }, home)).toBe(npmGlobal);
    expect(findClaudeBinary(undefined, { PATH: join(onPath, '..') }, home)).toBe(onPath);
    expect(findClaudeBinary(undefined, { PATH: '' }, home)).toBe(npmGlobal);
    expect(findClaudeBinary(undefined, { PATH: '' }, tmp())).toBeNull();
  });
});

describe('credentials', () => {
  it('adds nothing when the environment already carries a token (process.env passes through)', () => {
    expect(resolveCredentialEnv({ CLAUDE_CODE_OAUTH_TOKEN: 't' })).toEqual({});
    expect(resolveCredentialEnv({ ANTHROPIC_API_KEY: 'k' })).toEqual({});
    expect(resolveCredentialEnv({})).toEqual({});
  });
  it('reads the systemd LoadCredential= file', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'claude-token'), 'tok-from-file\n');
    expect(resolveCredentialEnv({ CREDENTIALS_DIRECTORY: dir })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-from-file' });
    expect(resolveCredentialEnv({ CREDENTIALS_DIRECTORY: tmp() })).toEqual({});
  });
  it('describes the source without ever printing a value', () => {
    const home = tmp();
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude/.credentials.json'), '{"secret":"x"}');
    expect(describeCredentialSource({ CLAUDE_CODE_OAUTH_TOKEN: 'sekrit' }, home)).toBe('CLAUDE_CODE_OAUTH_TOKEN (environment)');
    expect(describeCredentialSource({ HOME: home }, home)).toContain('existing Claude login');
    const none = describeCredentialSource({ HOME: tmp() }, tmp());
    expect(none).toMatch(/none found/);
    expect(JSON.stringify([describeCredentialSource({ ANTHROPIC_API_KEY: 'sekrit' }, home), none])).not.toContain('sekrit');
  });
});

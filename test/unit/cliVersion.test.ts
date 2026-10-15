import { describe, it, expect } from 'vitest';
import {
  MIN_CLAUDE_CLI_VERSION,
  parseCliVersion,
  compareVersions,
  detectInstallMethod,
  probeCliVersion,
  checkClaudeCli,
  findMissingKnownModels,
  describeCliProblems,
  type CliProbeDeps,
} from '../../src/cliVersion';

function deps(over: Partial<CliProbeDeps> = {}): CliProbeDeps {
  return {
    exec: async () => ({ exitCode: 0, stdout: '2.1.284 (Claude Code)\n', stderr: '' }),
    realpath: (p) => p,
    ...over,
  };
}

describe('parseCliVersion', () => {
  it('parses the --version banner', () => {
    expect(parseCliVersion('2.1.284 (Claude Code)')).toBe('2.1.284');
    expect(parseCliVersion('claude v3.0.1\n')).toBe('3.0.1');
  });
  it('returns undefined for garbage', () => {
    expect(parseCliVersion('')).toBeUndefined();
    expect(parseCliVersion('command not found')).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('2.1.9', '2.1.284')).toBeLessThan(0);
    expect(compareVersions('2.1.284', '2.1.284')).toBe(0);
    expect(compareVersions('2.2.0', '2.1.999')).toBeGreaterThan(0);
    expect(compareVersions('3.0.0', '2.9.9')).toBeGreaterThan(0);
  });
});

describe('detectInstallMethod', () => {
  it('detects Homebrew by resolved path', () => {
    const r = detectInstallMethod('/opt/homebrew/Caskroom/claude-code/2.1.200/claude');
    expect(r.method).toBe('homebrew');
    expect(r.upgradeCommand).toBe('brew upgrade claude-code');
    expect(detectInstallMethod('/usr/local/Cellar/claude-code/1/bin/claude').method).toBe('homebrew');
    expect(detectInstallMethod('/opt/homebrew/bin/claude').method).toBe('homebrew');
  });
  it('detects npm global', () => {
    const r = detectInstallMethod('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js');
    expect(r.method).toBe('npm');
    expect(r.upgradeCommand).toBe('npm install -g @anthropic-ai/claude-code@latest');
  });
  it('falls back to claude update', () => {
    const r = detectInstallMethod('/Users/me/.local/bin/claude');
    expect(r.method).toBe('other');
    expect(r.upgradeCommand).toBe('claude update');
  });
});

describe('probeCliVersion', () => {
  it('returns the parsed version', async () => {
    expect(await probeCliVersion('/x/claude', deps())).toBe('2.1.284');
  });
  it('never throws: spawn error, nonzero exit, junk output', async () => {
    expect(await probeCliVersion('/x', deps({ exec: async () => { throw new Error('ENOENT'); } }))).toBeUndefined();
    expect(await probeCliVersion('/x', deps({ exec: async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }) }))).toBeUndefined();
    expect(await probeCliVersion('/x', deps({ exec: async () => ({ exitCode: 0, stdout: 'hi', stderr: '' }) }))).toBeUndefined();
  });
  it('passes a timeout and --version', async () => {
    let seen: { args: string[]; timeoutMs: number } | undefined;
    await probeCliVersion('/x', deps({ exec: async (_f, args, o) => { seen = { args, timeoutMs: o.timeoutMs }; return { exitCode: 0, stdout: '2.1.284', stderr: '' }; } }));
    expect(seen?.args).toEqual(['--version']);
    expect(seen?.timeoutMs).toBeGreaterThan(0);
  });
});

describe('checkClaudeCli', () => {
  it('flags versions below the minimum with the install-specific command', async () => {
    const info = await checkClaudeCli('/opt/homebrew/bin/claude', deps({
      exec: async () => ({ exitCode: 0, stdout: '2.1.100 (Claude Code)', stderr: '' }),
    }));
    expect(info.version).toBe('2.1.100');
    expect(info.belowMinimum).toBe(true);
    expect(info.upgradeCommand).toBe('brew upgrade claude-code');
  });
  it('is fine at the minimum', async () => {
    const info = await checkClaudeCli('/x/claude', deps({
      exec: async () => ({ exitCode: 0, stdout: `${MIN_CLAUDE_CLI_VERSION} (Claude Code)`, stderr: '' }),
    }));
    expect(info.belowMinimum).toBe(false);
  });
  it('reports unknown version without flagging it', async () => {
    const info = await checkClaudeCli('/x/claude', deps({ exec: async () => { throw new Error('x'); } }));
    expect(info.version).toBeUndefined();
    expect(info.belowMinimum).toBe(false);
  });
  it('uses the resolved path for install detection', async () => {
    const info = await checkClaudeCli('/usr/local/bin/claude', deps({
      realpath: () => '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    }));
    expect(info.installMethod).toBe('npm');
  });
});

describe('findMissingKnownModels', () => {
  const known = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'];
  it('returns nothing for an empty catalog', () => {
    expect(findMissingKnownModels([], known)).toEqual([]);
  });
  it('lists known models absent from a stale catalog', () => {
    const catalog = [
      { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5-5' },
      { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5' },
      { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
      { value: 'fable', displayName: 'Fable', resolvedModel: 'claude-fable-5-1' },
    ];
    expect(findMissingKnownModels(catalog, known)).toEqual(['claude-sonnet-5-5']);
  });
  it('matches Bedrock/Vertex forms and context tags by family+version', () => {
    const catalog = [
      { value: 'default', displayName: 'Default (recommended)' },
      { value: 'us.anthropic.claude-opus-5-5-v1:0', displayName: 'Opus' },
      { value: 'claude-sonnet-5-5[1m]', displayName: 'Sonnet' },
      { value: 'anthropic.claude-haiku-4-5-20251001-v1:0', displayName: 'Haiku' },
      { value: 'claude-fable-5-1@20260101', displayName: 'Fable' },
    ];
    expect(findMissingKnownModels(catalog, known)).toEqual([]);
  });
});

describe('describeCliProblems', () => {
  const base = { binaryPath: '/x', installMethod: 'homebrew' as const, upgradeCommand: 'brew upgrade claude-code' };
  it('returns no problems when healthy', () => {
    expect(describeCliProblems({ ...base, version: '2.1.284', belowMinimum: false }, [])).toEqual([]);
  });
  it('hard warning for old versions', () => {
    const p = describeCliProblems({ ...base, version: '2.1.1', belowMinimum: true }, []);
    expect(p).toHaveLength(1);
    expect(p[0]!.severity).toBe('warning');
    expect(p[0]!.message).toContain('2.1.1');
    expect(p[0]!.message).toContain(MIN_CLAUDE_CLI_VERSION);
    expect(p[0]!.message).toContain('brew upgrade claude-code');
  });
  it('soft notice for missing models, never an error', () => {
    const p = describeCliProblems({ ...base, version: '2.1.284', belowMinimum: false }, ['claude-sonnet-5-5']);
    expect(p).toHaveLength(1);
    expect(p[0]!.severity).toBe('notice');
    expect(p[0]!.message).toContain('Sonnet 5.5');
    expect(p[0]!.message).toContain('not reported by your CLI');
  });
  it('handles an unknown info (probe not finished) with no problems', () => {
    expect(describeCliProblems(undefined, ['claude-sonnet-5-5'])).toHaveLength(1);
  });
});

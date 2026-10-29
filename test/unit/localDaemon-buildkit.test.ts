import { describe, expect, it } from 'vitest';
import { buildThinImage } from '../../src/localDaemon/provision';

type Call = string[];
const ok = { exitCode: 0, stdout: '', stderr: '' };

describe('buildThinImage stops the buildkit builder VM', () => {
  it('stops buildkit after a successful build', async () => {
    const calls: Call[] = [];
    await buildThinImage({ runner: async (args) => { calls.push(args); return ok as never; } }, '0.65.0');
    expect(calls[0][0]).toBe('build');
    expect(calls.at(-1)).toEqual(['stop', 'buildkit']);
  });

  it('still stops buildkit when the build fails, and keeps the build error', async () => {
    const calls: Call[] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      return (args[0] === 'build' ? { exitCode: 1, stdout: '', stderr: 'boom' } : ok) as never;
    };
    await expect(buildThinImage({ runner }, '0.65.0')).rejects.toThrow();
    expect(calls.at(-1)).toEqual(['stop', 'buildkit']);
  });

  it('ignores a failing buildkit stop', async () => {
    const runner = async (args: string[]) => {
      if (args[0] === 'stop') throw new Error('no such container');
      return ok as never;
    };
    await expect(buildThinImage({ runner }, '0.65.0')).resolves.toBeUndefined();
  });
});

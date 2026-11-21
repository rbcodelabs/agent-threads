import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import {
  createClaudeProcessGroupSpawner,
  killProcessTreeSignal,
  processGroupSpawnOptions,
  terminateProcessTree,
} from '../../src/processTree';

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isPidAlive(pid);
}

describe('processTree', () => {
  it('processGroupSpawnOptions returns detached:true on POSIX and windowsHide:true on win32', () => {
    const opts = processGroupSpawnOptions();
    if (process.platform === 'win32') {
      expect(opts).toEqual({ windowsHide: true });
    } else {
      expect(opts).toEqual({ detached: true });
    }
  });

  it('killProcessTreeSignal returns false for invalid or dead pids', () => {
    expect(killProcessTreeSignal(undefined, 'SIGTERM')).toBe(false);
    expect(killProcessTreeSignal(0, 'SIGTERM')).toBe(false);
    expect(killProcessTreeSignal(-1, 'SIGTERM')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'terminateProcessTree tears down both child and grandchild in the POSIX process group',
    async () => {
      const childScript = `
        const { spawn } = require('child_process');
        const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });
        process.stdout.write('GRANDCHILD:' + gc.pid + '\\n');
        setInterval(() => {}, 10000);
      `;
      const child = spawn(process.execPath, ['-e', childScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...processGroupSpawnOptions(),
      });

      const grandchildPid = await new Promise<number>((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('Timed out waiting for grandchild PID')), 5000);
        child.stdout!.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const match = buf.match(/GRANDCHILD:(\d+)/);
          if (match) {
            clearTimeout(timer);
            resolve(Number(match[1]));
          }
        });
        child.once('error', (err) => { clearTimeout(timer); reject(err); });
      });

      try {
        expect(child.pid).toBeGreaterThan(0);
        expect(isPidAlive(child.pid!)).toBe(true);
        expect(isPidAlive(grandchildPid)).toBe(true);

        await terminateProcessTree(child, { graceMs: 1000 });

        expect(await waitForPidExit(child.pid!)).toBe(true);
        expect(await waitForPidExit(grandchildPid)).toBe(true);
      } finally {
        try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ }
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'terminateProcessTree escalates to SIGKILL when child ignores SIGTERM',
    async () => {
      const trapScript = `
        process.on('SIGTERM', () => {});
        process.stdout.write('READY\\n');
        setInterval(() => {}, 10000);
      `;
      const child = spawn(process.execPath, ['-e', trapScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...processGroupSpawnOptions(),
      });

      await new Promise<void>((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('Timed out waiting for READY')), 5000);
        child.stdout!.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          if (buf.includes('READY')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once('error', (err) => { clearTimeout(timer); reject(err); });
      });

      try {
        const startedAt = Date.now();
        await terminateProcessTree(child, { graceMs: 150 });
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeLessThan(2000);
        expect(await waitForPidExit(child.pid!)).toBe(true);
        expect(child.signalCode).toBe('SIGKILL');
      } finally {
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'createClaudeProcessGroupSpawner forwards stderr and kills the entire process group',
    async () => {
      const stderrChunks: string[] = [];
      const spawner = createClaudeProcessGroupSpawner((chunk) => stderrChunks.push(chunk), 150);
      const ac = new AbortController();
      const script = `
        const { spawn } = require('child_process');
        process.stderr.write('diag-line\\n');
        const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });
        process.stdout.write('GC:' + gc.pid + '\\n');
        setInterval(() => {}, 10000);
      `;
      const proc = spawner({
        command: process.execPath,
        args: ['-e', script],
        cwd: process.cwd(),
        env: process.env,
        signal: ac.signal,
      });

      const gcPid = await new Promise<number>((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('Timed out waiting for GC pid')), 5000);
        proc.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const m = buf.match(/GC:(\d+)/);
          if (m) { clearTimeout(timer); resolve(Number(m[1])); }
        });
        proc.once('error', (err) => { clearTimeout(timer); reject(err); });
      });

      try {
        expect(isPidAlive(gcPid)).toBe(true);
        const exitPromise = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
        expect(proc.kill('SIGTERM')).toBe(true);
        expect(proc.killed).toBe(true);
        await exitPromise;
        expect(await waitForPidExit(gcPid)).toBe(true);
        expect(stderrChunks.join('')).toContain('diag-line');
      } finally {
        try { process.kill(gcPid, 'SIGKILL'); } catch { /* already gone */ }
      }
    },
  );
});

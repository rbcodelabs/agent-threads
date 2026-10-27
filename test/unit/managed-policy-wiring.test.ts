/**
 * Source-level pins for the managed-policy wiring. These guard against a future call site that starts a session, or
 * sends a GitHub token to a remote daemon, without going through policy.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
});
const src = (file: string): string => readFileSync(join(root, file), 'utf8');

describe('managed policy wiring', () => {
  it('every createHarnessSession call in src passes a launch policy (the last-resort guard is never skipped)', () => {
    const offenders: string[] = [];
    for (const file of walk(join(root, 'src'))) {
      const text = readFileSync(file, 'utf8');
      const rel = relative(root, file);
      if (rel === 'src/HarnessFactory.ts') continue;
      for (const match of text.matchAll(/createHarnessSession\(([^;]*?)\);/gs)) {
        if (!/[lL]aunch(Policy)?\b/.test(match[1])) offenders.push(`${rel}: ${match[0].slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only HarnessFactory constructs harness sessions', () => {
    const offenders: string[] = [];
    for (const file of walk(join(root, 'src'))) {
      const rel = relative(root, file);
      if (rel === 'src/HarnessFactory.ts' || rel.startsWith('src/__')) continue;
      const text = readFileSync(file, 'utf8');
      if (/new (ThreadSession|CodexSession|OpenCodeSession|RemoteHarnessSession)\(/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('sendMessage reads policy before beforeRemoteSend', () => {
    const text = src('src/ThreadManager.ts');
    const start = text.indexOf('async sendMessage(');
    const body = text.slice(start, start + 4000);
    expect(body.indexOf('readLaunchPolicy')).toBeGreaterThan(-1);
    expect(body.indexOf('this.enforceLaunchPolicy(')).toBeLessThan(body.indexOf('await this.beforeRemoteSend('));
  });

  it('managedPolicy.ts stays pure (no host, Node or DOM imports) so it can live in the daemon core closure', () => {
    const text = src('src/managedPolicy.ts');
    const imports = [...text.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./types']);
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/require\(|process\.|document\.|window\./);
  });

  it('nothing sends a GitHub token to a remote daemon: the only delivery module is the local-daemon one, and it is not wired to RemoteSecretPush', () => {
    const offenders: string[] = [];
    for (const file of walk(join(root, 'src'))) {
      const rel = relative(root, file);
      if (rel.startsWith('src/localDaemon/') || rel === 'src/managedPolicy.ts') continue;
      const text = readFileSync(file, 'utf8');
      // A remote-daemon path (secretPush, skillsSync, mcpSync, remote/*) that touches the GitHub token publisher/delivery.
      if (rel.startsWith('src/remote/') && /githubCredentials|githubDelivery|GithubTokenPublisher|getToken\(\)/.test(text) && !/DaemonClient|probe/.test(rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

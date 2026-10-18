import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  THIN_DOCKERFILE,
  WITH_CLAUDE_STAGE_BODY,
  SpecError,
  buildThinImageArgs,
  containerNameFor,
  credentialPresentArgs,
  dataVolumeFor,
  labelsFor,
  localImageRef,
  mountsFor,
  dropOverlappingRoots,
  resolveExternalRoots,
  resolveWorkFolders,
  resolveDaemonCpus,
  resolveDaemonMemory,
  prepareArgs,
  prepareScript,
  publishedImageRef,
  pullArgs,
  runArgs,
  specSignature,
  tokenCreateArgs,
  vaultHash,
  workspacesVolumeFor,
  type LocalDaemonSpec,
} from '../../src/localDaemon/spec';

const root = resolve(__dirname, '../..');
const spec: LocalDaemonSpec = {
  vaultPath: '/Users/user/Vault',
  version: '0.65.0',
  hostPort: 7433,
  maskedDirs: ['.geode', '.obsidian'],
  memory: '4G',
  cpus: 4,
};

describe('names', () => {
  it('derives stable, per-vault names', () => {
    const h = vaultHash('/Users/user/Vault');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(vaultHash('/Users/user/Vault/')).toBe(h);
    expect(vaultHash('/Users/user/Other')).not.toBe(h);
    expect(containerNameFor('/Users/user/Vault')).toBe(`agent-threads-local-${h}`);
    expect(dataVolumeFor('/Users/user/Vault')).toBe(`agent-threads-local-${h}-data`);
    expect(workspacesVolumeFor('/Users/user/Vault')).toBe(`agent-threads-local-${h}-workspaces`);
  });
});

describe('thin Dockerfile', () => {
  it('embeds the with-claude stage of sandbox/Dockerfile.daemon byte for byte', () => {
    const real = readFileSync(resolve(root, 'sandbox/Dockerfile.daemon'), 'utf8');
    const marker = 'FROM ${BASE_IMAGE} AS with-claude\n';
    const at = real.indexOf(marker);
    expect(at).toBeGreaterThan(0);
    expect(real.slice(at + marker.length)).toBe(WITH_CLAUDE_STAGE_BODY);
  });
  it('builds FROM the BASE_IMAGE build arg and installs the CLI outside every VOLUME', () => {
    expect(THIN_DOCKERFILE).toContain('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n');
    expect(THIN_DOCKERFILE).toContain('claude.ai/install.sh');
    expect(THIN_DOCKERFILE).toContain('/opt/claude');
  });
});

describe('golden argv', () => {
  it('pulls the published image for exactly the plugin version, arm64 only', () => {
    expect(pullArgs('0.65.0')).toEqual(['image', 'pull', '--platform', 'linux/arm64', 'ghcr.io/rbcodelabs/agent-threads-daemon:0.65.0']);
  });

  it('builds the thin layer on the published tag', () => {
    expect(buildThinImageArgs({ version: '0.65.0', dockerfilePath: '/t/Dockerfile', contextDir: '/t' })).toEqual([
      'build', '--tag', 'agent-threads-daemon-local:0.65.0',
      '--build-arg', 'BASE_IMAGE=ghcr.io/rbcodelabs/agent-threads-daemon:0.65.0',
      '--label', 'com.rbcodelabs.agent-threads.local-daemon.image-version=0.65.0',
      '--progress', 'plain', '-f', '/t/Dockerfile', '/t',
    ]);
  });

  it('run: loopback publish, vault rw with config dirs masked ro, no token anywhere', () => {
    const args = runArgs(spec);
    const name = containerNameFor(spec.vaultPath);
    expect(args.slice(0, 4)).toEqual(['run', '--detach', '--name', name]);
    expect(args).toContain('127.0.0.1:7433:7433');
    expect(args[args.indexOf('127.0.0.1:7433:7433') - 1]).toBe('-p');
    const vols = args.flatMap((a, i) => (args[i - 1] === '--volume' ? [a] : []));
    expect(vols).toEqual([
      `${dataVolumeFor(spec.vaultPath)}:/var/lib/agent-threads`,
      `${workspacesVolumeFor(spec.vaultPath)}:/srv/workspaces`,
      '/Users/user/Vault:/vault',
      '/Users/user/Vault/.geode:/vault/.geode:ro',
      '/Users/user/Vault/.obsidian:/vault/.obsidian:ro',
    ]);
    expect(args).toContain('--memory');
    expect(args[args.indexOf('--memory') + 1]).toBe('4G');
    expect(args[args.indexOf('--cpus') + 1]).toBe('4');
    expect(args).toContain('CREDENTIALS_DIRECTORY=/var/lib/agent-threads/creds');
    const image = args.indexOf(localImageRef('0.65.0'));
    expect(args.slice(image)).toEqual([
      'agent-threads-daemon-local:0.65.0',
      '--listen', '0.0.0.0', '--i-know-this-is-open', '--workspace', '/srv/workspaces', '--workspace', '/vault',
    ]);
  });

  it('run: adds no privilege, no network override, no restart policy', () => {
    const joined = runArgs(spec).join(' ');
    for (const forbidden of ['--privileged', '--cap-add', '--network', '--restart', '--security-opt', '0.0.0.0:7433']) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it('run: skips masked mounts for config dirs that do not exist', () => {
    const args = runArgs({ ...spec, maskedDirs: ['.obsidian'] });
    expect(args.join(' ')).not.toContain('.geode');
    expect(args.join(' ')).toContain('/Users/user/Vault/.obsidian:/vault/.obsidian:ro');
    expect(mountsFor({ vaultPath: '/v/', maskedDirs: [] })).toEqual([{ host: '/v', guest: '/vault', readOnly: false }]);
  });

  it('external roots: read-only mounts at /ext/<name> plus read-only workspaces, part of the spec signature', () => {
    const withRoots = { ...spec, externalRoots: [{ host: '/Users/user/Docs', name: 'Docs' }, { host: '/data/shared', name: 'shared' }] };
    const args = runArgs(withRoots);
    expect(args.join(' ')).toContain('--volume /Users/user/Docs:/ext/Docs:ro');
    expect(args.join(' ')).toContain('--volume /data/shared:/ext/shared:ro');
    const cmd = args.slice(args.indexOf('--listen'));
    expect(cmd).toEqual(expect.arrayContaining(['--readonly-workspace', '/ext/Docs', '/ext/shared']));
    expect(specSignature(withRoots)).not.toBe(specSignature(spec));
    expect(specSignature({ ...withRoots })).toBe(specSignature(withRoots));
    // Nothing writable besides the vault and the workspaces volume.
    expect(mountsFor(withRoots).filter((m) => !m.readOnly)).toEqual([{ host: '/Users/user/Vault', guest: '/vault', readOnly: false }]);
  });

  it('shared folders: read-write mounts at /work/<name> plus read-write workspaces', () => {
    const withFolders = { ...spec, workFolders: [{ host: '/Users/user/projects/repo', name: 'repo' }] };
    const args = runArgs(withFolders);
    expect(args.join(' ')).toContain('--volume /Users/user/projects/repo:/work/repo ');
    expect(args.join(' ')).not.toContain('/work/repo:ro');
    const cmd = args.slice(args.indexOf('--listen'));
    expect(cmd.join(' ')).toContain('--workspace /work/repo');
    expect(specSignature(withFolders)).not.toBe(specSignature(spec));
  });

  it('resolveWorkFolders vets the user\'s list: existing absolute directories, never / or the vault', () => {
    const exists = new Set(['/p/repo', '/q/repo', '/Users/user/Vault', '/Users/user/Vault/sub', '/Users/user']);
    const got = resolveWorkFolders(['/p/repo', '/q/repo', '/', '', '  ', 'relative', '/Users/user/Vault', '/Users/user/Vault/sub', '/Users/user', '/nope', '/a:b'], { vaultPath: '/Users/user/Vault', isDirectory: (p) => exists.has(p) });
    expect(got).toEqual([{ host: '/p/repo', name: 'repo' }, { host: '/q/repo', name: 'repo-2' }]);
    expect(resolveWorkFolders(undefined, { vaultPath: '/v', isDirectory: () => true })).toEqual([]);
  });

  it('resolveExternalRoots vets what the host reports', () => {
    const exists = new Set(['/a/Docs', '/b/Docs', '/c/data', '/Users/user/Vault/sub']);
    const got = resolveExternalRoots([
      { label: 'Docs', path: '/b/Docs' },
      { label: 'Docs', path: '/a/Docs' },
      { label: 'dup', path: '/a/Docs' },
      { label: 'rel', path: 'relative/dir' },
      { label: 'colon', path: '/x:y' },
      { label: 'dots', path: '/a/../etc' },
      { label: 'missing', path: '/nope' },
      { label: 'insideVault', path: '/Users/user/Vault/sub' },
      { label: 'odd label/with*chars', path: '/c/data/' },
    ], { vaultPath: '/Users/user/Vault', isDirectory: (p) => exists.has(p) });
    expect(got).toEqual([
      { host: '/a/Docs', name: 'Docs' },
      { host: '/b/Docs', name: 'Docs-2' },
      { host: '/c/data', name: 'odd-label-with-chars' },
    ]);
    expect(resolveExternalRoots(undefined, { vaultPath: '/v', isDirectory: () => true })).toEqual([]);
  });

  it('a folder shared read-write and also an external root is mounted once, read-write (no conflicting double mount)', () => {
    const work = [{ host: '/a/Docs', name: 'Docs' }];
    const roots = [{ host: '/a/Docs', name: 'Docs' }, { host: '/a/Docs/sub', name: 'sub' }, { host: '/a', name: 'a' }, { host: '/b/Other', name: 'Other' }];
    expect(dropOverlappingRoots(roots, work)).toEqual([{ host: '/b/Other', name: 'Other' }]);
    expect(dropOverlappingRoots(roots, [])).toEqual(roots);
    const mounts = mountsFor({ vaultPath: '/v', maskedDirs: [], workFolders: work, externalRoots: dropOverlappingRoots(roots, work) });
    expect(mounts.filter((m) => m.host === '/a/Docs')).toEqual([{ host: '/a/Docs', guest: '/work/Docs', readOnly: false }]);
  });

  it('resource limits: validated before they reach argv, defaults on anything invalid', () => {
    expect(resolveDaemonMemory('8g')).toBe('8G');
    expect(resolveDaemonMemory(' 2048M ')).toBe('2048M');
    for (const bad of [undefined, null, '', '0G', '4', '4GB', 'lots', '-1G', '4G --privileged']) expect(resolveDaemonMemory(bad as never), String(bad)).toBe('4G');
    expect(resolveDaemonCpus(8)).toBe(8);
    expect(resolveDaemonCpus(500)).toBe(64);
    for (const bad of [undefined, null, 0, -2, 1.5, Number.NaN, '4' as never]) expect(resolveDaemonCpus(bad as never), String(bad)).toBe(4);
    const args = runArgs({ ...spec, memory: resolveDaemonMemory('6G'), cpus: resolveDaemonCpus(6) });
    expect(args).toEqual(expect.arrayContaining(['--memory', '6G', '--cpus', '6']));
  });

  it('refuses a vault path the runtime would mis-parse', () => {
    expect(() => runArgs({ ...spec, vaultPath: '/Users/user/My:Vault' })).toThrow(SpecError);
    expect(() => runArgs({ ...spec, vaultPath: 'relative/vault' })).toThrow(SpecError);
    expect(() => runArgs({ ...spec, vaultPath: '/a/../b' })).toThrow(SpecError);
    expect(() => runArgs({ ...spec, hostPort: 0 })).toThrow(SpecError);
  });

  it('labels every container as ours, with its version and spec', () => {
    const labels = labelsFor(spec);
    expect(labels['com.rbcodelabs.agent-threads.local-daemon']).toBe('1');
    expect(labels['com.rbcodelabs.agent-threads.local-daemon.version']).toBe('0.65.0');
    expect(labels['com.rbcodelabs.agent-threads.local-daemon.spec']).toBe(specSignature(spec));
  });

  it('prepare: root one-shot, credential only on stdin (never in argv)', () => {
    const secret = 'sk-ant-oat01-SECRETVALUE';
    const args = prepareArgs({ vaultPath: spec.vaultPath, version: '0.65.0', withCredential: true });
    expect(args.join(' ')).not.toContain(secret);
    expect(args).toContain('-i');
    expect(args.slice(args.indexOf('-u'), args.indexOf('-u') + 4)).toEqual(['-u', '0', '--entrypoint', 'sh']);
    expect(prepareArgs({ vaultPath: spec.vaultPath, version: '0.65.0', withCredential: false })).not.toContain('-i');
    const script = prepareScript(true);
    expect(script).toContain('cat > /var/lib/agent-threads/creds/claude-token.tmp');
    expect(script).toContain('umask 077');
    expect(script).not.toMatch(/chown -R/);
    expect(prepareScript(false)).not.toContain('cat >');
  });

  it('exec: token commands run as the daemon user with explicit data dir, never pass a token in argv', () => {
    const args = tokenCreateArgs('c1');
    expect(args).toEqual(['exec', '--user', '10001', 'c1', 'agent-threads', 'token', 'create', '--name', 'geode-local', '--scope', 'control', '--json', '--data-dir', '/var/lib/agent-threads']);
    expect(credentialPresentArgs('c1')).toEqual(['exec', '--user', '10001', 'c1', 'test', '-s', '/var/lib/agent-threads/creds/claude-token']);
    expect(publishedImageRef('1.2.3')).toBe('ghcr.io/rbcodelabs/agent-threads-daemon:1.2.3');
  });
});

describe('specSignature', () => {
  it('is stable and changes with anything fixed at run', () => {
    expect(specSignature(spec)).toBe(specSignature({ ...spec }));
    for (const change of [{ hostPort: 7434 }, { version: '0.66.0' }, { maskedDirs: ['.geode'] }, { memory: '8G' }, { cpus: 2 }, { vaultPath: '/Users/user/Other' }]) {
      expect(specSignature({ ...spec, ...change })).not.toBe(specSignature(spec));
    }
  });
});

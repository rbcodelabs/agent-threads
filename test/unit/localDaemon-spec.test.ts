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
  vaultPath: '/Users/rick/Vault',
  version: '0.65.0',
  hostPort: 7433,
  maskedDirs: ['.geode', '.obsidian'],
  memory: '4G',
  cpus: 4,
};

describe('names', () => {
  it('derives stable, per-vault names', () => {
    const h = vaultHash('/Users/rick/Vault');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(vaultHash('/Users/rick/Vault/')).toBe(h);
    expect(vaultHash('/Users/rick/Other')).not.toBe(h);
    expect(containerNameFor('/Users/rick/Vault')).toBe(`agent-threads-local-${h}`);
    expect(dataVolumeFor('/Users/rick/Vault')).toBe(`agent-threads-local-${h}-data`);
    expect(workspacesVolumeFor('/Users/rick/Vault')).toBe(`agent-threads-local-${h}-workspaces`);
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
      '/Users/rick/Vault:/vault',
      '/Users/rick/Vault/.geode:/vault/.geode:ro',
      '/Users/rick/Vault/.obsidian:/vault/.obsidian:ro',
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
    expect(args.join(' ')).toContain('/Users/rick/Vault/.obsidian:/vault/.obsidian:ro');
    expect(mountsFor({ vaultPath: '/v/', maskedDirs: [] })).toEqual([{ host: '/v', guest: '/vault', readOnly: false }]);
  });

  it('refuses a vault path the runtime would mis-parse', () => {
    expect(() => runArgs({ ...spec, vaultPath: '/Users/rick/My:Vault' })).toThrow(SpecError);
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
    for (const change of [{ hostPort: 7434 }, { version: '0.66.0' }, { maskedDirs: ['.geode'] }, { memory: '8G' }, { cpus: 2 }, { vaultPath: '/Users/rick/Other' }]) {
      expect(specSignature({ ...spec, ...change })).not.toBe(specSignature(spec));
    }
  });
});

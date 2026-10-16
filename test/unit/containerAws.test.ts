/**
 * Container AWS credentials: config trimming (secrets and unlisted profiles
 * excluded), profile defaults, mount planning, env, and how the mounts behave
 * through resolveClaudeVmRouting for fresh vs. already-existing containers.
 */
import { describe, it, expect } from 'vitest';
import {
  AWS_GUEST_CONFIG, AWS_GUEST_SSO_CACHE, buildContainerAwsConfig, containerAwsEnv,
  parseProfileList, planContainerAwsMounts, resolveContainerAwsProfiles, type ContainerAwsFs,
} from '../../src/containerAws';
import { resolveClaudeVmRouting } from '../../src/harnessVmRouting';
import { SandboxVmManager, buildImageInspectArgs, buildInspectArgs, LABEL_EXTRA_MOUNTS, type VmCommandResult, type VmCommandRunner } from '../../src/sandboxVm';
import { mountSignature } from '../../src/skillMounts';
import { DEFAULT_SETTINGS } from '../../src/types';

const HOST_CONFIG = `
[default]
region = us-east-1
aws_access_key_id = AKIASECRETKEYID
aws_secret_access_key = SECRETACCESSKEYVALUE
aws_session_token = SESSIONTOKENVALUE

[profile Dev]
sso_session = corp
sso_account_id = 111111111111
sso_role_name = Dev
region = us-east-1
credential_process = /usr/local/bin/steal-creds

[profile Deploy]
sso_session = corp
sso_account_id = 222222222222
sso_role_name = Admin

[profile Other]
sso_session = other
sso_account_id = 333333333333
sso_role_name = Other

[profile Assumed]
role_arn = arn:aws:iam::444444444444:role/x
source_profile = Dev
mfa_serial = arn:aws:iam::1:mfa/me

[sso-session corp]
sso_start_url = https://corp.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access

[sso-session other]
sso_start_url = https://other.awsapps.com/start
sso_region = us-east-1
`;

describe('buildContainerAwsConfig', () => {
  it('includes only the listed profiles and the sso-sessions they use', () => {
    const { text, included, missing } = buildContainerAwsConfig(HOST_CONFIG, ['Dev']);
    expect(included).toEqual(['Dev']);
    expect(missing).toEqual([]);
    expect(text).toContain('[profile Dev]');
    expect(text).toContain('[sso-session corp]');
    expect(text).toContain('sso_account_id = 111111111111');
    for (const excluded of ['Deploy', 'Other', 'Assumed', '[default]', 'sso-session other', '222222222222', '333333333333', 'other.awsapps']) {
      expect(text).not.toContain(excluded);
    }
  });

  it('never copies secrets or credential_process, even for a listed profile', () => {
    const { text } = buildContainerAwsConfig(HOST_CONFIG, ['default', 'Dev', 'Assumed']);
    for (const secret of ['AKIASECRETKEYID', 'SECRETACCESSKEYVALUE', 'SESSIONTOKENVALUE', 'aws_secret', 'aws_access_key', 'aws_session_token', 'credential_process', 'steal-creds', 'mfa_serial']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('[default]');
    expect(text).toContain('region = us-east-1');
  });

  it('follows source_profile chains and reports unknown profiles', () => {
    const { included, missing } = buildContainerAwsConfig(HOST_CONFIG, ['Assumed', 'Nope']);
    expect(included.sort()).toEqual(['Assumed', 'Dev']);
    expect(missing).toEqual(['Nope']);
  });
});

describe('profile selection', () => {
  it('parses newline/comma lists, deduped', () => {
    expect(parseProfileList('a\n b ,a,,c')).toEqual(['a', 'b', 'c']);
    expect(parseProfileList(undefined)).toEqual([]);
  });

  it('defaults to the Extra-env AWS_PROFILE on Bedrock; empty setting by default', () => {
    expect(DEFAULT_SETTINGS.containerAwsProfiles).toBe('');
    expect(resolveContainerAwsProfiles({ provider: 'bedrock', settingValue: '', extraEnv: 'AWS_REGION=us-east-1\nAWS_PROFILE=Dev' })).toEqual(['Dev']);
  });

  it('adds listed profiles to the env profile', () => {
    expect(resolveContainerAwsProfiles({ provider: 'bedrock', settingValue: 'Deploy', extraEnv: 'AWS_PROFILE=Dev' })).toEqual(['Dev', 'Deploy']);
  });

  it('is off for the Claude provider with an empty setting, on when the setting is non-empty', () => {
    expect(resolveContainerAwsProfiles({ provider: 'claude', settingValue: '', extraEnv: 'AWS_PROFILE=Dev' })).toEqual([]);
    expect(resolveContainerAwsProfiles({ provider: undefined, settingValue: '  ', extraEnv: 'AWS_PROFILE=Dev' })).toEqual([]);
    expect(resolveContainerAwsProfiles({ provider: 'claude', settingValue: 'Deploy', extraEnv: 'AWS_PROFILE=Dev' })).toEqual(['Dev', 'Deploy']);
  });

  it('is empty on Bedrock with no profile anywhere', () => {
    expect(resolveContainerAwsProfiles({ provider: 'bedrock', settingValue: '', extraEnv: '' })).toEqual([]);
  });
});

function memFs(files: Record<string, string>) {
  const written: Record<string, string> = {};
  const dirs: string[] = [];
  const fs: ContainerAwsFs = {
    readFile: (p) => files[p] ?? null,
    ensureDir: (p) => { dirs.push(p); return true; },
    writeFile: (p, c) => { written[p] = c; },
  };
  return { fs, written, dirs };
}

describe('planContainerAwsMounts', () => {
  const base = { homeDir: '/Users/me', dataDir: '/vault/.geode/plugins/claude-threads' };

  it('plans two read-only mounts and writes the trimmed config into the plugin folder', () => {
    const m = memFs({ '/Users/me/.aws/config': HOST_CONFIG });
    const plan = planContainerAwsMounts({ ...base, profiles: ['Dev'], fs: m.fs })!;
    expect(plan.mounts).toEqual([
      { hostPath: '/Users/me/.aws/sso/cache', guestPath: AWS_GUEST_SSO_CACHE },
      { hostPath: '/vault/.geode/plugins/claude-threads/container-aws/config', guestPath: AWS_GUEST_CONFIG },
    ]);
    expect(plan.mounts.every((x) => !x.readWrite)).toBe(true);
    expect(m.written['/vault/.geode/plugins/claude-threads/container-aws/config']).toContain('[profile Dev]');
    expect(plan.profiles).toEqual(['Dev']);
  });

  it('honours a custom host AWS_CONFIG_FILE', () => {
    const m = memFs({ '/custom/aws-config': HOST_CONFIG });
    expect(planContainerAwsMounts({ ...base, profiles: ['Dev'], hostConfigPath: '/custom/aws-config', fs: m.fs })).not.toBeNull();
  });

  it('returns null with no profiles, no data dir, or no host config', () => {
    const m = memFs({ '/Users/me/.aws/config': HOST_CONFIG });
    expect(planContainerAwsMounts({ ...base, profiles: [], fs: m.fs })).toBeNull();
    expect(planContainerAwsMounts({ ...base, profiles: ['Dev'], dataDir: '', fs: m.fs })).toBeNull();
    expect(planContainerAwsMounts({ ...base, profiles: ['Dev'], fs: memFs({}).fs })).toBeNull();
    expect(m.written).toEqual({});
  });

  it('mounts nothing, and warns, when no listed profile exists in the host config', () => {
    const m = memFs({ '/Users/me/.aws/config': HOST_CONFIG });
    const plan = planContainerAwsMounts({ ...base, profiles: ['Nope'], fs: m.fs })!;
    expect(plan.mounts).toEqual([]);
    expect(plan.warnings[0]).toContain('Nope');
    expect(m.written).toEqual({});
  });
});

describe('containerAwsEnv', () => {
  const mounts = [{ hostPath: '/h/c', guestPath: AWS_GUEST_CONFIG }];
  it('sets AWS_CONFIG_FILE only when the container really has the config mount', () => {
    expect(containerAwsEnv(mounts)).toEqual({ AWS_CONFIG_FILE: '/aws/config', AWS_EC2_METADATA_DISABLED: 'true' });
    expect(containerAwsEnv([])).toEqual({});
    expect(containerAwsEnv(undefined, {})).toEqual({});
  });
  it('fails fast on Bedrock even when the container lacks the mounts (no silent IMDS hang)', () => {
    expect(containerAwsEnv([], { CLAUDE_CODE_USE_BEDROCK: '1' })).toEqual({ AWS_EC2_METADATA_DISABLED: 'true' });
  });
});

describe('through resolveClaudeVmRouting', () => {
  const NAME = 'claude-threads-vm-test-thread';
  const IMAGE = 'claude-threads-harness-aws:1';
  const awsPlan = {
    mounts: [
      { hostPath: '/Users/me/.aws/sso/cache', guestPath: AWS_GUEST_SSO_CACHE },
      { hostPath: '/p/container-aws/config', guestPath: AWS_GUEST_CONFIG },
    ],
    profiles: ['Dev'], warnings: [],
  };
  const make = (script: Record<string, Partial<VmCommandResult>>) => {
    const calls: string[][] = [];
    const run: VmCommandRunner = async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: '', stderr: '', ...(script[args.join(' ')] ?? {}) };
    };
    return { manager: new SandboxVmManager({ containerName: () => NAME, run }), calls };
  };
  const inputs = (manager: SandboxVmManager, withAws: boolean) => ({
    mode: 'auto' as const, image: IMAGE, vmManager: manager, mountPath: '/work', platform: 'darwin', arch: 'arm64',
    ...(withAws ? { awsMountPlan: awsPlan } : {}),
  });
  const base = {
    '--version': { stdout: 'container CLI version 1.3.1\n' },
    [buildImageInspectArgs(IMAGE).join(' ')]: { exitCode: 0 },
  };

  it('creates a fresh container with both mounts read-only and records them in the mounts label', async () => {
    const { manager, calls } = make({ ...base, [buildInspectArgs(NAME).join(' ')]: { exitCode: 1, stderr: 'nf' } });
    const r = await resolveClaudeVmRouting(inputs(manager, true));
    const run = calls.find((c) => c[0] === 'run')!;
    expect(run).toContain('/Users/me/.aws/sso/cache:/aws/sso-cache:ro');
    expect(run).toContain('/p/container-aws/config:/aws/config:ro');
    expect(run).toContain(`${LABEL_EXTRA_MOUNTS}=${mountSignature(awsPlan.mounts)}`);
    expect(r).toMatchObject({ routed: true, routing: { mountedExtra: awsPlan.mounts } });
  });

  it('adds no AWS mounts or env when the plan is absent', async () => {
    const { manager, calls } = make({ ...base, [buildInspectArgs(NAME).join(' ')]: { exitCode: 1, stderr: 'nf' } });
    const r = await resolveClaudeVmRouting(inputs(manager, false));
    expect(calls.find((c) => c[0] === 'run')!.join(' ')).not.toContain('/aws/');
    expect(r).toMatchObject({ routed: true, routing: { mountedExtra: [] } });
  });

  it('keeps an existing container as-is: it reports the mounts it was created with, so AWS env is not set for it', async () => {
    const existing = JSON.stringify([{ status: 'running', configuration: { labels: { 'claude-threads.origin': 'harness', [LABEL_EXTRA_MOUNTS]: '' } } }]);
    const { manager, calls } = make({ ...base, [buildInspectArgs(NAME).join(' ')]: { exitCode: 0, stdout: existing } });
    const r = await resolveClaudeVmRouting(inputs(manager, true));
    expect(calls.some((c) => c[0] === 'run' || c[0] === 'delete' || c[0] === 'rm')).toBe(false);
    if (!r.routed) throw new Error('expected routed');
    expect(r.routing.mountedExtra).toEqual([]);
    expect(containerAwsEnv(r.routing.mountedExtra)).toEqual({});
  });

  it('an existing container that already has the mounts gets the AWS env', async () => {
    const existing = JSON.stringify([{ status: 'running', configuration: { labels: { 'claude-threads.origin': 'harness', [LABEL_EXTRA_MOUNTS]: mountSignature(awsPlan.mounts) } } }]);
    const { manager } = make({ ...base, [buildInspectArgs(NAME).join(' ')]: { exitCode: 0, stdout: existing } });
    const r = await resolveClaudeVmRouting(inputs(manager, true));
    if (!r.routed) throw new Error('expected routed');
    expect(containerAwsEnv(r.routing.mountedExtra).AWS_CONFIG_FILE).toBe('/aws/config');
  });
});

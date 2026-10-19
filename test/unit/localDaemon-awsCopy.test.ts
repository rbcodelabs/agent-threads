/**
 * AWS credentials for the managed local daemon (ported from the removed sandbox VM's container AWS mounts).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildDaemonAwsConfig,
  daemonAwsEnv,
  parseProfileList,
  planAwsCopy,
  resolveDaemonAwsProfiles,
  type AwsCopyFs,
} from '../../src/localDaemon/awsCopy';

const sha1 = (t: string) => createHash('sha1').update(t).digest('hex');

const CONFIG = `
[default]
region = eu-west-1
aws_access_key_id = AKIA_SHOULD_NEVER_LEAVE
aws_secret_access_key = hunter2

[profile deploy]
sso_session = corp
sso_account_id = 111111111111
sso_role_name = Admin
region = us-east-1
credential_process = /usr/local/bin/steal-secrets

[profile via]
role_arn = arn:aws:iam::222222222222:role/x
source_profile = deploy
role_session_name = s

[profile legacy]
sso_start_url = https://legacy.example/start
sso_region = us-east-1
sso_account_id = 333333333333
sso_role_name = Dev

[profile unrelated]
region = ap-south-1
aws_session_token = SESSIONTOKEN

[sso-session corp]
sso_start_url = https://corp.example/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access
`;

function fakeFs(files: Record<string, string>): AwsCopyFs {
  return { readFile: (p) => files[p] ?? null, sha1Hex: sha1 };
}

describe('profile selection', () => {
  it('parses newline/comma lists, de-duplicates and drops unsafe names', () => {
    expect(parseProfileList('a\n b ,c\na\n\n[x]')).toEqual(['a', 'b', 'c']);
    expect(parseProfileList(undefined)).toEqual([]);
  });

  it('is off unless the session is on Bedrock or profiles are listed', () => {
    expect(resolveDaemonAwsProfiles({ provider: 'claude', settingValue: '', extraEnv: 'AWS_PROFILE=p' })).toEqual([]);
    expect(resolveDaemonAwsProfiles({ provider: 'bedrock', settingValue: '', extraEnv: 'AWS_PROFILE=p' })).toEqual(['p']);
    expect(resolveDaemonAwsProfiles({ provider: 'claude', settingValue: 'deploy', extraEnv: 'AWS_PROFILE=p' })).toEqual(['p', 'deploy']);
  });
});

describe('trimmed config', () => {
  it('keeps only the wanted profiles, their source_profile chain and their sso-session, and only allowlisted keys', () => {
    const { text, included, missing } = buildDaemonAwsConfig(CONFIG, ['via', 'ghost']);
    expect(included.sort()).toEqual(['deploy', 'via']);
    expect(missing).toEqual(['ghost']);
    expect(text).toContain('[profile via]');
    expect(text).toContain('[profile deploy]');
    expect(text).toContain('[sso-session corp]');
    expect(text).toContain('sso_start_url = https://corp.example/start');
    for (const never of ['credential_process', 'steal-secrets', 'AKIA_SHOULD_NEVER_LEAVE', 'hunter2', 'SESSIONTOKEN', 'unrelated', 'legacy']) {
      expect(text).not.toContain(never);
    }
  });
});

describe('planAwsCopy', () => {
  const home = '/Users/me';

  it('copies the config and exactly one token file per SSO session, named like the AWS SDK names it', () => {
    const corpToken = '{"accessToken":"AT1","refreshToken":"RT1"}';
    const plan = planAwsCopy({
      profiles: ['via'], homeDir: home,
      fs: fakeFs({
        [`${home}/.aws/config`]: CONFIG,
        [`${home}/.aws/sso/cache/${sha1('corp')}.json`]: corpToken,
        [`${home}/.aws/sso/cache/${sha1('other-session')}.json`]: '{"accessToken":"NOT_OURS"}',
      }),
    })!;
    expect(plan.profiles.sort()).toEqual(['deploy', 'via']);
    expect(plan.files.map((f) => f.p).sort()).toEqual(['config', `sso/cache/${sha1('corp')}.json`]);
    const token = plan.files.find((f) => f.p.startsWith('sso/'))!;
    expect(Buffer.from(token.b, 'base64').toString()).toBe(corpToken);
    // The other session's token is never read into the plan.
    expect(JSON.stringify(plan.files)).not.toContain(Buffer.from('NOT_OURS').toString('base64'));
    expect(plan.warnings).toEqual([]);
  });

  it('uses the start URL as the cache key for a legacy (non sso-session) profile', () => {
    const plan = planAwsCopy({
      profiles: ['legacy'], homeDir: home,
      fs: fakeFs({ [`${home}/.aws/config`]: CONFIG, [`${home}/.aws/sso/cache/${sha1('https://legacy.example/start')}.json`]: '{}' }),
    })!;
    expect(plan.files.map((f) => f.p)).toContain(`sso/cache/${sha1('https://legacy.example/start')}.json`);
  });

  it('warns (never fails) when the user has not signed in or a profile is missing, and honours AWS_CONFIG_FILE', () => {
    const plan = planAwsCopy({
      profiles: ['deploy', 'ghost'], homeDir: home, hostConfigPath: '/custom/aws-config',
      fs: fakeFs({ '/custom/aws-config': CONFIG }),
    })!;
    expect(plan.files.map((f) => f.p)).toEqual(['config']);
    expect(plan.warnings.join('\n')).toContain('"ghost" is not in /custom/aws-config');
    expect(plan.warnings.join('\n')).toContain('"deploy" has no SSO token on this Mac yet');
  });

  it('does nothing without profiles or without a host config', () => {
    expect(planAwsCopy({ profiles: [], homeDir: home, fs: fakeFs({}) })).toBeNull();
    expect(planAwsCopy({ profiles: ['deploy'], homeDir: home, fs: fakeFs({}) })).toBeNull();
    expect(planAwsCopy({ profiles: ['deploy'], homeDir: 'relative', fs: fakeFs({}) })).toBeNull();
  });

  it('never copies static keys: a non-SSO profile contributes only its (trimmed) config', () => {
    const plan = planAwsCopy({ profiles: ['default'], homeDir: home, fs: fakeFs({ [`${home}/.aws/config`]: CONFIG }) })!;
    expect(plan.files.map((f) => f.p)).toEqual(['config']);
    expect(Buffer.from(plan.files[0].b, 'base64').toString()).not.toContain('hunter2');
  });
});

describe('environment', () => {
  it('turns EC2 metadata lookups off whenever AWS is in play, so a missing login fails fast', () => {
    expect(daemonAwsEnv(true)).toEqual({ AWS_EC2_METADATA_DISABLED: 'true' });
    expect(daemonAwsEnv(false, { CLAUDE_CODE_USE_BEDROCK: '1' })).toEqual({ AWS_EC2_METADATA_DISABLED: 'true' });
    expect(daemonAwsEnv(false, {})).toEqual({});
  });
});

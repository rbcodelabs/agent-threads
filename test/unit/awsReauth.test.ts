import { describe, it, expect } from 'vitest';
import { awsSignInEnv, resolveSignInProfile } from '../../src/awsReauth';

const ERR = "Could not load AWS credentials · SSO session token associated with profile=from-error was not found";

describe('resolveSignInProfile', () => {
  it('prefers extra-env AWS_PROFILE', () => {
    expect(resolveSignInProfile({ provider: 'bedrock', extraEnv: 'AWS_PROFILE=cfg\nAWS_REGION=us-east-1' }, ERR, { AWS_PROFILE: 'app' })).toBe('cfg');
  });
  it('then the app process env', () => {
    expect(resolveSignInProfile({ provider: 'bedrock', extraEnv: '' }, ERR, { AWS_PROFILE: 'app' })).toBe('app');
  });
  it('then the profile named in the error', () => {
    expect(resolveSignInProfile({ provider: 'bedrock', extraEnv: '' }, ERR, {})).toBe('from-error');
  });
  it('is null when nothing names a profile', () => {
    expect(resolveSignInProfile({ provider: 'bedrock', extraEnv: '' }, 'nope', {})).toBeNull();
  });
});

describe('awsSignInEnv', () => {
  it('layers extra-env AWS_* over a widened PATH', () => {
    const env = awsSignInEnv({ provider: 'bedrock', extraEnv: 'AWS_REGION=eu-west-1' });
    expect(env.AWS_REGION).toBe('eu-west-1');
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.PATH).toBeTruthy();
  });
});

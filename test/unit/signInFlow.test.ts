import { describe, expect, it } from 'vitest';
import { chooseClaudeSignInFlow, manualRemoteSignInHint } from '../../src/remote/signInFlow';

describe('chooseClaudeSignInFlow (card branch order: aws, local-container, remote, host)', () => {
  it('AWS expiry wins over everything', () => {
    expect(chooseClaudeSignInFlow({ awsExpired: true, daemon: { managed: 'local-container' }, capabilities: ['auth.signin'] })).toBe('aws');
  });
  it('the managed local container signs in inside the container', () => {
    expect(chooseClaudeSignInFlow({ awsExpired: false, daemon: { managed: 'local-container' }, capabilities: undefined })).toBe('local-container');
  });
  it('a remote daemon with the auth.signin capability signs in on the daemon', () => {
    expect(chooseClaudeSignInFlow({ awsExpired: false, daemon: {}, capabilities: ['harness.claude', 'auth.signin'] })).toBe('remote');
  });
  it('a remote daemon whose capabilities are not known yet is tried (old daemons get instructions from the error)', () => {
    expect(chooseClaudeSignInFlow({ awsExpired: false, daemon: {}, capabilities: undefined })).toBe('remote');
  });
  it('a remote daemon without the capability gets manual instructions, never the host login', () => {
    expect(chooseClaudeSignInFlow({ awsExpired: false, daemon: {}, capabilities: ['harness.claude'] })).toBe('remote-manual');
  });
  it('a host thread signs in on this computer', () => {
    expect(chooseClaudeSignInFlow({ awsExpired: false, daemon: undefined, capabilities: undefined })).toBe('host');
  });
});

describe('manualRemoteSignInHint', () => {
  it('names the box and the ssh command for its host', () => {
    const hint = manualRemoteSignInHint('my-box', 'wss://my-box.tail1234.ts.net:8443');
    expect(hint).toContain('"my-box"');
    expect(hint).toContain('ssh my-box.tail1234.ts.net -t claude /login');
  });
  it('tolerates a bare host:port', () => {
    expect(manualRemoteSignInHint('b', '10.0.0.5:8080')).toContain('ssh 10.0.0.5 -t claude /login');
  });
});

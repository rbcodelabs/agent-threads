import { describe, expect, it } from 'vitest';
import { buildRemoteEnvironmentPrompt, buildRemoteVaultAddendum } from '../../src/remote/sessionSpec';

const vault = { mapping: { remoteRoot: '/home/rick/vault' }, vaultFolder: 'Claude Threads', saveThreadsToVault: true };

describe('remote environment prompt: vault addendum', () => {
  it('is unchanged for a thread outside the mirrored vault, even when a mapping exists', () => {
    const plain = buildRemoteEnvironmentPrompt('/home/rick/projects/x', 'claude-box', 'Geode');
    expect(buildRemoteEnvironmentPrompt('/home/rick/projects/x', 'claude-box', 'Geode', vault)).toBe(plain);
    expect(plain).not.toMatch(/vault \(synced mirror\)/i);
  });

  it('adds the mirror rules, with remote-correct paths, when the cwd is inside the remote root', () => {
    const p = buildRemoteEnvironmentPrompt('/home/rick/vault/Products/Agent Threads', 'claude-box', 'Geode', vault);
    expect(p).toContain('Working directory: /home/rick/vault/Products/Agent Threads');
    expect(p).toContain('Vault (synced mirror):');
    expect(p).toContain('mirrored on this machine at /home/rick/vault');
    expect(p).toContain('"Products/Agent Threads" inside it');
    expect(p).toMatch(/COPY kept in sync/);
    expect(p).toMatch(/up to about 5 minutes/);
    expect(p).toMatch(/conflict/);
    expect(p).toContain('Never delete or rename vault files unless the user explicitly asks');
    expect(p).toContain('/home/rick/vault/Daily/YYYY-MM-DD.md');
    expect(p).toContain('"## Claude Sessions"');
    expect(p).toContain('/home/rick/vault/Claude Threads/');
  });

  it('never leaks a Mac path or promises vault_* tools', () => {
    const p = buildRemoteEnvironmentPrompt('/home/rick/vault', 'claude-box', 'Geode', vault);
    expect(p).not.toMatch(/\/Users\//);
    expect(p).toMatch(/vault_\*.*not available/);
    expect(p).not.toMatch(/Vault root \(filesystem path\)/);
  });

  it('applies at the vault root itself and omits the "inside it" note there', () => {
    const p = buildRemoteEnvironmentPrompt('/home/rick/vault/', 'claude-box', 'Geode', vault);
    expect(p).toContain('Vault (synced mirror):');
    expect(p).not.toContain('inside it');
  });

  it('does not apply to a lookalike sibling folder', () => {
    expect(buildRemoteEnvironmentPrompt('/home/rick/vault-old', 'claude-box', 'Geode', vault)).not.toContain('synced mirror');
  });

  it('omits the history line when threads are not saved to the vault', () => {
    const lines = buildRemoteVaultAddendum('/home/rick/vault', { mapping: vault.mapping, saveThreadsToVault: false, vaultFolder: 'Claude Threads' });
    expect(lines.join('\n')).not.toContain('Conversation history');
  });
});

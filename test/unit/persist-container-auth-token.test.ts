/**
 * `ClaudeThreadsPlugin.persistContainerAuthToken()` (src/main.ts) — after a
 * successful ADR-0015 container sign-in (`signInToClaudeInContainer`), stores
 * the resulting OAuth token and restarts the thread's session so the next
 * turn picks it up.
 *
 * The token is a SEPARATE credential (`CONTAINER_AUTH_TOKEN_SECRET`), never a
 * `CLAUDE_CODE_OAUTH_TOKEN` entry in `secretEnvKeys`. `secretEnv` reaches every
 * session including host-spawned ones, and an env `CLAUDE_CODE_OAUTH_TOKEN`
 * overrides the host keychain login — a container-only token there broke (and,
 * once truncated/stale, poisoned with 401s) every host thread. Live-observed.
 *
 * Constructed the same way as request-secret-session-restart.test.ts: a
 * minimal instance via Object.create(ClaudeThreadsPlugin.prototype).
 */
import { describe, expect, it, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';
import { secretStorageKey } from '../../src/secretUtils';
import { CONTAINER_AUTH_TOKEN_SECRET } from '../../src/claudeContainerAuthCli';
import type { PluginSettings } from '../../src/types';

function makePlugin(settings: PluginSettings) {
  const plugin = Object.create(ClaudeThreadsPlugin.prototype) as ClaudeThreadsPlugin;
  const setSecret = vi.fn();
  const requestSessionRestart = vi.fn();
  const saveSettings = vi.fn(async () => {});
  (plugin as unknown as { settings: PluginSettings }).settings = settings;
  (plugin as unknown as { app: { secretStorage: { setSecret: typeof setSecret } } }).app = { secretStorage: { setSecret } };
  (plugin as unknown as { manager: { requestSessionRestart: typeof requestSessionRestart } }).manager = { requestSessionRestart };
  (plugin as unknown as { saveSettings: typeof saveSettings }).saveSettings = saveSettings;
  return { plugin, setSecret, requestSessionRestart, saveSettings };
}

describe('ClaudeThreadsPlugin.persistContainerAuthToken', () => {
  it('stores the token under its own secret key and restarts the thread\'s session', async () => {
    const { plugin, setSecret, requestSessionRestart } = makePlugin({ secretEnvKeys: [] } as unknown as PluginSettings);

    await plugin.persistContainerAuthToken('t1', 'sk-ant-oat01-abc');

    expect(setSecret).toHaveBeenCalledWith(secretStorageKey(CONTAINER_AUTH_TOKEN_SECRET), 'sk-ant-oat01-abc');
    expect(requestSessionRestart).toHaveBeenCalledWith('t1');
  });

  it('is NOT named CLAUDE_CODE_OAUTH_TOKEN, so it can never be injected as a general secret env var', () => {
    expect(CONTAINER_AUTH_TOKEN_SECRET).not.toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('never registers the token in secretEnvKeys / secretEnvScopes (which reach host-spawned sessions too)', async () => {
    const settings = { secretEnvKeys: ['SOMETHING_ELSE'] } as unknown as PluginSettings;
    const { plugin, saveSettings } = makePlugin(settings);

    await plugin.persistContainerAuthToken('t1', 'sk-ant-oat01-abc');

    expect(settings.secretEnvKeys).toEqual(['SOMETHING_ELSE']);
    expect(settings.secretEnvScopes).toBeUndefined();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('is global across projects: a second thread\'s sign-in just overwrites the one credential', async () => {
    const { plugin, setSecret } = makePlugin({ secretEnvKeys: [] } as unknown as PluginSettings);

    await plugin.persistContainerAuthToken('t1', 'sk-ant-oat01-first');
    await plugin.persistContainerAuthToken('t2', 'sk-ant-oat01-second');

    expect(setSecret).toHaveBeenCalledTimes(2);
    expect(setSecret).toHaveBeenLastCalledWith(secretStorageKey(CONTAINER_AUTH_TOKEN_SECRET), 'sk-ant-oat01-second');
  });
});

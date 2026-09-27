/**
 * `ClaudeThreadsPlugin.requestSecretForThread()` (src/main.ts, near
 * requestSecretFromUser) is the thread-scoped wrapper the `request_secret`
 * MCP tool's `onRequestSecret` callback now calls instead of
 * `requestSecretFromUser` directly (see the `mcpServerFactory` closure in
 * src/main.ts).
 *
 * Background: a secret saved to the OS keychain mid-conversation is only
 * read into a thread's live subprocess via `secretEnvResolver` at session
 * *start* (ClaudeSession.ts / ThreadManager.buildThreadSessionOptions). A
 * thread's session is normally reused across turns, so without this wrapper
 * a freshly-saved secret would sit invisible to the very thread that asked
 * for it until some unrelated event happened to respawn the subprocess.
 * `requestSecretForThread` closes that gap by flagging the calling thread's
 * session for restart (`ThreadManager.requestSessionRestart`, the same
 * SDK-native mechanism already used for `reloadThreadSkills`) after a
 * successful save, so the secret is picked up starting the thread's very
 * next turn while conversation history/continuity is preserved via
 * `thread.sessionId`.
 *
 * Constructed the same way as oauth-scheduled-thread-refusal.test.ts: a
 * minimal instance via Object.create(ClaudeThreadsPlugin.prototype),
 * bypassing Obsidian's Plugin constructor, with only the fields this code
 * path touches set (`requestSecretFromUser` mocked directly rather than
 * driving the real modal, and a stub `manager` exposing just
 * `requestSessionRestart`).
 */
import { describe, expect, it, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';

function makePlugin(requestSecretFromUserImpl: (secretName: string, reason: string, force?: boolean) => Promise<boolean>) {
  const plugin = Object.create(ClaudeThreadsPlugin.prototype) as ClaudeThreadsPlugin;
  const requestSecretFromUser = vi.fn(requestSecretFromUserImpl);
  const requestSessionRestart = vi.fn();
  (plugin as unknown as { requestSecretFromUser: typeof requestSecretFromUser }).requestSecretFromUser = requestSecretFromUser;
  (plugin as unknown as { manager: { requestSessionRestart: typeof requestSessionRestart } }).manager = { requestSessionRestart };
  return { plugin, requestSecretFromUser, requestSessionRestart };
}

/** Calls the private thread-scoped wrapper the same way the mcpServerFactory closure does. */
function requestSecretForThread(plugin: ClaudeThreadsPlugin, threadId: string, secretName: string, reason: string, force?: boolean) {
  return (plugin as unknown as { requestSecretForThread(threadId: string, secretName: string, reason: string, force?: boolean): Promise<boolean> })
    .requestSecretForThread(threadId, secretName, reason, force);
}

describe('ClaudeThreadsPlugin.requestSecretForThread', () => {
  it('restarts the calling thread\'s session exactly once when the secret is saved', async () => {
    const { plugin, requestSecretFromUser, requestSessionRestart } = makePlugin(async () => true);

    const result = await requestSecretForThread(plugin, 'thread-1', 'LINEAR_API_KEY', 'to list your Linear issues');

    expect(result).toBe(true);
    expect(requestSecretFromUser).toHaveBeenCalledWith('LINEAR_API_KEY', 'to list your Linear issues', undefined);
    expect(requestSessionRestart).toHaveBeenCalledTimes(1);
    expect(requestSessionRestart).toHaveBeenCalledWith('thread-1');
  });

  it('does not restart the session when the user cancels the save', async () => {
    const { plugin, requestSecretFromUser, requestSessionRestart } = makePlugin(async () => false);

    const result = await requestSecretForThread(plugin, 'thread-2', 'JIRA_API_TOKEN', 'to create a ticket');

    expect(result).toBe(false);
    expect(requestSecretFromUser).toHaveBeenCalledWith('JIRA_API_TOKEN', 'to create a ticket', undefined);
    expect(requestSessionRestart).not.toHaveBeenCalled();
  });

  it('forwards force:true through to requestSecretFromUser and still restarts on success', async () => {
    const { plugin, requestSecretFromUser, requestSessionRestart } = makePlugin(async () => true);

    const result = await requestSecretForThread(plugin, 'thread-3', 'GITHUB_TOKEN', 'token was rotated', true);

    expect(result).toBe(true);
    expect(requestSecretFromUser).toHaveBeenCalledWith('GITHUB_TOKEN', 'token was rotated', true);
    expect(requestSessionRestart).toHaveBeenCalledTimes(1);
    expect(requestSessionRestart).toHaveBeenCalledWith('thread-3');
  });

  it('forwards force:true through to requestSecretFromUser and skips restart on cancellation', async () => {
    const { plugin, requestSecretFromUser, requestSessionRestart } = makePlugin(async () => false);

    const result = await requestSecretForThread(plugin, 'thread-4', 'GITHUB_TOKEN', 'token was rotated', true);

    expect(result).toBe(false);
    expect(requestSecretFromUser).toHaveBeenCalledWith('GITHUB_TOKEN', 'token was rotated', true);
    expect(requestSessionRestart).not.toHaveBeenCalled();
  });
});

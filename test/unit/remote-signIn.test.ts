import { describe, expect, it, vi } from 'vitest';
import type { SigninEvent } from '../../src/protocol';
import { DaemonCommandError, type ConnectionState } from '../../src/remote/DaemonClient';
import { runRemoteSignIn, type RemoteSignInClient } from '../../src/remote/remoteSignIn';

const TOKEN = 'sk-ant-oat01-REMOTE_abc-123';

/** A fake WS client: records commands and lets the test push sign-in events and state changes. */
function fakeClient(opts: { startError?: Error; startReply?: Record<string, unknown> } = {}) {
  const sent: Array<{ type: string; payload: any; opts?: any }> = [];
  const eventListeners = new Set<(e: SigninEvent) => void>();
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const client: RemoteSignInClient = {
    async command(type, payload, o) {
      sent.push({ type, payload: structuredClone(payload), opts: o });
      if (type === 'auth.signin.start') {
        if (opts.startError) throw opts.startError;
        return opts.startReply ?? { flowId: 'f1' };
      }
      return {};
    },
    onSigninEvent(l) { eventListeners.add(l); return () => eventListeners.delete(l); },
    onState(l) { stateListeners.add(l); return () => stateListeners.delete(l); },
  };
  return {
    client,
    sent,
    emit: (e: SigninEvent) => [...eventListeners].forEach((l) => l(e)),
    state: (s: ConnectionState) => [...stateListeners].forEach((l) => l(s)),
    listeners: () => eventListeners.size + stateListeners.size,
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('runRemoteSignIn', () => {
  it('start, url, prompt, code, token: returns the token and releases its listeners', async () => {
    const f = fakeClient();
    const urls: string[] = [];
    const progress: string[] = [];
    const result = runRemoteSignIn(f.client, { onProgress: (t) => progress.push(t), onUrl: (u) => urls.push(u), onCodePrompt: async () => 'abc#def' });
    await tick();
    expect(f.sent[0]).toMatchObject({ type: 'auth.signin.start', opts: { resend: false } });
    f.emit({ kind: 'progress', flowId: 'f1', text: 'Waiting for browser sign-in…' });
    f.emit({ kind: 'url', flowId: 'f1', url: 'https://claude.ai/oauth/authorize?s=1' });
    f.emit({ kind: 'prompt', flowId: 'f1' });
    await tick();
    expect(f.sent.find((c) => c.type === 'auth.signin.code')).toMatchObject({ payload: { flowId: 'f1', code: 'abc#def' }, opts: { resend: false } });
    f.emit({ kind: 'token', flowId: 'f1', token: TOKEN });
    await expect(result).resolves.toEqual({ ok: true, token: TOKEN });
    expect(urls).toEqual(['https://claude.ai/oauth/authorize?s=1']);
    expect(progress).toContain('Waiting for browser sign-in…');
    expect(f.listeners()).toBe(0);
    // Nothing left running on the daemon: no cancel after success.
    expect(f.sent.some((c) => c.type === 'auth.signin.cancel')).toBe(false);
  });

  it('an event that beats the start ack still drives the flow', async () => {
    const f = fakeClient();
    const result = runRemoteSignIn(f.client, { onCodePrompt: async () => 'c' });
    f.emit({ kind: 'prompt', flowId: 'f1' });
    await tick();
    f.emit({ kind: 'token', flowId: 'f1', token: TOKEN });
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(f.sent.find((c) => c.type === 'auth.signin.code')?.payload.flowId).toBe('f1');
  });

  it('ignores events of another flow once the id is known', async () => {
    const f = fakeClient();
    const result = runRemoteSignIn(f.client, { onCodePrompt: async () => 'c' });
    await tick();
    f.emit({ kind: 'token', flowId: 'other', token: 'sk-ant-oat01-NOTMINE' });
    f.emit({ kind: 'error', flowId: 'f1', message: 'OAuth error: invalid code' });
    await expect(result).resolves.toEqual({ ok: false, error: 'OAuth error: invalid code' });
  });

  it('cancelling at the code prompt cancels the flow on the daemon', async () => {
    const f = fakeClient();
    const result = runRemoteSignIn(f.client, { onCodePrompt: async () => null });
    await tick();
    f.emit({ kind: 'prompt', flowId: 'f1' });
    await expect(result).resolves.toEqual({ ok: false, error: 'Sign-in cancelled.' });
    expect(f.sent.at(-1)).toMatchObject({ type: 'auth.signin.cancel', payload: { flowId: 'f1' } });
  });

  it('an old daemon (unknown_command) gets instructions, not a stack', async () => {
    const f = fakeClient({ startError: new DaemonCommandError('unknown_command', 'auth.signin.start is not supported') });
    const r = await runRemoteSignIn(f.client, { onCodePrompt: async () => 'x' });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('too old') });
  });

  it('a non-admin token is told to add an admin token', async () => {
    const f = fakeClient({ startError: new DaemonCommandError('forbidden', 'auth.signin.start needs scope admin') });
    const r = await runRemoteSignIn(f.client, { onCodePrompt: async () => 'x' });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('admin token') });
  });

  it('losing the connection mid-flow fails the flow', async () => {
    const f = fakeClient();
    const result = runRemoteSignIn(f.client, { onCodePrompt: () => new Promise(() => {}) });
    await tick();
    f.state({ status: 'reconnecting', attempt: 1, detail: 'connection closed (1006)' });
    await expect(result).resolves.toMatchObject({ ok: false, error: expect.stringContaining('Lost the connection') });
    expect(f.listeners()).toBe(0);
  });

  it('gives up after the timeout and cancels on the daemon', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeClient();
      const result = runRemoteSignIn(f.client, { onCodePrompt: () => new Promise(() => {}) }, { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1001);
      await expect(result).resolves.toEqual({ ok: false, error: 'Sign-in timed out.' });
      expect(f.sent.at(-1)?.type).toBe('auth.signin.cancel');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a rejected code submit surfaces the daemon error', async () => {
    const f = fakeClient();
    const original = f.client.command.bind(f.client);
    f.client.command = (async (type: any, payload: any, o: any) => {
      if (type === 'auth.signin.code') throw new DaemonCommandError('not_found', 'no such sign-in is in progress');
      return original(type, payload, o);
    }) as never;
    const result = runRemoteSignIn(f.client, { onCodePrompt: async () => 'x' });
    await tick();
    f.emit({ kind: 'prompt', flowId: 'f1' });
    await expect(result).resolves.toEqual({ ok: false, error: 'no such sign-in is in progress' });
  });
});

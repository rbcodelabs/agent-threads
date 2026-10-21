import { describe, expect, it } from 'vitest';
import type { Probes } from '../../daemon/cmd/doctor';
import { GH_AUTH_NOTICE, createGhAuthPreflight } from '../../daemon/ghPreflight';

function probes(opts: { installed?: boolean; loggedIn?: boolean }): { p: Probes; authCalls: () => number } {
  let calls = 0;
  const p = {
    run: async (_cmd: string, args: string[]) => {
      if (args[0] === 'auth') { calls++; return { ok: opts.loggedIn === true, stdout: '', stderr: '' }; }
      return opts.installed === false ? { ok: false, stdout: '', stderr: 'ENOENT gh' } : { ok: true, stdout: 'gh version 2.0.0\n', stderr: '' };
    },
  } as unknown as Probes;
  return { p, authCalls: () => calls };
}

describe('createGhAuthPreflight', () => {
  it('warns when there is no token and gh is logged out', async () => {
    const { p } = probes({ loggedIn: false });
    expect(await createGhAuthPreflight({ hasToken: () => false, probes: p })()).toBe(GH_AUTH_NOTICE);
  });
  it('is silent when a token resolves, without probing gh', async () => {
    const { p, authCalls } = probes({ loggedIn: false });
    expect(await createGhAuthPreflight({ hasToken: () => true, probes: p })()).toBeNull();
    expect(authCalls()).toBe(0);
  });
  it('is silent when gh is logged in, or not installed', async () => {
    expect(await createGhAuthPreflight({ hasToken: () => false, probes: probes({ loggedIn: true }).p })()).toBeNull();
    expect(await createGhAuthPreflight({ hasToken: () => false, probes: probes({ installed: false }).p })()).toBeNull();
  });
  it('caches the gh probe for the cache window, then re-probes', async () => {
    const { p, authCalls } = probes({ loggedIn: false });
    let t = 0;
    const check = createGhAuthPreflight({ hasToken: () => false, probes: p, now: () => t, cacheMs: 60_000 });
    await check(); await check();
    expect(authCalls()).toBe(1);
    t = 61_000;
    await check();
    expect(authCalls()).toBe(2);
  });
  it('never throws', async () => {
    const p = { run: async () => { throw new Error('boom'); } } as unknown as Probes;
    expect(await createGhAuthPreflight({ hasToken: () => false, probes: p })()).toBeNull();
  });
});

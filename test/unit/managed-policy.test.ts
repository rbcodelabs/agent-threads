import { describe, expect, it, vi } from 'vitest';
import {
  ALL_DISABLED_MESSAGE,
  ManagedPolicyError,
  ManagedPolicyService,
  allowedHarnesses,
  assertLaunchAllowed,
  daemonOriginKey,
  evaluateLaunch,
  harnessDenyReason,
  hostExecState,
  isEverythingDisabled,
  mobileRemoteAccessAllowed,
  parseThreadExecutionPolicy,
  policyTargetOfDaemon,
  remoteHostAllowed,
  resolvePolicyBridge,
  targetUsable,
  type ThreadExecutionPolicy,
} from '../../src/managedPolicy';
import { daemonWsUrl } from '../../src/remote/DaemonClient';
import { AGENT_HARNESSES, type AgentHarness } from '../../src/types';

/** Shapes mirror Geode's `EffectivePolicy.threadExecution` (src/renderer/policy-layering.ts). */
const geodeShape = (te: Record<string, unknown>) => ({
  machine: null,
  vault: null,
  provenance: {},
  effective: {
    policyVersion: 1,
    threadExecution: {
      machine: { enabled: true },
      localDaemon: { enabled: true },
      remoteDaemon: { enabled: true },
      hostExec: { enabled: true, allowAlways: true },
      mobileRemoteAccess: true,
      ...te,
    },
  },
});

const parse = (te: Record<string, unknown>): ThreadExecutionPolicy => parseThreadExecutionPolicy(geodeShape(te))!;

const MACHINE = { kind: 'machine' } as const;
const LOCAL = { kind: 'localDaemon' } as const;
const remote = (url?: string) => ({ kind: 'remoteDaemon' as const, url });

describe('evaluateLaunch', () => {
  it('allows everything when there is no policy', () => {
    for (const h of AGENT_HARNESSES) {
      for (const t of [MACHINE, LOCAL, remote('ws://x:1')]) expect(evaluateLaunch(undefined, t, h).allowed).toBe(true);
    }
  });

  it('allows everything for a policy that restricts nothing', () => {
    const p = parse({});
    for (const h of AGENT_HARNESSES) for (const t of [MACHINE, LOCAL, remote('ws://x:1')]) expect(evaluateLaunch(p, t, h).allowed).toBe(true);
  });

  it('machine off + localDaemon on: only the container runs (the common enterprise setup)', () => {
    const p = parse({ machine: { enabled: false } });
    const machine = evaluateLaunch(p, MACHINE, 'claude');
    expect(machine).toMatchObject({ allowed: false, code: 'target-disabled' });
    expect(machine.allowed === false && machine.message).toMatch(/this computer.*administrator/);
    expect(evaluateLaunch(p, LOCAL, 'claude').allowed).toBe(true);
    expect(evaluateLaunch(p, remote('ws://h:1'), 'claude').allowed).toBe(true);
    expect(isEverythingDisabled(p)).toBe(false);
  });

  it('localDaemon off leaves machine and remote alone', () => {
    const p = parse({ localDaemon: { enabled: false } });
    expect(evaluateLaunch(p, LOCAL, 'claude')).toMatchObject({ allowed: false, code: 'target-disabled' });
    expect(evaluateLaunch(p, MACHINE, 'claude').allowed).toBe(true);
  });

  it('remoteDaemon off', () => {
    const p = parse({ remoteDaemon: { enabled: false } });
    expect(evaluateLaunch(p, remote('wss://h:1'), 'claude')).toMatchObject({ allowed: false, code: 'target-disabled' });
    expect(evaluateLaunch(p, LOCAL, 'claude').allowed).toBe(true);
  });

  it('the global harness list applies to every target', () => {
    const p = parse({ harnesses: ['claude'] });
    for (const t of [MACHINE, LOCAL, remote('ws://h:1')]) {
      expect(evaluateLaunch(p, t, 'claude').allowed).toBe(true);
      expect(evaluateLaunch(p, t, 'codex')).toMatchObject({ allowed: false, code: 'harness-not-allowed' });
      expect(evaluateLaunch(p, t, 'opencode')).toMatchObject({ allowed: false, code: 'harness-not-allowed' });
    }
  });

  it('a target list narrows further; the result is the intersection', () => {
    const p = parse({ harnesses: ['claude', 'codex'], localDaemon: { enabled: true, harnesses: ['codex', 'opencode'] } });
    expect(evaluateLaunch(p, LOCAL, 'codex').allowed).toBe(true);
    // claude is globally allowed but not in the target list; opencode is in the target list but not the global one
    expect(evaluateLaunch(p, LOCAL, 'claude').allowed).toBe(false);
    expect(evaluateLaunch(p, LOCAL, 'opencode').allowed).toBe(false);
    expect(allowedHarnesses(p, 'localDaemon')).toEqual(['codex']);
    expect(allowedHarnesses(p, 'machine')).toEqual(['claude', 'codex']);
  });

  it('a target list can never re-allow a harness the global list removed', () => {
    const p = parse({ harnesses: ['claude'], machine: { enabled: true, harnesses: ['claude', 'codex'] } });
    expect(evaluateLaunch(p, MACHINE, 'codex').allowed).toBe(false);
  });

  it('the spec example: nothing on the host, claude in the container, claude+codex on the remote, opencode nowhere', () => {
    const p = parse({
      harnesses: ['claude', 'codex'],
      machine: { enabled: false },
      localDaemon: { enabled: true, harnesses: ['claude'] },
      remoteDaemon: { enabled: true, harnesses: ['claude', 'codex'], hosts: ['wss://threads.corp.example:8443'] },
    });
    const remoteUrl = 'wss://threads.corp.example:8443';
    const grid = (t: Parameters<typeof evaluateLaunch>[1]) => AGENT_HARNESSES.filter((h: AgentHarness) => evaluateLaunch(p, t, h).allowed);
    expect(grid(MACHINE)).toEqual([]);
    expect(grid(LOCAL)).toEqual(['claude']);
    expect(grid(remote(remoteUrl))).toEqual(['claude', 'codex']);
    expect(grid(remote('wss://elsewhere.example:8443'))).toEqual([]);
  });

  it('an empty list means nothing is allowed (global and per target)', () => {
    const globalEmpty = parse({ harnesses: [] });
    expect(isEverythingDisabled(globalEmpty)).toBe(true);
    expect(evaluateLaunch(globalEmpty, MACHINE, 'claude')).toMatchObject({ allowed: false, code: 'all-disabled', message: ALL_DISABLED_MESSAGE });

    const machineEmpty = parse({ machine: { enabled: true, harnesses: [] } });
    expect(evaluateLaunch(machineEmpty, MACHINE, 'claude')).toMatchObject({ allowed: false, code: 'harness-not-allowed' });
    expect(evaluateLaunch(machineEmpty, LOCAL, 'claude').allowed).toBe(true);
  });

  it('the !none sentinel matches nothing, alone or among real entries', () => {
    expect(isEverythingDisabled(parse({ harnesses: ['!none'] }))).toBe(true);
    const mixed = parse({ harnesses: ['!none', 'claude'] });
    expect(evaluateLaunch(mixed, MACHINE, 'claude').allowed).toBe(true);
    expect(evaluateLaunch(mixed, MACHINE, 'codex').allowed).toBe(false);
    const perTarget = parse({ localDaemon: { enabled: true, harnesses: ['!none'] } });
    expect(evaluateLaunch(perTarget, LOCAL, 'claude').allowed).toBe(false);
    expect(evaluateLaunch(perTarget, MACHINE, 'claude').allowed).toBe(true);
  });

  it('ignores harness ids this plugin does not know (newer policy, older plugin)', () => {
    const p = parse({ harnesses: ['claude', 'someFutureHarness'] });
    expect(evaluateLaunch(p, MACHINE, 'claude').allowed).toBe(true);
    expect(evaluateLaunch(p, MACHINE, 'codex').allowed).toBe(false);
    // a list of only unknown ids is an empty effective set
    expect(isEverythingDisabled(parse({ harnesses: ['someFutureHarness'] }))).toBe(true);
  });

  it('all three targets disabled is an empty effective set, reported explicitly', () => {
    const p = parse({ machine: { enabled: false }, localDaemon: { enabled: false }, remoteDaemon: { enabled: false } });
    expect(isEverythingDisabled(p)).toBe(true);
    for (const t of [MACHINE, LOCAL, remote('ws://h:1')]) {
      expect(evaluateLaunch(p, t, 'claude')).toMatchObject({ allowed: false, code: 'all-disabled', message: ALL_DISABLED_MESSAGE });
    }
  });

  it('is empty when the only enabled target has no harness left', () => {
    const p = parse({ machine: { enabled: false }, localDaemon: { enabled: false }, remoteDaemon: { enabled: true, harnesses: [] } });
    expect(isEverythingDisabled(p)).toBe(true);
  });

  it('is empty when the only enabled target is a remote with no allowed hosts', () => {
    const p = parse({ machine: { enabled: false }, localDaemon: { enabled: false }, remoteDaemon: { enabled: true, hosts: [] } });
    expect(targetUsable(p, 'remoteDaemon')).toBe(false);
    expect(isEverythingDisabled(p)).toBe(true);
  });

  it('absent fields are no restriction, including a target block that only sets one field', () => {
    const p = parseThreadExecutionPolicy({ effective: { threadExecution: { machine: { harnesses: ['claude'] } } } })!;
    expect(evaluateLaunch(p, MACHINE, 'claude').allowed).toBe(true);
    expect(evaluateLaunch(p, MACHINE, 'codex').allowed).toBe(false);
    expect(evaluateLaunch(p, LOCAL, 'codex').allowed).toBe(true);
  });

  it('assertLaunchAllowed throws a typed error carrying the user message', () => {
    const p = parse({ machine: { enabled: false } });
    expect(() => assertLaunchAllowed(p, MACHINE, 'claude')).toThrow(ManagedPolicyError);
    try { assertLaunchAllowed(p, MACHINE, 'claude'); } catch (err) {
      expect((err as ManagedPolicyError).code).toBe('target-disabled');
      expect((err as Error).message).toMatch(/administrator/);
    }
    expect(() => assertLaunchAllowed(undefined, MACHINE, 'claude')).not.toThrow();
  });

  it('harnessDenyReason is undefined when allowed', () => {
    const p = parse({ harnesses: ['claude'] });
    expect(harnessDenyReason(p, MACHINE, 'claude')).toBeUndefined();
    expect(harnessDenyReason(p, MACHINE, 'codex')).toMatch(/administrator/);
  });
});

describe('remote host matching (exact origin)', () => {
  const policy = parse({ remoteDaemon: { enabled: true, hosts: ['wss://threads.corp.example:8443'] } });
  const allowed = (url: string | undefined) => remoteHostAllowed(policy, url);

  it('accepts the exact origin', () => {
    expect(allowed('wss://threads.corp.example:8443')).toBe(true);
  });
  it('ignores a path and trailing slashes (origin only)', () => {
    expect(allowed('wss://threads.corp.example:8443/')).toBe(true);
    expect(allowed('wss://threads.corp.example:8443/v1/ws')).toBe(true);
  });
  it('host case does not matter', () => {
    expect(allowed('wss://THREADS.Corp.Example:8443')).toBe(true);
  });
  it('a different port is a different origin', () => {
    expect(allowed('wss://threads.corp.example:8444')).toBe(false);
    expect(allowed('wss://threads.corp.example')).toBe(false); // implicit 443
  });
  it('ws and wss are different origins', () => {
    expect(allowed('ws://threads.corp.example:8443')).toBe(false);
  });
  it('a trailing dot on the host is not an exact match', () => {
    expect(allowed('wss://threads.corp.example.:8443')).toBe(false);
  });
  it('lookalike and parent/sub domains do not match', () => {
    expect(allowed('wss://threads.corp.example.evil.test:8443')).toBe(false);
    expect(allowed('wss://evil-threads.corp.example:8443')).toBe(false);
    expect(allowed('wss://corp.example:8443')).toBe(false);
    expect(allowed('wss://a.threads.corp.example:8443')).toBe(false);
  });
  it('user-info tricks never match', () => {
    expect(allowed('wss://threads.corp.example:8443@evil.test')).toBe(false);
    expect(allowed('wss://threads.corp.example:8443@evil.test:8443')).toBe(false);
    expect(allowed('wss://evil.test@threads.corp.example:8443')).toBe(false); // real host matches but user info is refused outright
    expect(allowed('wss://user:pw@threads.corp.example:8443')).toBe(false);
  });
  it('backslash and encoded tricks resolve the way the WebSocket parser resolves them', () => {
    expect(allowed('wss://evil.test\\@threads.corp.example:8443')).toBe(false);
    expect(allowed('wss://threads.corp.example%2eevil.test:8443')).toBe(false);
  });
  it('garbage and non-websocket schemes never match', () => {
    expect(allowed('')).toBe(false);
    expect(allowed('not a url at all ::')).toBe(false);
    expect(allowed('ftp://threads.corp.example:8443')).toBe(false);
    expect(allowed(undefined)).toBe(false);
  });
  it('http(s) is mapped to ws(s) exactly as the connection code does', () => {
    expect(remoteHostAllowed(parse({ remoteDaemon: { hosts: ['https://h.example'] } }), 'wss://h.example:443')).toBe(true);
    expect(remoteHostAllowed(parse({ remoteDaemon: { hosts: ['wss://h.example'] } }), 'https://h.example')).toBe(true);
    expect(remoteHostAllowed(parse({ remoteDaemon: { hosts: ['wss://h.example'] } }), 'http://h.example')).toBe(false);
  });
  it('a bare host:port is treated as ws:// like the connection code', () => {
    expect(remoteHostAllowed(parse({ remoteDaemon: { hosts: ['ws://box.lan:7777'] } }), 'box.lan:7777')).toBe(true);
  });
  it('mirrors daemonWsUrl: the origin of every input equals the origin of what would actually be dialled', () => {
    const inputs = ['wss://h.example:9', 'http://h.example', 'https://H.example/', 'box.lan:7', 'ws://127.0.0.1:1234', 'WSS://Mixed.Example:8443/x'];
    for (const input of inputs) expect(daemonOriginKey(input)).toBe(daemonOriginKey(daemonWsUrl(input)));
  });
  it('no list means any host; an empty list or one holding only !none means no host', () => {
    expect(remoteHostAllowed(parse({}), 'wss://anything:1')).toBe(true);
    expect(remoteHostAllowed(undefined, 'wss://anything:1')).toBe(true);
    expect(remoteHostAllowed(parse({ remoteDaemon: { hosts: [] } }), 'wss://anything:1')).toBe(false);
    expect(remoteHostAllowed(parse({ remoteDaemon: { hosts: ['!none'] } }), 'wss://anything:1')).toBe(false);
  });
  it('unparseable list entries match nothing but do not break valid ones', () => {
    const p = parse({ remoteDaemon: { hosts: ['???', 'wss://ok.example:1', 'wss://u@bad.example:1'] } });
    expect(remoteHostAllowed(p, 'wss://ok.example:1')).toBe(true);
    expect(remoteHostAllowed(p, 'wss://bad.example:1')).toBe(false);
  });
  it('evaluateLaunch applies hosts to remote targets only, and refuses an unknown URL when hosts are set', () => {
    expect(evaluateLaunch(policy, remote('wss://threads.corp.example:8443'), 'claude').allowed).toBe(true);
    expect(evaluateLaunch(policy, remote('wss://other.example:8443'), 'claude')).toMatchObject({ allowed: false, code: 'host-not-allowed' });
    expect(evaluateLaunch(policy, remote(undefined), 'claude')).toMatchObject({ allowed: false, code: 'host-not-allowed' });
    expect(evaluateLaunch(policy, LOCAL, 'claude').allowed).toBe(true);
    expect(evaluateLaunch(policy, MACHINE, 'claude').allowed).toBe(true);
  });
  it('an empty host list is reported as such', () => {
    expect(evaluateLaunch(parse({ remoteDaemon: { hosts: [] } }), remote('wss://h:1'), 'claude')).toMatchObject({ allowed: false, code: 'remote-hosts-none' });
  });
});

describe('policyTargetOfDaemon', () => {
  const local = { id: 'local-daemon', url: 'ws://127.0.0.1:47811', managed: 'local-container' };
  it('the managed container on loopback is the local daemon', () => {
    expect(policyTargetOfDaemon(local, 'local-daemon').kind).toBe('localDaemon');
  });
  it('anything else is a remote daemon, whatever it claims', () => {
    expect(policyTargetOfDaemon({ ...local, id: 'homelab' }, 'local-daemon').kind).toBe('remoteDaemon');
    expect(policyTargetOfDaemon({ ...local, managed: undefined }, 'local-daemon').kind).toBe('remoteDaemon');
    expect(policyTargetOfDaemon({ ...local, url: 'wss://box.corp.example:443' }, 'local-daemon').kind).toBe('remoteDaemon');
    expect(policyTargetOfDaemon(undefined, 'local-daemon').kind).toBe('remoteDaemon');
  });
});

describe('hostExec / mobile', () => {
  it('defaults to enabled with always-allow', () => {
    expect(hostExecState(undefined)).toEqual({ enabled: true, allowAlways: true });
    expect(hostExecState(parse({}))).toEqual({ enabled: true, allowAlways: true });
  });
  it('enabled=false disables always-allow too', () => {
    expect(hostExecState(parse({ hostExec: { enabled: false } }))).toEqual({ enabled: false, allowAlways: false });
  });
  it('allowAlways=false keeps host_exec but removes standing approval', () => {
    expect(hostExecState(parse({ hostExec: { enabled: true, allowAlways: false } }))).toEqual({ enabled: true, allowAlways: false });
  });
  it('host_exec is independent of the machine target', () => {
    const noMachine = parse({ machine: { enabled: false } });
    expect(hostExecState(noMachine).enabled).toBe(true);
    const noExec = parse({ hostExec: { enabled: false } });
    expect(evaluateLaunch(noExec, MACHINE, 'claude').allowed).toBe(true);
    expect(hostExecState(noExec).enabled).toBe(false);
  });
  it('mobile remote access', () => {
    expect(mobileRemoteAccessAllowed(undefined)).toBe(true);
    expect(mobileRemoteAccessAllowed(parse({ mobileRemoteAccess: true }))).toBe(true);
    expect(mobileRemoteAccessAllowed(parse({ mobileRemoteAccess: false }))).toBe(false);
  });
});

describe('parseThreadExecutionPolicy (fail open on garbage)', () => {
  it.each([null, undefined, 5, 'x', [], {}, { effective: null }, { effective: {} }, { effective: { threadExecution: 'bad' } }, { effective: { threadExecution: [] } }])(
    'returns no policy for %j',
    (raw) => { expect(parseThreadExecutionPolicy(raw)).toBeUndefined(); },
  );
  it('ignores fields of the wrong type instead of guessing', () => {
    const p = parseThreadExecutionPolicy({ effective: { threadExecution: { harnesses: 'claude', machine: 7, localDaemon: { enabled: 'no', harnesses: [1, 'claude'] }, mobileRemoteAccess: 'false' } } })!;
    expect(p.harnesses).toBeUndefined();
    expect(p.machine).toBeUndefined();
    expect(p.localDaemon).toEqual({ enabled: undefined, harnesses: ['claude'] });
    expect(p.mobileRemoteAccess).toBeUndefined();
    expect(evaluateLaunch(p, MACHINE, 'codex').allowed).toBe(true);
  });
  it('accepts the bare-boolean shorthand for a target', () => {
    const p = parseThreadExecutionPolicy({ effective: { threadExecution: { machine: false } } })!;
    expect(evaluateLaunch(p, MACHINE, 'claude').allowed).toBe(false);
  });
  it('accepts a bare threadExecution block', () => {
    expect(parseThreadExecutionPolicy({ threadExecution: { machine: { enabled: false } } })?.machine?.enabled).toBe(false);
  });
});

describe('resolvePolicyBridge', () => {
  it('is undefined without window.geode (Obsidian, mobile)', () => {
    expect(resolvePolicyBridge(undefined)).toBeUndefined();
    expect(resolvePolicyBridge({})).toBeUndefined();
  });
  it('is undefined on a Geode that predates getEffectivePolicy', () => {
    expect(resolvePolicyBridge({ geode: {} })).toBeUndefined();
    expect(resolvePolicyBridge({ geode: { getEffectivePolicy: 'nope' } })).toBeUndefined();
  });
  it('calls through with the host object as receiver', async () => {
    const geode = { token: 7, async getEffectivePolicy(this: { token: number }) { return this.token; } };
    expect(await resolvePolicyBridge({ geode })!.getEffectivePolicy()).toBe(7);
  });
});

describe('ManagedPolicyService', () => {
  const warn = () => vi.fn<(m: string) => void>();

  it('no bridge: no policy, no warning', async () => {
    const w = warn();
    const svc = new ManagedPolicyService({ bridge: () => undefined, warn: w });
    expect(await svc.read()).toBeUndefined();
    expect(w).not.toHaveBeenCalled();
  });

  it('null reply: no policy, no warning', async () => {
    const w = warn();
    const svc = new ManagedPolicyService({ bridge: () => ({ getEffectivePolicy: async () => null }), warn: w });
    expect(await svc.read()).toBeUndefined();
    expect(w).not.toHaveBeenCalled();
  });

  it('a reply without threadExecution (older Geode) is open and quiet', async () => {
    const w = warn();
    const svc = new ManagedPolicyService({ bridge: () => ({ getEffectivePolicy: async () => ({ effective: { policyVersion: 1 } }) }), warn: w });
    expect(await svc.read()).toBeUndefined();
    expect(w).not.toHaveBeenCalled();
  });

  it('a bridge that throws or rejects fails open with a console warning (once per distinct problem)', async () => {
    const w = warn();
    const svc = new ManagedPolicyService({ bridge: () => ({ getEffectivePolicy: () => { throw new Error('ipc down'); } }), warn: w });
    expect(await svc.read()).toBeUndefined();
    expect(await svc.read()).toBeUndefined();
    expect(w).toHaveBeenCalledTimes(1);
    expect(w.mock.calls[0][0]).toMatch(/ipc down.*no restriction/);

    const w2 = warn();
    const rejecting = new ManagedPolicyService({ bridge: () => ({ getEffectivePolicy: () => Promise.reject(new Error('nope')) }), warn: w2 });
    expect(await rejecting.read()).toBeUndefined();
    expect(w2).toHaveBeenCalledTimes(1);
  });

  it.each([42, 'x', [], { effective: 'junk' }, { effective: { threadExecution: 'junk' } }])('garbage %j fails open with a warning', async (garbage) => {
    const w = warn();
    const svc = new ManagedPolicyService({ bridge: () => ({ getEffectivePolicy: async () => garbage }), warn: w });
    expect(await svc.read()).toBeUndefined();
    expect(w).toHaveBeenCalledTimes(1);
  });

  it('reads FRESH each time (no caching across reads) and picks up a later bridge', async () => {
    let reply: unknown = geodeShape({ machine: { enabled: false } });
    let bridge: { getEffectivePolicy(): Promise<unknown> } | undefined;
    const calls = vi.fn(async () => reply);
    const svc = new ManagedPolicyService({ bridge: () => bridge });
    expect(await svc.read()).toBeUndefined();
    bridge = { getEffectivePolicy: calls };
    expect((await svc.read())?.machine?.enabled).toBe(false);
    reply = geodeShape({ machine: { enabled: true } });
    expect((await svc.read())?.machine?.enabled).toBe(true);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent reads into one IPC call', async () => {
    let release!: (v: unknown) => void;
    const calls = vi.fn(() => new Promise((r) => { release = r; }));
    const svc = new ManagedPolicyService({ bridge: () => ({ getEffectivePolicy: calls }) });
    const a = svc.read();
    const b = svc.read();
    release(geodeShape({ harnesses: ['claude'] }));
    const [pa, pb] = await Promise.all([a, b]);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(pa).toBe(pb);
    const next = svc.read();
    release(geodeShape({}));
    await next;
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('peek returns the last read and subscribers hear only about changes', async () => {
    let reply: unknown = geodeShape({});
    const svc = new ManagedPolicyService({ bridge: () => ({ getEffectivePolicy: async () => reply }) });
    const heard = vi.fn();
    svc.subscribe(heard);
    expect(svc.peek()).toBeUndefined();
    await svc.read();
    expect(svc.peek()).toBeDefined();
    const afterFirst = heard.mock.calls.length;
    await svc.read();
    expect(heard.mock.calls.length).toBe(afterFirst);
    reply = geodeShape({ mobileRemoteAccess: false });
    await svc.read();
    expect(heard.mock.calls.length).toBe(afterFirst + 1);
  });
});

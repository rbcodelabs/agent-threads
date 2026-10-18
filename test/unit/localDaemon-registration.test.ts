/**
 * The Remote daemons entry for the managed daemon, including the host tools it starts with.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCAL_DAEMON_HOST_TOOLS, buildRegistration, isRegistrationCurrent } from '../../src/localDaemon/registration';
import { routeFor } from '../../src/toolRouting';
import type { RemoteDaemonConfig } from '../../src/types';

describe('buildRegistration', () => {
  it('starts with the host tools the removed sandbox VM threads had: read groups, brokers and host_exec', () => {
    const r = buildRegistration('/Users/me/Vault', 7433);
    expect(r.hostTools?.enabled).toBe(true);
    const routes = r.hostTools!.routes!;
    for (const group of ['vault', 'workspace', 'threads', 'skills', 'browser', 'mcp', 'exec']) expect(routes[group], group).toBe('host');
    expect(routeFor('vault_search', routes)).toBe('host');
    expect(routeFor('host_exec', routes)).toBe('host');
    // Writing / scheduling tools stay off whatever the routes say.
    for (const never of ['threads_create', 'CronCreate', 'request_secret', 'host_execute_command', 'skills_install']) {
      expect(routeFor(never, { ...routes, [never]: 'host' }), never).toBe('absent');
    }
  });

  it('does not share the default object (a later edit of one entry cannot change the defaults)', () => {
    const r = buildRegistration('/v', 7433);
    r.hostTools!.routes!.vault = 'absent';
    expect(DEFAULT_LOCAL_DAEMON_HOST_TOOLS.routes!.vault).toBe('host');
  });

  it('keeps the user\'s own host-tool choices, including turning everything off', () => {
    const edited: RemoteDaemonConfig = { ...buildRegistration('/v', 7433), hostTools: { enabled: false } };
    expect(buildRegistration('/v', 7433, edited).hostTools).toEqual({ enabled: false });
    const narrowed: RemoteDaemonConfig = { ...buildRegistration('/v', 7433), hostTools: { enabled: true, routes: { vault: 'host' } } };
    expect(buildRegistration('/v', 7433, narrowed).hostTools).toEqual({ enabled: true, routes: { vault: 'host' } });
  });

  it('re-registers an entry saved before host tools were defaulted, once', () => {
    const old = buildRegistration('/v', 7433);
    delete (old as { hostTools?: unknown }).hostTools;
    expect(isRegistrationCurrent(old, '/v', 7433)).toBe(false);
    expect(isRegistrationCurrent(buildRegistration('/v', 7433, old), '/v', 7433)).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { DaemonCommandError } from '../../src/remote/DaemonClient';
import { createRemoteFolderSource } from '../../src/remote/folderSource';

const ws = [{ path: '/srv/a', name: 'a', readOnly: false, kind: 'folder', isDefault: true }];

function resolverWith(command: (type: string) => Promise<unknown>) {
  const client = { command: vi.fn((type: string) => command(type)) };
  return { client, resolver: { clientFor: () => client as never, nameOf: (id: string) => id } };
}

describe('createRemoteFolderSource', () => {
  it('caches workspaces briefly per daemon', async () => {
    let now = 1000;
    const { client, resolver } = resolverWith(async () => ({ workspaces: ws }));
    const src = createRemoteFolderSource(resolver, () => now);
    expect(await src.workspaces('d')).toEqual({ ok: true, value: ws });
    now += 5_000;
    await src.workspaces('d');
    expect(client.command).toHaveBeenCalledTimes(1);
    now += 60_000;
    await src.workspaces('d');
    expect(client.command).toHaveBeenCalledTimes(2);
  });

  it('reports an old daemon as unsupported and other failures as errors, never throwing', async () => {
    const old = resolverWith(async () => { throw new DaemonCommandError('unknown_command', 'nope'); });
    expect(await createRemoteFolderSource(old.resolver).workspaces('d')).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await createRemoteFolderSource(old.resolver).subfolders('d', '/x')).toMatchObject({ ok: false, reason: 'unsupported' });
    const down = resolverWith(async () => { throw new DaemonCommandError('unreachable', 'cannot reach'); });
    expect(await createRemoteFolderSource(down.resolver).workspaces('d')).toMatchObject({ ok: false, reason: 'error', detail: 'cannot reach' });
  });

  it('a removed daemon is an error', async () => {
    const src = createRemoteFolderSource({ clientFor: () => undefined, nameOf: (id) => id });
    expect(await src.workspaces('gone')).toMatchObject({ ok: false, reason: 'error' });
  });
});

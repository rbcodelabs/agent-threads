import type { RemoteDaemonConfig } from '../../src/types';

/**
 * Shared by the conversation harness (index.ts) so the new-conversation composer's
 * "Run on" picker has daemons and folders to offer without a real daemon.
 */
export const remoteFixtureDaemons: RemoteDaemonConfig[] = [
  { id: 'my-server', name: 'my-server', url: 'wss://my-server.tailnet-name.ts.net:8443', tokenSecretName: 'T', defaultCwdRoot: '/home/user/projects', vaultMapping: { remoteRoot: '/home/user/vault' } },
  { id: 'plain-box', name: 'plain-box', url: 'wss://plain.example.ts.net:8443', tokenSecretName: 'U', defaultCwdRoot: '/srv/workspaces' },
];

// What the Run on picker would get from a real daemon (`workspaces.list` / `path.list`). `plain-box`
// stands for a daemon too old to advertise folders, so it keeps the plain text field.
const folderTree: Record<string, string[]> = {
  '/home/user/projects': ['app', 'site', 'tools'],
  '/home/user/vault': ['Daily', 'Products', 'Projects'],
  '/home/user/vault/Products': ['Agent Threads', 'Other Product'],
  '/home/user/vault/Products/Agent Threads': [],
  '/home/user/vault/Products/Other Product': ['Notes', 'Specs'],
};

export const fakeRemoteFolders = {
  workspaces: async (daemonId: string) => daemonId === 'plain-box'
    ? { ok: false as const, reason: 'unsupported' as const, detail: 'This daemon is too old to list its folders.' }
    : {
      ok: true as const,
      value: [
        { path: '/home/user/projects', name: 'projects', readOnly: false, kind: 'folder' as const, isDefault: true },
        { path: '/home/user/vault', name: 'vault', readOnly: false, kind: 'vault' as const, isDefault: false },
      ],
    },
  subfolders: async (_daemonId: string, path: string) => ({
    ok: true as const,
    value: { allowed: path in folderTree, entries: (folderTree[path] ?? []).map((name) => ({ name, path: `${path}/${name}` })), truncated: false },
  }),
};

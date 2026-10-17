/**
 * Local daemon: the Remote daemons entry that points at the managed container.
 * Pure. The token itself lives in the keychain under `tokenSecretNameFor(id)`,
 * exactly like any hand-added daemon; nothing secret is in settings.
 */

import type { RemoteDaemonConfig } from '../types';
import { tokenSecretNameFor } from '../remote/daemonConfig';
import { LOCAL_DAEMON_ID, LOCAL_DAEMON_NAME, VAULT_GUEST_PATH } from './spec';

export const LOCAL_DAEMON_TOKEN_SECRET = tokenSecretNameFor(LOCAL_DAEMON_ID);

export function localDaemonUrl(port: number): string {
  return `ws://127.0.0.1:${port}`;
}

/**
 * The entry for the managed daemon. A user's later edits to host-tool settings and the default folder are kept;
 * URL, token secret, mapping and the managed marker are always rewritten (they are owned by this feature).
 */
export function buildRegistration(vaultPath: string, port: number, existing?: RemoteDaemonConfig): RemoteDaemonConfig {
  return {
    id: LOCAL_DAEMON_ID,
    name: existing?.name?.trim() || LOCAL_DAEMON_NAME,
    url: localDaemonUrl(port),
    tokenSecretName: LOCAL_DAEMON_TOKEN_SECRET,
    defaultCwdRoot: existing?.defaultCwdRoot ?? VAULT_GUEST_PATH,
    vaultMapping: { localRoot: vaultPath, remoteRoot: VAULT_GUEST_PATH },
    ...(existing?.hostTools ? { hostTools: existing.hostTools } : {}),
    managed: 'local-container',
  };
}

export function isRegistrationCurrent(existing: RemoteDaemonConfig | undefined, vaultPath: string, port: number): boolean {
  if (!existing) return false;
  const want = buildRegistration(vaultPath, port, existing);
  return existing.managed === 'local-container'
    && existing.url === want.url
    && existing.tokenSecretName === want.tokenSecretName
    && existing.vaultMapping?.remoteRoot === want.vaultMapping?.remoteRoot
    && existing.vaultMapping?.localRoot === want.vaultMapping?.localRoot;
}

/** Managed entries mean nothing on mobile (loopback): lists hide them there. */
export function visibleDaemons(daemons: readonly RemoteDaemonConfig[], isMobile: boolean): RemoteDaemonConfig[] {
  return isMobile ? daemons.filter((d) => d.managed !== 'local-container') : [...daemons];
}

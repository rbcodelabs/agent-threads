/**
 * permissionCard.ts
 *
 * The Deny / Allow (once) / Always buttons for a pending permission, shared by
 * the Kanban card and the OrchestratorDock so there is one implementation and
 * one resolution path: manager.resolvePermission(threadId, allow). Resolving in
 * either place resolves both because both read the same manager state.
 */
import type { ThreadManager } from './ThreadManager';
import { canAlwaysAllow, isHostExecPermission, summarizePermissionDetail } from './permissionDetail';
import { recordAlwaysAllow, type AlwaysAllowSettings } from './remoteAlwaysAllow';
import { addHostExecPrefix, hostExecAlwaysAllowOffer } from './hostExecPrefix';

export { summarizePermissionDetail };

export interface PermissionButtonDeps {
  manager: Pick<ThreadManager, 'resolvePermission' | 'getRemoteScope'>;
  /** Read at click time, not build time: the settings object may be replaced after the buttons are built. */
  getSettings(): AlwaysAllowSettings & { hostExecAlwaysAllowedPrefixes: string[] };
  saveSettings(): Promise<void>;
  /** hostExecState(managedPolicy.peek()).allowAlways, read when the buttons are built. */
  hostExecAllowAlways: boolean;
}

export type PendingPermissionInfo = ReturnType<ThreadManager['getPendingPermission']>;

/** Appends Deny / Allow / [Always `prefix`] / [Always] to `btns`. Every click stops propagation. */
export function appendPermissionButtons(
  btns: HTMLElement,
  threadId: string,
  pendingInfo: PendingPermissionInfo,
  deps: PermissionButtonDeps,
): void {
  const { manager, saveSettings } = deps;
  const deny = btns.createEl('button', { text: 'Deny', cls: 'ct-permission-btn ct-permission-deny' });
  deny.addEventListener('click', (e) => { e.stopPropagation(); manager.resolvePermission(threadId, false); });
  const allow = btns.createEl('button', { text: !!pendingInfo && isHostExecPermission(pendingInfo.toolName) ? 'Allow once' : 'Allow', cls: 'ct-permission-btn ct-permission-allow' });
  allow.addEventListener('click', (e) => { e.stopPropagation(); manager.resolvePermission(threadId, true); });
  const hostExecPrefix = hostExecAlwaysAllowOffer(pendingInfo, deps.hostExecAllowAlways);
  if (hostExecPrefix) {
    const alwaysPrefix = btns.createEl('button', { text: `Always \`${hostExecPrefix}\``, cls: 'ct-permission-btn ct-permission-always' });
    alwaysPrefix.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (addHostExecPrefix(deps.getSettings(), hostExecPrefix)) await saveSettings();
      manager.resolvePermission(threadId, true);
    });
  }
  if (!pendingInfo || canAlwaysAllow(pendingInfo.toolName)) {
    const always = btns.createEl('button', { text: 'Always', cls: 'ct-permission-btn ct-permission-always' });
    always.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (pendingInfo) {
        if (recordAlwaysAllow(deps.getSettings(), pendingInfo.toolName, manager.getRemoteScope(threadId))) await saveSettings();
      }
      manager.resolvePermission(threadId, true);
    });
  }
}

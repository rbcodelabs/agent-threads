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
  guard?: PermissionGuard;
}

export type PendingPermissionInfo = ReturnType<ThreadManager['getPendingPermission']>;

/**
 * OPTIONAL stale-click guard (off by default: the board does not pass one; the OrchestratorDock tray does).
 * manager.resolvePermission resolves WHATEVER prompt is pending for the thread, and prompts queue per thread, so a
 * click on a card whose request has since been settled could approve the next one. With a guard, every action
 * compares the live pending request with the one the buttons were built for, immediately before resolving (and, for
 * the Always variants, again after the settings await), and does nothing on a mismatch.
 */
export interface PermissionGuard {
  /** manager.getPendingPermission(threadId), read at click time. */
  getPending(): PendingPermissionInfo;
  /** The request on screen is no longer the pending one: refresh the card. Nothing was resolved or recorded. */
  onStale(): void;
  /** Disable / re-enable the card's buttons (the first click disables them all). */
  setBusy(busy: boolean): void;
}

/** Same prompt: same tool + detail and, when both sides carry one, the same prompt id. */
export function samePermissionPrompt(a: PendingPermissionInfo, b: PendingPermissionInfo): boolean {
  if (!a || !b) return false;
  if (a.toolName !== b.toolName || a.detail !== b.detail) return false;
  return a.promptId === undefined || b.promptId === undefined || a.promptId === b.promptId;
}

/** Appends Deny / Allow / [Always `prefix`] / [Always] to `btns`. Every click stops propagation. */
export function appendPermissionButtons(
  btns: HTMLElement,
  threadId: string,
  pendingInfo: PendingPermissionInfo,
  deps: PermissionButtonDeps,
): void {
  const { manager, saveSettings, guard } = deps;
  const snapshot = pendingInfo;
  const stillPending = (): boolean => !guard || samePermissionPrompt(snapshot, guard.getPending());
  /** Guarded: a stale card does nothing and refreshes; otherwise the card goes busy. Unguarded: always proceeds. */
  const begin = (): boolean => {
    if (!guard) return true;
    if (!stillPending()) { guard.onStale(); return false; }
    guard.setBusy(true);
    return true;
  };
  const resolve = (allow: boolean): void => {
    if (!stillPending()) { guard?.onStale(); return; }
    manager.resolvePermission(threadId, allow);
    if (!guard) return;
    // Settled -> the card leaves on permission_resolved. If the prompt is still the pending one afterwards the action
    // did not take: let the user try again.
    setTimeout(() => { if (samePermissionPrompt(snapshot, guard.getPending())) guard.setBusy(false); }, 0);
  };
  const deny = btns.createEl('button', { text: 'Deny', cls: 'ct-permission-btn ct-permission-deny' });
  deny.addEventListener('click', (e) => { e.stopPropagation(); if (begin()) resolve(false); });
  const allow = btns.createEl('button', { text: !!pendingInfo && isHostExecPermission(pendingInfo.toolName) ? 'Allow once' : 'Allow', cls: 'ct-permission-btn ct-permission-allow' });
  allow.addEventListener('click', (e) => { e.stopPropagation(); if (begin()) resolve(true); });
  const hostExecPrefix = hostExecAlwaysAllowOffer(pendingInfo, deps.hostExecAllowAlways);
  if (hostExecPrefix) {
    const alwaysPrefix = btns.createEl('button', { text: `Always \`${hostExecPrefix}\``, cls: 'ct-permission-btn ct-permission-always' });
    alwaysPrefix.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!begin()) return;
      if (addHostExecPrefix(deps.getSettings(), hostExecPrefix)) await saveSettings();
      resolve(true);
    });
  }
  if (!pendingInfo || canAlwaysAllow(pendingInfo.toolName)) {
    const always = btns.createEl('button', { text: 'Always', cls: 'ct-permission-btn ct-permission-always' });
    always.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!begin()) return;
      if (pendingInfo) {
        if (recordAlwaysAllow(deps.getSettings(), pendingInfo.toolName, manager.getRemoteScope(threadId))) await saveSettings();
      }
      resolve(true);
    });
  }
}

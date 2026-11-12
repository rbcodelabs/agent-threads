/**
 * dock-tray-real-manager.test.ts
 * @vitest-environment jsdom
 *
 * The tray against a REAL ThreadManager with two queued prompts of IDENTICAL tool + detail: clicking across the A -> B
 * hand-over resolves A exactly once and never B. (The unit tests use a fake manager; this one uses the real queue.)
 */
import '../setup/obsidian-dom';
import { describe, it, expect, beforeEach } from 'vitest';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import { DockTray, type TrayEntry } from '../../src/orchestratorDockTray';

const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => { document.body.innerHTML = ''; });

function setup() {
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  const resolved: Array<{ promptId: number | undefined; allow: boolean }> = [];
  manager.permissionHandler = (id) => new Promise<boolean>((resolve) => {
    const promptId = manager.getPendingPermission(id)?.promptId;
    manager.registerPermissionResolver(id, (allow) => { resolved.push({ promptId, allow }); resolve(allow); });
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const settings = { alwaysAllowedTools: [] as string[], hostExecAlwaysAllowedPrefixes: [] as string[] };
  const tray: DockTray = new DockTray(host, {
    manager,
    permissionCard: { getSettings: () => settings, saveSettings: async () => {}, hostExecAllowAlways: () => true },
    openThread: () => {},
    announce: () => {},
    refresh: () => render(),
    focusFallback: () => {},
  });
  const render = () => {
    const p = manager.getPendingPermission('t');
    const entries: TrayEntry[] = p ? [{ item: { threadId: 't', title: 'Thread', kind: 'permission' }, permission: p }] : [];
    tray.render(entries);
  };
  return { manager, resolved, tray, render, host };
}

describe('tray + real ThreadManager queue', () => {
  it('A then an identical B: the click resolves A exactly once, never B, even across the hand-over', async () => {
    const t = setup();
    const a = t.manager.requestToolApproval('t', 'Bash', JSON.stringify({ command: 'ls' }));
    const b = t.manager.requestToolApproval('t', 'Bash', JSON.stringify({ command: 'ls' }));
    t.render();
    const idA = t.manager.getPendingPermission('t')!.promptId;
    const allowA = [...t.host.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent === 'Allow')!;
    allowA.click();
    // second and third click on the same node while the queue advances to B
    allowA.click();
    await flush(); // A settles, B reaches the front: the tray has NOT re-rendered yet
    expect(t.manager.getPendingPermission('t')!.promptId).not.toBe(idA);
    allowA.disabled = false; // even if the card were re-enabled, the guard compares prompt ids
    allowA.click();
    allowA.click();
    await flush();
    expect(t.resolved).toEqual([{ promptId: idA, allow: true }]);
    expect(await a).toBe(true);
    expect(t.manager.hasPendingPermission('t')).toBe(true); // B is still waiting for ITS OWN decision
    let bSettled = false;
    void b.then(() => { bSettled = true; });
    await flush();
    expect(bSettled).toBe(false);
  });

  it('after the tray re-renders for B, B\'s own buttons resolve B once', async () => {
    const t = setup();
    void t.manager.requestToolApproval('t', 'Bash', JSON.stringify({ command: 'ls' }));
    const b = t.manager.requestToolApproval('t', 'Bash', JSON.stringify({ command: 'ls' }));
    t.render();
    [...t.host.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent === 'Allow')!.click();
    await flush();
    t.render(); // the dock refreshes on permission_resolved / permission_request
    const idB = t.manager.getPendingPermission('t')!.promptId;
    [...t.host.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent === 'Deny')!.click();
    await flush();
    expect(t.resolved.map((r) => r.allow)).toEqual([true, false]);
    expect(t.resolved[1].promptId).toBe(idB);
    expect(await b).toBe(false);
  });
});

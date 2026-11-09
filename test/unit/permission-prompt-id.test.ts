/**
 * permission-prompt-id.test.ts
 *
 * ThreadManager.getPendingPermission exposes an additive per-prompt `promptId`, so a UI can tell "the request I
 * showed" from "the next queued request with identical tool + detail".
 */
import { describe, it, expect } from 'vitest';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';

const flush = () => new Promise((r) => setTimeout(r, 0));

function manager() {
  const m = new ThreadManager({ ...DEFAULT_SETTINGS });
  m.permissionHandler = (id) => new Promise<boolean>((resolve) => { m.registerPermissionResolver(id, resolve); });
  return m;
}

describe('getPendingPermission().promptId', () => {
  it('is set for the pending prompt and keeps toolName / detail', () => {
    const m = manager();
    void m.requestToolApproval('t', 'Bash', 'ls');
    const p = m.getPendingPermission('t')!;
    expect(p.toolName).toBe('Bash');
    expect(p.detail).toBe('ls');
    expect(typeof p.promptId).toBe('number');
  });

  it('differs for a queued prompt with IDENTICAL tool and detail once it reaches the front', async () => {
    const m = manager();
    const a = m.requestToolApproval('t', 'Bash', 'ls');
    const b = m.requestToolApproval('t', 'Bash', 'ls');
    const idA = m.getPendingPermission('t')!.promptId;
    m.resolvePermission('t', true);
    await a; await flush();
    const pendingB = m.getPendingPermission('t')!;
    expect(pendingB.detail).toBe('ls');
    expect(pendingB.promptId).not.toBe(idA);
    m.resolvePermission('t', false);
    expect(await b).toBe(false);
  });

  it('is unique across threads too', () => {
    const m = manager();
    void m.requestToolApproval('t1', 'Bash', 'ls');
    void m.requestToolApproval('t2', 'Bash', 'ls');
    expect(m.getPendingPermission('t1')!.promptId).not.toBe(m.getPendingPermission('t2')!.promptId);
  });
});

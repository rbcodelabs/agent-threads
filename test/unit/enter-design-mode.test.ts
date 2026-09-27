import { describe, expect, it, vi } from 'vitest';
import { enterDesignMode, assertDesignWriteAllowed, type DesignModeDeps } from '../harness/design-plugin/designArtifact';
import type { Thread } from '../../src/types';

function setup() {
  const thread = { id: 'caller', artifacts: undefined } as Thread;
  const files = new Map<string, string>();
  const deps: DesignModeDeps = {
    getThread: vi.fn(() => thread),
    assertWritable: vi.fn(),
    saveSettings: vi.fn(async () => {}),
    openThread: vi.fn(async () => {}),
    openPreview: vi.fn(async () => ({ status: 'opened' as const })),
  };
  const fileFs = {
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (target: string, content: string) => {
      if (files.has(target)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(target, content);
    }),
  };
  return { thread, files, deps, fileFs };
}

describe('agent design entry', () => {
  it('rejects effective Plan mode and pending approval', () => {
    const { thread } = setup();
    expect(() => assertDesignWriteAllowed(thread, 'plan')).toThrow('Plan mode');
    thread.permissionMode = 'default';
    expect(() => assertDesignWriteAllowed(thread, 'plan')).not.toThrow();
    thread.pendingPlan = 'Awaiting approval';
    expect(() => assertDesignWriteAllowed(thread, 'default')).toThrow('plan approval');
    delete thread.pendingPlan;
    thread.permissionMode = 'plan';
    expect(() => assertDesignWriteAllowed(thread, 'default')).toThrow('Plan mode');
  });
  it('persists the caller artifact before navigation and returns same-turn instructions', async () => {
    const { thread, deps, fileFs } = setup();
    vi.mocked(deps.openThread).mockImplementation(async id => {
      expect(id).toBe('caller');
      expect(deps.saveSettings).toHaveBeenCalledOnce();
      expect(thread.artifacts).toHaveLength(1);
    });
    const result = await enterDesignMode('caller', '/vault', 'Settings page', deps, fileFs);
    expect(result.created).toBe(true);
    expect(result.preview.status).toBe('opened');
    expect(result.instructions).toContain('Settings page');
    expect(result.instructions).toContain(result.artifact.root);
  });

  it('serializes concurrent entries and preserves existing source', async () => {
    const { thread, files, deps, fileFs } = setup();
    const results = await Promise.all([
      enterDesignMode('caller', '/vault', 'First', deps, fileFs),
      enterDesignMode('caller', '/vault', 'Second', deps, fileFs),
    ]);
    expect(results.map(r => r.created)).toEqual([true, false]);
    expect(thread.artifacts).toHaveLength(1);
    files.set(results[0].artifact.entryPath, 'User design');
    await enterDesignMode('caller', '/vault', 'Revise', deps, fileFs);
    expect(files.get(results[0].artifact.entryPath)).toBe('User design');
  });

  it('restores metadata on failed save while retaining files for retry', async () => {
    const { thread, files, deps, fileFs } = setup();
    vi.mocked(deps.saveSettings).mockRejectedValueOnce(new Error('disk full'));
    await expect(enterDesignMode('caller', '/vault', 'Brief', deps, fileFs)).rejects.toThrow('disk full');
    expect(thread.artifacts).toBeUndefined();
    expect(files.size).toBe(4);
    expect(deps.openThread).not.toHaveBeenCalled();
    expect((await enterDesignMode('caller', '/vault', 'Brief', deps, fileFs)).created).toBe(true);
  });

  it('rejects write restrictions before filesystem access', async () => {
    const { deps, fileFs } = setup();
    vi.mocked(deps.assertWritable).mockImplementation(() => { throw new Error('Plan mode'); });
    await expect(enterDesignMode('caller', '/vault', 'Brief', deps, fileFs)).rejects.toThrow('Plan mode');
    expect(fileFs.mkdir).not.toHaveBeenCalled();
  });

  it('does not attach or navigate a deleted thread', async () => {
    const { thread, deps, fileFs } = setup();
    fileFs.mkdir.mockImplementation(async () => { vi.mocked(deps.getThread).mockReturnValue(undefined); });
    await expect(enterDesignMode('caller', '/vault', 'Brief', deps, fileFs)).rejects.toThrow('unavailable');
    expect(thread.artifacts).toBeUndefined();
    expect(deps.saveSettings).not.toHaveBeenCalled();
    expect(deps.openThread).not.toHaveBeenCalled();
  });

  it('keeps a persisted artifact when preview fails and reports the warning', async () => {
    const { thread, deps, fileFs } = setup();
    vi.mocked(deps.openPreview).mockRejectedValue(new Error('preview unavailable'));
    const result = await enterDesignMode('caller', '/vault', 'Brief', deps, fileFs);
    expect(result.preview).toEqual({ status: 'unavailable', warning: 'preview unavailable' });
    expect(thread.artifacts).toHaveLength(1);
  });

  it('restores the original timestamp and array when reuse persistence fails', async () => {
    const { thread, deps, fileFs } = setup();
    await enterDesignMode('caller', '/vault', 'Brief', deps, fileFs);
    const original = thread.artifacts;
    original![0].updatedAt = 7;
    vi.mocked(deps.saveSettings).mockRejectedValueOnce(new Error('save failed'));
    await expect(enterDesignMode('caller', '/vault', 'Revision', deps, fileFs)).rejects.toThrow('save failed');
    expect(thread.artifacts).toBe(original);
    expect(thread.artifacts![0].updatedAt).toBe(7);
  });

  it('reports source reveal accurately', async () => {
    const { deps, fileFs } = setup();
    vi.mocked(deps.openPreview).mockResolvedValue({ status: 'source-revealed', warning: 'Geode required' });
    expect((await enterDesignMode('caller', '/vault', 'Brief', deps, fileFs)).preview)
      .toEqual({ status: 'source-revealed', warning: 'Geode required' });
  });

  it('checks deletion after persistence before focusing a thread', async () => {
    const { deps, fileFs } = setup();
    vi.mocked(deps.saveSettings).mockImplementation(async () => { vi.mocked(deps.getThread).mockReturnValue(undefined); });
    await expect(enterDesignMode('caller', '/vault', 'Brief', deps, fileFs)).rejects.toThrow('unavailable');
    expect(deps.openThread).not.toHaveBeenCalled();
  });

  it('checks deletion during navigation before opening the preview', async () => {
    const { deps, fileFs } = setup();
    vi.mocked(deps.openThread).mockImplementation(async () => { vi.mocked(deps.getThread).mockReturnValue(undefined); });
    await expect(enterDesignMode('caller', '/vault', 'Brief', deps, fileFs)).rejects.toThrow('unavailable');
    expect(deps.openPreview).not.toHaveBeenCalled();
  });

  it('does not attach metadata on partial scaffold failure', async () => {
    const { thread, deps, fileFs } = setup();
    fileFs.writeFile.mockRejectedValueOnce(new Error('write denied'));
    await expect(enterDesignMode('caller', '/vault', 'Brief', deps, fileFs)).rejects.toThrow('write denied');
    expect(thread.artifacts).toBeUndefined();
    expect(deps.saveSettings).not.toHaveBeenCalled();
  });
});

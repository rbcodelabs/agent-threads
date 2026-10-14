/**
 * obsidian-tools-project-tools.test.ts
 *
 * Unit tests for the obsidian_create_project and obsidian_set_thread_project
 * MCP tools defined in ObsidianTools.ts.
 *
 * Strategy: mock @anthropic-ai/claude-agent-sdk/browser to capture each tool's
 * handler and invoke it directly, without needing a real Obsidian environment
 * or a running MCP server.
 */

import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (
    name: string,
    _description: string,
    _schema: unknown,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>,
  ) => ({ _toolName: name, _handler: handler }),

  createSdkMcpServer: ({ tools }: { tools: CapturedTool[] }) => ({ tools }),
}));

import { createObsidianMcpServer } from '../../src/ObsidianTools';
import type { ProjectSnapshot } from '../../src/ObsidianTools';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ToolResult {
  content: [{ type: string; text: string }];
  isError?: boolean;
}

interface CapturedTool {
  _toolName: string;
  _handler: (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;
}

interface CapturedServer {
  tools: CapturedTool[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp(): App {
  return {
    plugins: { plugins: {} },
    workspace: {
      getLeavesOfType: () => [],
      onLayoutReady: (cb: () => void) => cb(),
    },
    vault: { getAbstractFileByPath: () => null },
    metadataCache: { on: () => {} },
  } as unknown as App;
}

function getTool(server: CapturedServer, name: string): CapturedTool {
  const t = server.tools.find((tool) => tool._toolName === name);
  if (!t) throw new Error(`Tool "${name}" not found in server`);
  return t;
}

function parseResult(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

const fakeProject: ProjectSnapshot = {
  id: 'proj-abc123',
  name: 'HipTrip',
  vaultFolder: 'Projects/HipTrip',
  description: 'Travel curation app',
  effectiveCwd: '/vault/Projects/HipTrip',
};

// ── obsidian_create_project ───────────────────────────────────────────────────

describe('obsidian_create_project', () => {
  it('returns an error when createProject callback is not provided', async () => {
    const server = createObsidianMcpServer(makeApp(), {}) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_create_project');

    const result = await tool._handler({ name: 'HipTrip', vaultFolder: 'Projects/HipTrip' });

    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/createProject is not available/i);
  });

  it('calls createProject with name and vaultFolder', async () => {
    const createProject = vi.fn().mockReturnValue(fakeProject);
    const server = createObsidianMcpServer(makeApp(), { createProject }) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_create_project');

    await tool._handler({ name: 'HipTrip', vaultFolder: 'Projects/HipTrip' });

    expect(createProject).toHaveBeenCalledWith('HipTrip', 'Projects/HipTrip', undefined, undefined);
  });

  it('passes description and cwdOverride when provided', async () => {
    const createProject = vi.fn().mockReturnValue(fakeProject);
    const server = createObsidianMcpServer(makeApp(), { createProject }) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_create_project');

    await tool._handler({
      name: 'HipTrip',
      vaultFolder: 'Projects/HipTrip',
      description: 'Travel curation app',
      cwdOverride: '/Users/me/projects/hiptrip',
    });

    expect(createProject).toHaveBeenCalledWith(
      'HipTrip',
      'Projects/HipTrip',
      'Travel curation app',
      '/Users/me/projects/hiptrip',
    );
  });

  it('returns the created project snapshot including its id', async () => {
    const createProject = vi.fn().mockReturnValue(fakeProject);
    const server = createObsidianMcpServer(makeApp(), { createProject }) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_create_project');

    const result = await tool._handler({ name: 'HipTrip', vaultFolder: 'Projects/HipTrip' });

    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toEqual(fakeProject);
  });

  it('returns a snapshot whose id field is present and non-empty', async () => {
    const createProject = vi.fn().mockReturnValue(fakeProject);
    const server = createObsidianMcpServer(makeApp(), { createProject }) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_create_project');

    const result = await tool._handler({ name: 'HipTrip', vaultFolder: 'Projects/HipTrip' });

    const parsed = parseResult(result) as ProjectSnapshot;
    expect(parsed.id).toBeTruthy();
  });

  it('returns an error (not a throw) when createProject throws', async () => {
    const createProject = vi.fn(() => { throw new Error('duplicate project name'); });
    const server = createObsidianMcpServer(makeApp(), { createProject }) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_create_project');

    const result = await tool._handler({ name: 'HipTrip', vaultFolder: 'Projects/HipTrip' });

    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/duplicate project name/);
  });
});

describe('obsidian_update_project', () => {
  it('returns an error when updateProject callback is not provided', async () => {
    const server = createObsidianMcpServer(makeApp(), {}) as unknown as CapturedServer;
    const result = await getTool(server, 'obsidian_update_project')._handler({ projectId: fakeProject.id, name: 'Trips' });
    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/updateProject is not available/i);
  });

  it('passes a normalized partial patch and returns the persisted snapshot', async () => {
    const updated = { ...fakeProject, name: 'Trips', description: undefined, cwdOverride: '/tmp/trips', effectiveCwd: '/tmp/trips' };
    const updateProject = vi.fn().mockResolvedValue(updated);
    const server = createObsidianMcpServer(makeApp(), { updateProject }) as unknown as CapturedServer;
    const result = await getTool(server, 'obsidian_update_project')._handler({
      projectId: fakeProject.id,
      name: '  Trips  ',
      description: null,
      cwdOverride: '  /tmp/trips  ',
      elevatedProjectId: fakeProject.id,
    });
    expect(updateProject).toHaveBeenCalledWith(fakeProject.id, {
      name: 'Trips', description: undefined, cwdOverride: '/tmp/trips',
    });
    expect(parseResult(result)).toEqual(updated);
  });

  it.each([
    [{ projectId: fakeProject.id }, /at least one/i],
    [{ projectId: fakeProject.id, name: '   ' }, /name/i],
    [{ projectId: fakeProject.id, cwdOverride: 'relative/path' }, /absolute/i],
    [{ projectId: fakeProject.id, cwdOverride: '   ' }, /cwdOverride/i],
  ])('rejects invalid patches without invoking the callback: %o', async (args, message) => {
    const updateProject = vi.fn();
    const server = createObsidianMcpServer(makeApp(), { updateProject }) as unknown as CapturedServer;
    const result = await getTool(server, 'obsidian_update_project')._handler(args);
    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(message);
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('preserves empty description strings and clears cwdOverride with null', async () => {
    const updateProject = vi.fn().mockResolvedValue(fakeProject);
    const server = createObsidianMcpServer(makeApp(), { updateProject }) as unknown as CapturedServer;
    await getTool(server, 'obsidian_update_project')._handler({ projectId: fakeProject.id, description: '', cwdOverride: null });
    expect(updateProject).toHaveBeenCalledWith(fakeProject.id, { description: '', cwdOverride: undefined });
  });

  it.each(['C:\\repos\\trips', '\\\\server\\share\\trips'])('accepts Windows absolute cwd paths: %s', async (cwdOverride) => {
    const updateProject = vi.fn().mockResolvedValue(fakeProject);
    const server = createObsidianMcpServer(makeApp(), { updateProject }) as unknown as CapturedServer;
    const result = await getTool(server, 'obsidian_update_project')._handler({ projectId: fakeProject.id, cwdOverride });
    expect(result.isError).toBeUndefined();
    expect(updateProject).toHaveBeenCalledWith(fakeProject.id, { cwdOverride });
  });
});

// ── obsidian_set_thread_project ───────────────────────────────────────────────

describe('obsidian_set_thread_project', () => {
  it('returns an error when setThreadProject callback is not provided', async () => {
    const server = createObsidianMcpServer(makeApp(), {}) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_set_thread_project');

    const result = await tool._handler({ threadId: 'thread-1', projectId: 'proj-abc123' });

    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/setThreadProject is not available/i);
  });

  it('calls setThreadProject with the correct threadId and projectId', async () => {
    const setThreadProject = vi.fn();
    const server = createObsidianMcpServer(makeApp(), { setThreadProject }) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_set_thread_project');

    await tool._handler({ threadId: 'thread-1', projectId: 'proj-abc123' });

    expect(setThreadProject).toHaveBeenCalledWith('thread-1', 'proj-abc123', false);
  });

  it('passes alignCwd through when requested', async () => {
    const setThreadProject = vi.fn();
    const server = createObsidianMcpServer(makeApp(), { setThreadProject }) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_set_thread_project');

    await tool._handler({ threadId: 'thread-1', projectId: 'proj-abc123', alignCwd: true });

    expect(setThreadProject).toHaveBeenCalledWith('thread-1', 'proj-abc123', true);
  });

  it('returns success: true with the threadId and projectId on assignment', async () => {
    const setThreadProject = vi.fn();
    const server = createObsidianMcpServer(makeApp(), { setThreadProject }) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_set_thread_project');

    const result = await tool._handler({ threadId: 'thread-1', projectId: 'proj-abc123' });

    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toEqual({ success: true, threadId: 'thread-1', projectId: 'proj-abc123' });
  });

  it('accepts null projectId to detach a thread from its project', async () => {
    const setThreadProject = vi.fn();
    const server = createObsidianMcpServer(makeApp(), { setThreadProject }) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_set_thread_project');

    const result = await tool._handler({ threadId: 'thread-1', projectId: null });

    expect(result.isError).toBeUndefined();
    expect(setThreadProject).toHaveBeenCalledWith('thread-1', null, false);
    expect((parseResult(result) as { projectId: unknown }).projectId).toBeNull();
  });

  it('returns an error (not a throw) when setThreadProject throws', async () => {
    const setThreadProject = vi.fn(() => { throw new Error('thread not found'); });
    const server = createObsidianMcpServer(makeApp(), { setThreadProject }) as unknown as CapturedServer;
    const tool = getTool(server, 'obsidian_set_thread_project');

    const result = await tool._handler({ threadId: 'ghost-thread', projectId: 'proj-abc123' });

    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/thread not found/);
  });
});

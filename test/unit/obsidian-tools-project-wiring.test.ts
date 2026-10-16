/**
 * obsidian-tools-project-wiring.test.ts
 *
 * Integration tests for the main.ts callback wiring of obsidian_create_project
 * and obsidian_set_thread_project.
 *
 * The unit tests in obsidian-tools-project-tools.test.ts verify the tool handler
 * logic with mocked callbacks. This file closes the gap: it wires the callbacks
 * exactly as main.ts does — against a real ThreadManager — and asserts that
 * calling the tool handlers actually mutates ThreadManager state correctly.
 *
 * No Obsidian, no vault, no live plugin needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App } from 'obsidian';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';

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
  if (!t) throw new Error(`Tool "${name}" not found`);
  return t;
}

function parseResult(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

/**
 * Builds a real ThreadManager and the exact callbacks from main.ts, wired
 * together. Returns the manager (for state assertions) and a captured server
 * (for calling handlers).
 */
function makeWiredServer() {
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  const saveSettings = vi.fn().mockResolvedValue(undefined);

  // These callbacks mirror the implementations in main.ts verbatim.
  const createProject = (name: string, vaultFolder: string, description?: string, cwdOverride?: string) => {
    const p = manager.createProject(name, vaultFolder, description, cwdOverride);
    saveSettings().catch(console.error);
    return { id: p.id, name: p.name, description: p.description, vaultFolder: p.vaultFolder, cwdOverride: p.cwdOverride, effectiveCwd: manager.getProjectCwd(p) };
  };

  const setThreadProject = (threadId: string, projectId: string | null, alignCwd?: boolean) => {
    manager.setThreadProject(threadId, projectId, alignCwd);
    saveSettings().catch(console.error);
  };

  const server = createObsidianMcpServer(makeApp(), { createProject, setThreadProject }) as unknown as CapturedServer;

  return { manager, server, saveSettings };
}

// ── obsidian_create_project — wiring integration ──────────────────────────────

describe('obsidian_create_project — main.ts wiring', () => {
  let manager: ThreadManager;
  let server: CapturedServer;
  let saveSettings: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ manager, server, saveSettings } = makeWiredServer());
  });

  it('creates the project in ThreadManager', async () => {
    const tool = getTool(server, 'obsidian_create_project');
    expect(manager.getProjects()).toHaveLength(0);

    await tool._handler({ name: 'HipTrip', vaultFolder: 'Projects/HipTrip' });

    expect(manager.getProjects()).toHaveLength(1);
    expect(manager.getProjects()[0].name).toBe('HipTrip');
    expect(manager.getProjects()[0].vaultFolder).toBe('Projects/HipTrip');
  });

  it('returns the created project snapshot with a non-empty id', async () => {
    const tool = getTool(server, 'obsidian_create_project');

    const result = await tool._handler({ name: 'HipTrip', vaultFolder: 'Projects/HipTrip' });

    const snapshot = parseResult(result) as { id: string; name: string; vaultFolder: string };
    expect(snapshot.id).toBeTruthy();
    expect(snapshot.name).toBe('HipTrip');
    expect(snapshot.vaultFolder).toBe('Projects/HipTrip');
  });

  it('returned id matches the project stored in ThreadManager', async () => {
    const tool = getTool(server, 'obsidian_create_project');

    const result = await tool._handler({ name: 'HipTrip', vaultFolder: 'Projects/HipTrip' });

    const { id } = parseResult(result) as { id: string };
    expect(manager.getProject(id)).toBeDefined();
    expect(manager.getProject(id)!.name).toBe('HipTrip');
  });

  it('stores description and cwdOverride in ThreadManager', async () => {
    const tool = getTool(server, 'obsidian_create_project');

    const result = await tool._handler({
      name: 'HipTrip',
      vaultFolder: 'Projects/HipTrip',
      description: 'Travel curation',
      cwdOverride: '/Users/me/projects/hiptrip',
    });

    const { id } = parseResult(result) as { id: string };
    const stored = manager.getProject(id)!;
    expect(stored.description).toBe('Travel curation');
    expect(stored.cwdOverride).toBe('/Users/me/projects/hiptrip');
  });

  it('calls saveSettings after creating the project', async () => {
    const tool = getTool(server, 'obsidian_create_project');

    await tool._handler({ name: 'HipTrip', vaultFolder: 'Projects/HipTrip' });

    expect(saveSettings).toHaveBeenCalledOnce();
  });
});

// ── obsidian_set_thread_project — wiring integration ─────────────────────────

describe('obsidian_set_thread_project — main.ts wiring', () => {
  let manager: ThreadManager;
  let server: CapturedServer;
  let saveSettings: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ manager, server, saveSettings } = makeWiredServer());
  });

  it('sets projectId on the thread in ThreadManager', async () => {
    const thread = manager.createThread('My thread', '/cwd');
    const project = manager.createProject('HipTrip', 'Projects/HipTrip');
    const tool = getTool(server, 'obsidian_set_thread_project');

    await tool._handler({ threadId: thread.id, projectId: project.id });

    expect(manager.getThread(thread.id)!.projectId).toBe(project.id);
  });

  it('clears projectId when null is passed', async () => {
    const thread = manager.createThread('My thread', '/cwd');
    const project = manager.createProject('HipTrip', 'Projects/HipTrip');
    thread.projectId = project.id; // pre-assign
    const tool = getTool(server, 'obsidian_set_thread_project');

    await tool._handler({ threadId: thread.id, projectId: null });

    expect(manager.getThread(thread.id)!.projectId).toBeUndefined();
  });

  it('aligns the thread cwd when alignCwd is true', async () => {
    const thread = manager.createThread('My thread', '/cwd');
    const project = manager.createProject('HipTrip', 'Projects/HipTrip', undefined, '/repos/hiptrip');
    thread.sessionId = 'old-session';
    const tool = getTool(server, 'obsidian_set_thread_project');

    await tool._handler({ threadId: thread.id, projectId: project.id, alignCwd: true });

    expect(manager.getThread(thread.id)).toMatchObject({ projectId: project.id, cwd: '/repos/hiptrip' });
    expect(manager.getThread(thread.id)?.sessionId).toBeUndefined();
  });

  it('returns success: true with the threadId and projectId', async () => {
    const thread = manager.createThread('My thread', '/cwd');
    const project = manager.createProject('HipTrip', 'Projects/HipTrip');
    const tool = getTool(server, 'obsidian_set_thread_project');

    const result = await tool._handler({ threadId: thread.id, projectId: project.id });

    expect(result.isError).toBeUndefined();
    expect(parseResult(result)).toEqual({ success: true, threadId: thread.id, projectId: project.id });
  });

  it('returns an error when the thread does not exist', async () => {
    const tool = getTool(server, 'obsidian_set_thread_project');

    const result = await tool._handler({ threadId: 'ghost-thread', projectId: 'any-project' });

    expect(result.isError).toBe(true);
    expect((parseResult(result) as { error: string }).error).toMatch(/Thread not found: ghost-thread/);
  });

  it('calls saveSettings after updating the thread', async () => {
    const thread = manager.createThread('My thread', '/cwd');
    const project = manager.createProject('HipTrip', 'Projects/HipTrip');
    const tool = getTool(server, 'obsidian_set_thread_project');

    await tool._handler({ threadId: thread.id, projectId: project.id });

    expect(saveSettings).toHaveBeenCalledOnce();
  });
});

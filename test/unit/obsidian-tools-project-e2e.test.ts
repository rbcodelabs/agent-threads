/**
 * obsidian-tools-project-e2e.test.ts
 *
 * End-to-end tests for obsidian_create_project and obsidian_set_thread_project
 * using the real MCP protocol stack — no SDK mocks.
 *
 * Stack under test (all real, no mocks):
 *   createObsidianMcpServer  (ObsidianTools.ts)
 *     → createSdkMcpServer   (@anthropic-ai/claude-agent-sdk/browser)
 *       → McpServer.instance (@modelcontextprotocol/sdk)
 *         ↕ InMemoryTransport
 *       Client.callTool()    (@modelcontextprotocol/sdk)
 *     → ThreadManager        (real state mutations)
 *
 * What this covers that the unit/wiring tests do NOT:
 *   - The real tool() registration wires the handler under the correct name
 *   - The real createSdkMcpServer routes callTool() to the right handler
 *   - Arguments are passed through the MCP protocol layer without corruption
 *   - The returned content is serialised JSON we can parse back
 *
 * No Obsidian, no vault — just Node.js + in-memory transport.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { App } from 'obsidian';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS } from '../../src/types';
import { createObsidianMcpServer } from '../../src/ObsidianTools';
import type { ProjectSnapshot } from '../../src/ObsidianTools';

// ── Types ─────────────────────────────────────────────────────────────────────

interface McpCallToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
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

/** Builds a ThreadManager + server + MCP client connected via InMemoryTransport. */
async function makeE2EFixture() {
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  const saveSettings = vi.fn().mockResolvedValue(undefined);

  // Callbacks mirroring main.ts exactly.
  const createProject = (name: string, vaultFolder: string, description?: string, cwdOverride?: string) => {
    const p = manager.createProject(name, vaultFolder, description, cwdOverride);
    saveSettings().catch(console.error);
    return { id: p.id, name: p.name, description: p.description, vaultFolder: p.vaultFolder, cwdOverride: p.cwdOverride, effectiveCwd: manager.getProjectCwd(p) };
  };

  const setThreadProject = (threadId: string, projectId: string | null, alignCwd?: boolean) => {
    manager.setThreadProject(threadId, projectId, alignCwd);
    saveSettings().catch(console.error);
  };

  // Real SDK — createObsidianMcpServer returns McpSdkServerConfigWithInstance.
  const serverConfig = createObsidianMcpServer(makeApp(), { createProject, setThreadProject }) as unknown as {
    instance: { connect: (transport: unknown) => Promise<void> };
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await serverConfig.instance.connect(serverTransport);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);

  return { manager, client, saveSettings };
}

function parseToolResult(result: McpCallToolResult): unknown {
  if (!result.content?.[0]?.text) throw new Error('No text content in tool result');
  return JSON.parse(result.content[0].text);
}

// ── obsidian_create_project — E2E ─────────────────────────────────────────────

describe('obsidian_create_project — E2E via MCP protocol', () => {
  let manager: ThreadManager;
  let client: Client;
  let saveSettings: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ({ manager, client, saveSettings } = await makeE2EFixture());
  });

  afterEach(async () => {
    await client.close();
  });

  it('tool is discoverable via listTools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('obsidian_create_project');
    expect(names).toContain('obsidian_set_thread_project');
  });

  it('creates a project in ThreadManager and returns its snapshot', async () => {
    const result = await client.callTool({
      name: 'obsidian_create_project',
      arguments: { name: 'HipTrip', vaultFolder: 'Projects/HipTrip' },
    }) as McpCallToolResult;

    expect(result.isError).toBeFalsy();
    const snapshot = parseToolResult(result) as ProjectSnapshot;
    expect(snapshot.id).toBeTruthy();
    expect(snapshot.name).toBe('HipTrip');
    expect(snapshot.vaultFolder).toBe('Projects/HipTrip');

    // Verify state was actually mutated in the manager.
    expect(manager.getProjects()).toHaveLength(1);
    expect(manager.getProject(snapshot.id)).toBeDefined();
  });

  it('returned id matches the project stored in ThreadManager', async () => {
    const result = await client.callTool({
      name: 'obsidian_create_project',
      arguments: { name: 'HipTrip', vaultFolder: 'Projects/HipTrip' },
    }) as McpCallToolResult;

    const { id } = parseToolResult(result) as ProjectSnapshot;
    expect(manager.getProject(id)?.name).toBe('HipTrip');
  });

  it('passes optional description and cwdOverride through the protocol', async () => {
    const result = await client.callTool({
      name: 'obsidian_create_project',
      arguments: {
        name: 'HipTrip',
        vaultFolder: 'Projects/HipTrip',
        description: 'Travel curation',
        cwdOverride: '/Users/me/projects/hiptrip',
      },
    }) as McpCallToolResult;

    const { id } = parseToolResult(result) as ProjectSnapshot;
    const stored = manager.getProject(id)!;
    expect(stored.description).toBe('Travel curation');
    expect(stored.cwdOverride).toBe('/Users/me/projects/hiptrip');
  });

  it('creates independent projects on repeated calls', async () => {
    await client.callTool({ name: 'obsidian_create_project', arguments: { name: 'Alpha', vaultFolder: 'A' } });
    await client.callTool({ name: 'obsidian_create_project', arguments: { name: 'Beta', vaultFolder: 'B' } });

    const projects = manager.getProjects();
    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.name)).toEqual(expect.arrayContaining(['Alpha', 'Beta']));
  });

  it('calls saveSettings after creating the project', async () => {
    await client.callTool({
      name: 'obsidian_create_project',
      arguments: { name: 'HipTrip', vaultFolder: 'Projects/HipTrip' },
    });
    expect(saveSettings).toHaveBeenCalledOnce();
  });
});

// ── obsidian_set_thread_project — E2E ─────────────────────────────────────────

describe('obsidian_set_thread_project — E2E via MCP protocol', () => {
  let manager: ThreadManager;
  let client: Client;
  let saveSettings: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ({ manager, client, saveSettings } = await makeE2EFixture());
  });

  afterEach(async () => {
    await client.close();
  });

  it('assigns a thread to a project and mutates ThreadManager state', async () => {
    const thread = manager.createThread('My thread', '/cwd');
    const project = manager.createProject('HipTrip', 'Projects/HipTrip');

    const result = await client.callTool({
      name: 'obsidian_set_thread_project',
      arguments: { threadId: thread.id, projectId: project.id },
    }) as McpCallToolResult;

    expect(result.isError).toBeFalsy();
    expect(manager.getThread(thread.id)?.projectId).toBe(project.id);
  });

  it('returns success: true with threadId and projectId', async () => {
    const thread = manager.createThread('My thread', '/cwd');
    const project = manager.createProject('HipTrip', 'Projects/HipTrip');

    const result = await client.callTool({
      name: 'obsidian_set_thread_project',
      arguments: { threadId: thread.id, projectId: project.id },
    }) as McpCallToolResult;

    expect(parseToolResult(result)).toEqual({
      success: true,
      threadId: thread.id,
      projectId: project.id,
    });
  });

  it('clears projectId when null is passed', async () => {
    const thread = manager.createThread('My thread', '/cwd');
    const project = manager.createProject('HipTrip', 'Projects/HipTrip');
    thread.projectId = project.id;

    const result = await client.callTool({
      name: 'obsidian_set_thread_project',
      arguments: { threadId: thread.id, projectId: null },
    }) as McpCallToolResult;

    expect(result.isError).toBeFalsy();
    expect(manager.getThread(thread.id)?.projectId).toBeUndefined();
    expect((parseToolResult(result) as { projectId: unknown }).projectId).toBeNull();
  });

  it('returns an error result for an unknown threadId', async () => {
    const result = await client.callTool({
      name: 'obsidian_set_thread_project',
      arguments: { threadId: 'ghost-thread', projectId: 'any-project' },
    }) as McpCallToolResult;

    expect(result.isError).toBe(true);
    expect((parseToolResult(result) as { error: string }).error).toMatch(/Thread not found: ghost-thread/);
  });

  it('calls saveSettings after updating the thread', async () => {
    const thread = manager.createThread('My thread', '/cwd');
    const project = manager.createProject('HipTrip', 'Projects/HipTrip');

    await client.callTool({
      name: 'obsidian_set_thread_project',
      arguments: { threadId: thread.id, projectId: project.id },
    });

    expect(saveSettings).toHaveBeenCalledOnce();
  });
});

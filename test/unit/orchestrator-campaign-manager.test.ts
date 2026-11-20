import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: ({ name, tools }: { name: string; tools: unknown[] }) => ({ name, tools }),
}));

import {
  ORCHESTRATOR_ROLE_DISALLOWED_TOOLS,
  buildOrchestratorCharter,
  buildOrchestratorGoalContext,
  parseManagerNotesTriage,
  resolveOrchestratorLedgerPath,
  sanitizeInlineRoleLabel,
  sanitizeLedgerSegment,
} from '../../src/orchestratorCharter';
import { canWriteManagerNotes } from '../../src/coordinationScope';
import { openCodePermissionConfig, openCodePermissionRules } from '../../src/OpenCodeSession';
import { composeAppendSystemPrompt } from '../../src/projectOverview';
import { withCreatorToolRestrictions } from '../../src/toolRestrictions';
import * as HarnessFactory from '../../src/HarnessFactory';
import { ThreadManager } from '../../src/ThreadManager';
import { createThreadTools } from '../../src/tools/threads';
import { createScheduleTools } from '../../src/tools/schedule';
import { DEFAULT_SETTINGS, type HarnessSessionOptions } from '../../src/types';
import type { ThreadDetail, ThreadSnapshot } from '../../src/ObsidianTools';

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;
const invoke = (tools: Record<string, unknown>, name: string, args: Record<string, unknown> = {}) =>
  (tools[name] as { handler: Handler }).handler(args, {});

describe('orchestratorCharter pure helpers', () => {
  it('builds role-specific invariant charter with 5-channel contract, ledger path, and anti-self-execution boundary', () => {
    const portfolio = buildOrchestratorCharter({ kind: 'portfolio' });
    expect(portfolio).toContain('Portfolio Orchestrator');
    expect(portfolio).toContain('NEVER edit code');
    expect(portfolio).toContain('threads_create');
    expect(portfolio).toContain('threads_send_message');
    expect(portfolio).toContain('threads_set_proposed_reply');
    expect(portfolio).toContain('threads_post_decision');
    expect(portfolio).toContain('threads_set_notes');
    expect(portfolio).toContain('threads_get');
    expect(portfolio).toContain('view: "triage"');
    expect(portfolio).toContain('Products/Portfolio/orchestrator-ledger.md');
    expect(portfolio).toContain('[[thread:<id>|Title]]');

    const project = buildOrchestratorCharter({ kind: 'project', projectId: 'p1', projectName: 'Compass' });
    expect(project).toContain('Project Orchestrator for Compass');
    expect(project).toContain('Products/Compass/orchestrator-ledger.md');
  });

  it('reframes /goal on an orchestrator as a coordination campaign goal rather than direct execution', () => {
    const text = buildOrchestratorGoalContext('Integrate PRs #594–#617');
    expect(text).toContain('## Active Campaign Goal');
    expect(text).toContain('Integrate PRs #594–#617');
    expect(text).toContain('Agent Board worker threads');
    expect(text).toContain('never by executing repository');
    expect(text).toContain('/goal clear');
  });

  it('parses Manager notes v2 and computes needsReview accurately across cursor and staged states', () => {
    expect(parseManagerNotesTriage(undefined, 1000)).toEqual({
      notesVersion: 'none',
      needsReview: true,
    });

    const v2UpToDate = [
      'Orchestrator state: v2',
      'Project outcome: Ship batch',
      'Goal status: user-stated',
      'Thread outcome: Fix login race',
      'Strategy: Worktree fix + tq unit gate',
      'Done when: PR checks green',
      'Constraints: Do not merge',
      'Last reviewed update: 5000',
      'Last substantive change: Opened PR #12',
      'Last intervention: execution',
      'Decision unlocked: none',
      'Staged for update: 5000',
      'Staged: proposed reply — rebase onto main',
      'Disposition: advance',
      'Status: Running tq check on PR #12',
    ].join('\n');

    expect(parseManagerNotesTriage(v2UpToDate, 5000)).toEqual({
      notesVersion: 'v2',
      outcome: 'Fix login race',
      strategy: 'Worktree fix + tq unit gate',
      disposition: 'advance',
      status: 'Running tq check on PR #12',
      lastReviewedUpdate: 5000,
      stagedForUpdate: 5000,
      staged: 'proposed reply — rebase onto main',
      needsReview: false,
    });

    // Newer thread.updatedAt triggers review
    expect(parseManagerNotesTriage(v2UpToDate, 5001).needsReview).toBe(true);

    // needs-decision with Staged for update: none still needs review even at same updatedAt
    const waitingUnstaged = v2UpToDate
      .replace('Staged for update: 5000', 'Staged for update: none')
      .replace('Staged: proposed reply — rebase onto main', 'Staged: none')
      .replace('Disposition: advance', 'Disposition: needs-decision');
    expect(parseManagerNotesTriage(waitingUnstaged, 5000).needsReview).toBe(true);

    // needs-decision already staged for 5000 does NOT need re-review until updatedAt moves
    const waitingAlreadyStaged = waitingUnstaged
      .replace('Staged for update: none', 'Staged for update: 5000')
      .replace('Staged: none', 'Staged: decision dec-1');
    expect(parseManagerNotesTriage(waitingAlreadyStaged, 5000).needsReview).toBe(false);

    // Stale Staged for update from an earlier turn (4000 !== 5000) still requires review, even when Disposition is backticked
    const staleStaged = waitingUnstaged
      .replace('Staged for update: none', 'Staged for update: 4000')
      .replace('Disposition: needs-decision', 'Disposition: `Needs-Decision`');
    expect(parseManagerNotesTriage(staleStaged, 5000)).toMatchObject({
      disposition: 'needs-decision',
      stagedForUpdate: 4000,
      needsReview: true,
    });

    // Sanitization guards against dot segments, slashes, and newline prompt injection
    expect(sanitizeLedgerSegment('.')).toBe('Project');
    expect(sanitizeLedgerSegment('..')).toBe('Project');
    expect(sanitizeLedgerSegment('a/b\\c')).toBe('a-b-c');
    expect(sanitizeInlineRoleLabel('Compass\n## Injected')).toBe('Compass ## Injected');
    expect(resolveOrchestratorLedgerPath(null)).toBe('Products/Portfolio/orchestrator-ledger.md');
    expect(resolveOrchestratorLedgerPath('.')).toBe('Products/Project/orchestrator-ledger.md');

    // Legacy notes format
    const legacy = 'Orchestrator-tracked goal: Ship fix\nLast reviewed: 2026-11-01\nStatus: Done';
    const parsedLegacy = parseManagerNotesTriage(legacy, 5000);
    expect(parsedLegacy.notesVersion).toBe('legacy');
    expect(parsedLegacy.outcome).toBe('Ship fix');
    expect(parsedLegacy.status).toBe('Done');
    expect(parsedLegacy.needsReview).toBe(true);
  });

  it('places orchestratorCharter between overviewContext and goalContext in composeAppendSystemPrompt', () => {
    const prompt = composeAppendSystemPrompt({
      envContext: 'ENV',
      projectDesc: 'DESC',
      overviewContext: 'OVERVIEW',
      orchestratorCharter: 'CHARTER',
      goalContext: 'GOAL',
    });
    expect(prompt).toBe('ENV\n\nDESC\n\nOVERVIEW\n\nCHARTER\n\nGOAL');
  });
});

describe('ThreadManager orchestrator session options, non-inherited tool lockout, peer skills & session reset', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-orch-b-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const buildOpts = (manager: ThreadManager, threadId: string): HarnessSessionOptions => {
    const thread = manager.getThread(threadId)!;
    return (manager as unknown as {
      buildThreadSessionOptions(id: string, t: typeof thread): HarnessSessionOptions;
    }).buildThreadSessionOptions(threadId, thread);
  };

  it('injects Charter, reframes /goal, locks out worker tools on orchestrators, and NEVER taints spawned worker threads', () => {
    const settings = { ...DEFAULT_SETTINGS, defaultCwd: tmpDir };
    const manager = new ThreadManager(settings);
    manager.vaultRoot = tmpDir;
    manager.pluginResourceDir = path.join(tmpDir, 'plugin-res');
    manager.peerSkills.register(
      { pluginId: 'threads-orchestrator' },
      { name: 'thread-orchestrator', description: 'Orchestrate threads', content: '# Skill' },
    );

    const project = manager.createProject('Compass', 'Products/Compass', 'Use worktrees and run tests.');
    const orch = manager.createThread('Compass Orchestrator', tmpDir, project.id, 'claude');
    orch.goal = 'Move PRs #594–#617 to merge';
    manager.updateProject(project.id, { orchestratorThreadId: orch.id });

    const worker = manager.createThread('Fix PR #599', tmpDir, project.id, 'claude');
    worker.goal = 'Fix 21 E2E failures';

    const orchOpts = buildOpts(manager, orch.id);
    expect(orchOpts.appendSystemPrompt).toContain('Project Orchestrator for Compass');
    expect(orchOpts.appendSystemPrompt).toContain('## Active Campaign Goal');
    expect(orchOpts.appendSystemPrompt).not.toContain('## Active Goal\n');

    for (const tool of ORCHESTRATOR_ROLE_DISALLOWED_TOOLS) {
      expect(orchOpts.disallowedTools).toContain(tool);
      expect(orchOpts.claude?.disallowedTools).toContain(tool);
    }

    // Peer skills root reaches Codex & OpenCode skillRoots with materialized <root>/thread-orchestrator/SKILL.md
    expect(orchOpts.codex?.skillRoots?.some(r => fs.existsSync(path.join(r, 'thread-orchestrator', 'SKILL.md')))).toBe(true);
    expect(orchOpts.opencode?.skillRoots?.some(r => fs.existsSync(path.join(r, 'thread-orchestrator', 'SKILL.md')))).toBe(true);

    // CRITICAL: persisted thread.disallowedTools on the orchestrator stays undefined so spawned worker threads keep full coding tools!
    expect(orch.disallowedTools).toBeUndefined();
    const spawnedParams = withCreatorToolRestrictions({ title: 'Spawned worker' }, orch);
    expect(spawnedParams.disallowedTools).toBeUndefined();

    // Ordinary worker thread in the same Project keeps normal tools and normal /goal prompt
    const workerOpts = buildOpts(manager, worker.id);
    expect(workerOpts.appendSystemPrompt).not.toContain('Project Orchestrator for Compass');
    expect(workerOpts.appendSystemPrompt).toContain('## Active Goal\n');
    expect(workerOpts.disallowedTools).toBeUndefined();
    expect(workerOpts.claude?.disallowedTools).toEqual(DEFAULT_SETTINGS.disallowedTools);
    for (const tool of ORCHESTRATOR_ROLE_DISALLOWED_TOOLS) {
      expect(workerOpts.claude?.disallowedTools).not.toContain(tool);
    }
  });

  it('resets an orchestrator session cleanly: clears sessionId & resumeFallbackHistory, bumps generation, and adds notice', () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, defaultCwd: tmpDir });
    manager.vaultRoot = tmpDir;
    const orch = manager.createThread('Portfolio Orchestrator', tmpDir);
    orch.sessionId = 'sess-old-4793';
    orch.messages.push({ id: 'm1', role: 'user', content: 'Old turn', timestamp: 100 });
    const prevGen = orch.sessionGeneration ?? 0;

    expect(manager.resetThreadSession(orch.id)).toBe(true);
    expect(orch.sessionId).toBeUndefined();
    expect(orch.sessionGeneration).toBe(prevGen + 1);
    expect(orch.messages.at(-1)).toMatchObject({
      role: 'notice',
      noticeStatus: 'completed',
    });

    const optsAfter = buildOpts(manager, orch.id);
    expect(optsAfter.resume).toBeUndefined();
    expect(optsAfter.resumeFallbackHistory).toBeUndefined();

    // OpenCode v1 & v2 enforce shell, bash, edit, task, and question lockout on ORCHESTRATOR_ROLE_DISALLOWED_TOOLS
    expect(openCodePermissionConfig(ORCHESTRATOR_ROLE_DISALLOWED_TOOLS)).toMatchObject({
      bash: 'deny',
      edit: 'deny',
      task: 'deny',
      question: 'deny',
    });
    const rulesV2 = openCodePermissionRules(ORCHESTRATOR_ROLE_DISALLOWED_TOOLS);
    expect(rulesV2).toContainEqual({ action: 'shell', resource: '*', effect: 'deny' });
    expect(rulesV2).toContainEqual({ action: 'edit', resource: '*', effect: 'deny' });
    expect(rulesV2).toContainEqual({ action: 'task', resource: '*', effect: 'deny' });
    expect(rulesV2).toContainEqual({ action: 'question', resource: '*', effect: 'deny' });
  });

  it('refuses resetThreadSession while running and prevents pre-reset history replay on subsequent sendMessage', async () => {
    const sentPrompts: string[] = [];
    const spy = vi.spyOn(HarnessFactory, 'createHarnessSession').mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn((prompt: string) => {
        sentPrompts.push(prompt);
      }),
      close: vi.fn(),
      interrupt: vi.fn().mockResolvedValue(undefined),
      isRunning: () => false,
      turnInFlight: false,
    }) as never);
    try {
      const manager = new ThreadManager({ ...DEFAULT_SETTINGS, defaultCwd: tmpDir });
      manager.vaultRoot = tmpDir;
      const orch = manager.createThread('Portfolio Orchestrator', tmpDir);
      orch.sessionId = 'sess-bloated';
      orch.messages.push(
        { id: 'u1', role: 'user', content: 'PRE_RESET_SECRET_USER_TURN', timestamp: 10 },
        { id: 'a1', role: 'assistant', content: 'PRE_RESET_SECRET_ASSISTANT_TURN', timestamp: 20 },
      );

      // Simulate active turn -> resetThreadSession must refuse
      vi.spyOn(manager, 'isRunning').mockReturnValueOnce(true);
      expect(manager.resetThreadSession(orch.id)).toBe(false);
      expect(orch.sessionId).toBe('sess-bloated');

      // Idle -> reset succeeds and records contextResetAtMessageCount
      expect(manager.resetThreadSession(orch.id)).toBe(true);
      expect(orch.contextResetAtMessageCount).toBe(orch.messages.length);

      await manager.sendMessage(orch.id, 'Fresh heartbeat after reset');
      expect(sentPrompts).toHaveLength(1);
      expect(sentPrompts[0]).toContain('Fresh heartbeat after reset');
      expect(sentPrompts[0]).not.toContain('PRE_RESET_SECRET_USER_TURN');
      expect(sentPrompts[0]).not.toContain('PRE_RESET_SECRET_ASSISTANT_TURN');
      expect(sentPrompts[0]).not.toContain('Prior conversation history');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('ScheduleWakeup orchestrator guard & threads_get / threads_list triage view', () => {
  it('refuses ScheduleWakeup on orchestrator threads while allowing ordinary worker threads', async () => {
    const onScheduleWakeup = vi.fn().mockResolvedValue(undefined);
    const orchSchedule = createScheduleTools({
      options: {
        threadId: 'orch-1',
        isOrchestratorThread: (id) => id === 'orch-1',
        onScheduleWakeup,
      },
    });
    const denied = await invoke(orchSchedule, 'ScheduleWakeup', { delaySeconds: 30, prompt: 'poll', reason: 'check tq' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain('WakeupService');
    expect(onScheduleWakeup).not.toHaveBeenCalled();

    const workerSchedule = createScheduleTools({
      options: {
        threadId: 'worker-1',
        isOrchestratorThread: (id) => id === 'orch-1',
        onScheduleWakeup,
      },
    });
    const allowed = await invoke(workerSchedule, 'ScheduleWakeup', { delaySeconds: 30, prompt: 'poll', reason: 'check tq' });
    expect(allowed.isError).toBeUndefined();
    expect(onScheduleWakeup).toHaveBeenCalledOnce();
  });

  it('serves O(1) threads_get with optional recentMessages and compact threads_list view="triage"', async () => {
    const sampleNotes = [
      'Orchestrator state: v2',
      'Project outcome: Ship',
      'Goal status: user-stated',
      'Thread outcome: Fix #599',
      'Strategy: Rebase + tq',
      'Done when: CI green',
      'Constraints: No merge',
      'Last reviewed update: 1000',
      'Last substantive change: Pushed fix',
      'Last intervention: none',
      'Decision unlocked: none',
      'Staged for update: none',
      'Staged: none',
      'Disposition: advance',
      'Status: Running gates',
    ].join('\n');

    const snapA: ThreadSnapshot = {
      id: 't-a',
      title: 'Worker A',
      status: 'waiting',
      uiStatus: 'new',
      isRunning: false,
      projectId: 'p1',
      prUrl: 'https://github.com/rbcodelabs/compass/pull/599',
      updatedAt: 2000,
      messageCount: 3,
      managerNotes: sampleNotes,
      proposedReply: { text: 'Very long drafted reply text that triage mode omits', generatedAt: 1900, sourceThreadId: 'orch-1' },
      pendingDecisions: [],
    };

    const detailA: ThreadDetail = {
      ...snapA,
      goal: 'Fix all 21 failures',
      messages: [
        { id: '1', role: 'user', content: 'm1', timestamp: 1 },
        { id: '2', role: 'assistant', content: 'm2', timestamp: 2 },
        { id: '3', role: 'assistant', content: 'm3', timestamp: 3 },
      ],
    };

    const tools = createThreadTools({
      options: {
        threadId: 'orch-1',
        getAllThreads: () => [snapA],
        getThreadDetail: (id) => (id === 't-a' ? detailA : undefined),
        authorizeThread: (_id, elevated) => elevated === 'p1',
      },
    });

    // Out-of-scope without elevation
    const denied = await invoke(tools, 'threads_get', { threadId: 't-a' });
    expect(denied.isError).toBe(true);

    // O(1) read without messages
    const gotMeta = JSON.parse((await invoke(tools, 'threads_get', { threadId: 't-a', elevatedProjectId: 'p1' })).content[0]!.text!);
    expect(gotMeta.id).toBe('t-a');
    expect(gotMeta.goal).toBe('Fix all 21 failures');
    expect(gotMeta.managerNotes).toContain('Orchestrator state: v2');
    expect(gotMeta.triage).toMatchObject({
      notesVersion: 'v2',
      outcome: 'Fix #599',
      strategy: 'Rebase + tq',
      disposition: 'advance',
      needsReview: true,
    });
    expect(gotMeta.messages).toBeUndefined();

    // O(1) read with recentMessages: 2
    const gotWithMsgs = JSON.parse((await invoke(tools, 'threads_get', { threadId: 't-a', recentMessages: 2, elevatedProjectId: 'p1' })).content[0]!.text!);
    expect(gotWithMsgs.messages).toHaveLength(2);
    expect(gotWithMsgs.messages[0].content).toBe('m2');

    // threads_list view="triage" omits raw managerNotes & proposedReply.text
    const triageList = JSON.parse((await invoke(tools, 'obsidian_list_threads', { projectId: 'p1', view: 'triage' })).content[0]!.text!);
    expect(triageList).toHaveLength(1);
    expect(triageList[0].managerNotes).toBeUndefined();
    expect(triageList[0].proposedReply).toBeUndefined();
    expect(triageList[0]).toMatchObject({
      id: 't-a',
      hasProposedReply: true,
      proposedReplySourceThreadId: 'orch-1',
      pendingDecisionCount: 0,
      triage: {
        notesVersion: 'v2',
        outcome: 'Fix #599',
        disposition: 'advance',
        needsReview: true,
      },
    });

    // Default threads_list preserves full snapshot
    const fullList = JSON.parse((await invoke(tools, 'obsidian_list_threads', { projectId: 'p1' })).content[0]!.text!);
    expect(fullList[0].managerNotes).toBe(sampleNotes);
    expect(fullList[0].proposedReply.text).toContain('Very long drafted reply');
  });

  it('enforces disabled-Project note/ledger write scope and serves threads_get_ledger & threads_set_ledger', async () => {
    const projects = [
      { id: 'p-enabled', orchestratorEnabled: undefined },
      { id: 'p-disabled', orchestratorEnabled: false },
    ];
    // Portfolio cannot write notes on an enabled Project even with elevatedProjectId
    expect(canWriteManagerNotes({ kind: 'portfolio' }, 'p-enabled', 'p-enabled', projects)).toBe(false);
    // Portfolio CAN write notes/ledger on a disabled Project when elevatedProjectId matches
    expect(canWriteManagerNotes({ kind: 'portfolio' }, 'p-disabled', 'p-disabled', projects)).toBe(true);
    expect(canWriteManagerNotes({ kind: 'portfolio' }, 'p-disabled', undefined, projects)).toBe(false);
    // Project orchestrator owns its own Project
    expect(canWriteManagerNotes({ kind: 'project-orchestrator', projectId: 'p-enabled' }, 'p-enabled', undefined, projects)).toBe(true);

    let ledgerContent = '';
    const tools = createThreadTools({
      options: {
        threadId: 'orch-portfolio',
        getOrchestratorLedger: async ({ projectId, elevatedProjectId }) => {
          const target = projectId === null ? undefined : projectId;
          if (target && elevatedProjectId !== target) throw new Error('Target is outside coordination scope.');
          return {
            path: resolveOrchestratorLedgerPath(target ? 'Disabled Proj' : null),
            exists: ledgerContent.length > 0,
            content: ledgerContent,
          };
        },
        setOrchestratorLedger: async ({ content, projectId, elevatedProjectId }) => {
          const target = projectId === null ? undefined : projectId;
          if (!canWriteManagerNotes({ kind: 'portfolio' }, target, elevatedProjectId, projects)) {
            throw new Error('Target is outside coordination scope.');
          }
          ledgerContent = content;
          return {
            path: resolveOrchestratorLedgerPath(target ? 'Disabled Proj' : null),
            bytes: Buffer.byteLength(content, 'utf8'),
          };
        },
      },
    });

    // Portfolio writes its own ledger
    const writePortfolio = JSON.parse((await invoke(tools, 'threads_set_ledger', { content: '# Wave 1\n- PR #1' })).content[0]!.text!);
    expect(writePortfolio).toMatchObject({
      success: true,
      path: 'Products/Portfolio/orchestrator-ledger.md',
    });
    const readPortfolio = JSON.parse((await invoke(tools, 'threads_get_ledger', {})).content[0]!.text!);
    expect(readPortfolio).toEqual({
      path: 'Products/Portfolio/orchestrator-ledger.md',
      exists: true,
      content: '# Wave 1\n- PR #1',
    });

    // Portfolio denied writing enabled Project's ledger even with elevation
    const deniedEnabled = await invoke(tools, 'threads_set_ledger', {
      content: 'intrude',
      projectId: 'p-enabled',
      elevatedProjectId: 'p-enabled',
    });
    expect(deniedEnabled.isError).toBe(true);

    // Portfolio allowed writing disabled Project's ledger with matching elevatedProjectId
    const writeDisabled = JSON.parse((await invoke(tools, 'threads_set_ledger', {
      content: '# Disabled fallback ledger',
      projectId: 'p-disabled',
      elevatedProjectId: 'p-disabled',
    })).content[0]!.text!);
    expect(writeDisabled).toMatchObject({
      success: true,
      path: 'Products/Disabled Proj/orchestrator-ledger.md',
    });
  });
});

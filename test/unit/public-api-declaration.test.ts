import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClaudeThreadsApiV1 } from '../../src/PublicApi';
import { ArtifactProviderRegistry } from '../../src/ArtifactContributions';
import { MessageContentProviderRegistry } from '../../src/MessageContent';
import { AgentToolRegistry } from '../../src/AgentToolContributions';
import { SlashCommandRegistry } from '../../src/SlashCommandContributions';
import { createArtifactStore } from '../../src/artifactStore';

const artifactStore = () => createArtifactStore({
  vaultRoot: () => '/vault', getThread: () => undefined, saveSettings: async () => {},
});

/**
 * ADR-0008: the runtime capability list, the checked-in consumer declaration
 * and the docs must stay in sync. The declaration had already drifted once —
 * it omitted the entire `mcp` namespace shipped in v0.33.0 — so this pins the
 * two together in both directions.
 */
const DECLARATION_PATH = resolve(__dirname, '../../api/public-api-v1.d.ts');

/** Contents of the balanced `{ ... }` that starts at `openIndex`. */
function balanced(source: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  throw new Error('Unbalanced braces in the public API declaration.');
}

/** Splits on `;` that sit outside any nested braces or parentheses. */
function topLevelMembers(block: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of block) {
    if (char === '{' || char === '(') depth += 1;
    else if (char === '}' || char === ')') depth -= 1;
    if (char === ';' && depth === 0) { members.push(current); current = ''; continue; }
    current += char;
  }
  members.push(current);
  return members.map(member => member.trim()).filter(Boolean);
}

/** `{ namespace: [method, ...] }` as declared in api/public-api-v1.d.ts. */
function declaredSurface(): Record<string, string[]> {
  const source = readFileSync(DECLARATION_PATH, 'utf8');
  const interfaceStart = source.indexOf('export interface AgentThreadsApiV1 {');
  expect(interfaceStart).toBeGreaterThan(-1);
  const body = balanced(source, source.indexOf('{', interfaceStart));
  const surface: Record<string, string[]> = {};
  for (const member of topLevelMembers(body)) {
    const match = /^readonly\s+(\w+)\s*:\s*\{/.exec(member);
    if (!match) continue;
    surface[match[1]] = topLevelMembers(balanced(member, member.indexOf('{')))
      .map(entry => /^(\w+)\s*[(<]/.exec(entry)?.[1])
      .filter((name): name is string => !!name)
      .sort();
  }
  return surface;
}

/** `{ namespace: [method, ...] }` as actually exposed at runtime. */
function runtimeSurface(): Record<string, string[]> {
  const api = createClaudeThreadsApiV1({
    getThreads: () => [], getThread: () => undefined, isRunning: () => false,
    createThread: () => ({ id: 't' }), sendMessage: async () => {}, openThread: async () => {},
    beginProvisionalThread: async () => ({ thread: { id: 't' }, commit: async () => {}, rollback: async () => {} }),
    subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
    triggerHostEvent: () => {},
    getTraceMetadata: async () => null, readTraceChunk: async () => null,
    runConstrainedQuery: async () => ({ output: '', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }),
    registerMcpServer: async () => ({ success: true, status: 'registered', message: '' }),
    requestSecret: async () => true,
    artifactProviders: new ArtifactProviderRegistry(), artifactStore: artifactStore(), messageContentProviders: new MessageContentProviderRegistry(),
    agentTools: new AgentToolRegistry(), slashCommands: new SlashCommandRegistry(), getDefaultPermissionMode: () => 'default',
  } as never).api;
  const surface: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(api as unknown as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    surface[key] = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => typeof member === 'function')
      .map(([name]) => name)
      .sort();
  }
  return surface;
}

describe('checked-in consumer declaration', () => {
  it('declares exactly the namespaces and methods the runtime exposes', () => {
    expect(declaredSurface()).toEqual(runtimeSurface());
  });

  it('still declares the mcp namespace that once drifted out of it', () => {
    expect(declaredSurface().mcp).toEqual(['register', 'requestSecret']);
    expect(declaredSurface().extensions).toEqual(['registerAgentTool', 'registerArtifactProvider', 'registerMessageContentProvider', 'registerSlashCommand']);
  });

  it('advertises one capability string per public operation', () => {
    const api = createClaudeThreadsApiV1({
      getThreads: () => [], getThread: () => undefined, isRunning: () => false,
      createThread: () => ({ id: 't' }), sendMessage: async () => {}, openThread: async () => {},
      beginProvisionalThread: async () => ({ thread: { id: 't' }, commit: async () => {}, rollback: async () => {} }),
      subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
      triggerHostEvent: () => {},
      getTraceMetadata: async () => null, readTraceChunk: async () => null,
      runConstrainedQuery: vi.fn(),
      registerMcpServer: vi.fn(), requestSecret: vi.fn(),
      archiveThread: vi.fn(), markThreadReviewed: vi.fn(),
      artifactProviders: new ArtifactProviderRegistry(), artifactStore: artifactStore(), messageContentProviders: new MessageContentProviderRegistry(),
      agentTools: new AgentToolRegistry(), slashCommands: new SlashCommandRegistry(), getDefaultPermissionMode: () => 'default',
    } as never).api;
    // agentTools advertises a profile rather than a method name; everything
    // else is `<namespace>.<method>`.
    const expected = Object.entries(runtimeSurface())
      .flatMap(([namespace, methods]) => namespace === 'agentTools' ? ['agentTools.voice-orchestration'] : methods.map(method => `${namespace}.${method}`))
      .sort();
    expect([...api.capabilities].sort()).toEqual(expected);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '../../src/types';

// Stand-ins for the SDK's tool()/createSdkMcpServer(): they keep the definitions so the test can call the
// registered handlers exactly as the in-process MCP server would.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  tool: vi.fn((name: string, description: string, schema: unknown, handler: (args: never) => Promise<unknown>) => ({
    name,
    description,
    schema,
    handler,
  })),
  createSdkMcpServer: vi.fn((opts: { name: string; tools: unknown[] }) => ({ type: 'sdk', name: opts.name, tools: opts.tools })),
}));

import {
  InProcessSummarizer,
  getSummarizerQueryCount,
  resetSummarizerQueryCount,
  EXPLORER_MAX_TURNS,
  EXPLORER_MAX_PENDING,
  EXPLORER_SERVER_NAME,
} from '../../src/InProcessSummarizer';
import { query } from '@anthropic-ai/claude-agent-sdk';

const mockQuery = query as ReturnType<typeof vi.fn>;

function msgs(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: String(i),
    role: i % 2 ? ('assistant' as const) : ('user' as const),
    content: i === 3 ? 'We are building the offline sync feature' : `step ${i}`,
    timestamp: 1000 + i,
  }));
}

const GOOD = JSON.stringify({ title: 'Add offline sync', goal: 'Build offline sync.', status: 'Conflicts next.' });

async function* answer(text: string) {
  yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

const run = (s: InProcessSummarizer, m: ChatMessage[] = msgs(50)) =>
  s.exploreAndSummarize(m, '/usr/bin/claude', 'haiku', '', undefined, 'Old title', 'Old summary', 'Old goal');

describe('InProcessSummarizer.exploreAndSummarize', () => {
  let s: InProcessSummarizer;
  beforeEach(() => {
    s = new InProcessSummarizer();
    mockQuery.mockReset();
    resetSummarizerQueryCount();
  });

  it('keeps the summarizer isolation and exposes exactly the four read-only tools', async () => {
    mockQuery.mockReturnValue(answer(GOOD));
    const result = await run(s);
    expect(result).toEqual({ title: 'Add offline sync', goal: 'Build offline sync.', status: 'Conflicts next.' });

    const { options, prompt } = mockQuery.mock.calls[0][0];
    expect(options.settingSources).toEqual([]);
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.tools).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.maxTurns).toBe(EXPLORER_MAX_TURNS);
    expect(options.model).toBe('haiku');
    expect(Object.keys(options.mcpServers)).toEqual([EXPLORER_SERVER_NAME]);
    expect(options.allowedTools.sort()).toEqual(
      ['outline', 'read_message', 'search', 'get_current_summary'].map((n) => `mcp__${EXPLORER_SERVER_NAME}__${n}`).sort(),
    );
    const tools = options.mcpServers[EXPLORER_SERVER_NAME].tools as { name: string }[];
    expect(tools.map((t) => t.name).sort()).toEqual(['get_current_summary', 'outline', 'read_message', 'search']);
    expect(prompt).toContain('50 messages');
    expect(prompt).toMatch(/untrusted/);
    expect(getSummarizerQueryCount()).toBe(1);
  });

  it('does not put thread content in the prompt (the model must explore for it)', async () => {
    mockQuery.mockReturnValue(answer(GOOD));
    await run(s);
    expect(mockQuery.mock.calls[0][0].prompt).not.toContain('offline sync feature');
  });

  it('registered handlers serve the snapshot, including seeded prior metadata', async () => {
    mockQuery.mockReturnValue(answer(GOOD));
    await run(s);
    const tools = mockQuery.mock.calls[0][0].options.mcpServers[EXPLORER_SERVER_NAME].tools as {
      name: string;
      handler: (a: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
    }[];
    const call = async (name: string, args: Record<string, unknown>) =>
      (await tools.find((t) => t.name === name)!.handler(args)).content[0].text;

    expect(await call('search', { query: 'offline' })).toContain('[3] assistant');
    expect(await call('read_message', { index: 3 })).toContain('offline sync feature');
    expect(await call('read_message', { index: 500 })).toContain('out of range');
    expect(await call('outline', { offset: 0, limit: 2 })).toContain('of 50');
    expect(await call('get_current_summary', {})).toContain('Old goal');
  });

  it.each([
    ['sentinel', 'NO_SUMMARY'],
    ['refusal prose', "I don't have enough context."],
    ['goal-less JSON', JSON.stringify({ title: 'x', status: 's' })],
  ])('returns the empty result for %s', async (_n, text) => {
    mockQuery.mockReturnValue(answer(text));
    expect(await run(s)).toEqual({ title: '', goal: '', status: '' });
  });

  it('uses the last text block, so mid-exploration narration is ignored', async () => {
    mockQuery.mockReturnValue(
      (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Let me look around.' }] } };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: GOOD }] } };
      })(),
    );
    expect((await run(s)).goal).toBe('Build offline sync.');
  });

  it('skips the model entirely for a thread with no summarizable content', async () => {
    const empty: ChatMessage[] = [{ id: 'a', role: 'assistant', content: '', timestamp: 1 }];
    expect(await run(s, empty)).toEqual({ title: '', goal: '', status: '' });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(getSummarizerQueryCount()).toBe(0);
  });

  it('honours the spawnGuard: a refusal spawns nothing and rejects', async () => {
    s.spawnGuard = vi.fn().mockRejectedValue(new Error('policy'));
    await expect(run(s)).rejects.toThrow('policy');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('serializes a burst: never concurrent, and spawns are bounded by the pending cap', async () => {
    let active = 0;
    let maxActive = 0;
    mockQuery.mockImplementation(() =>
      (async function* () {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        yield { type: 'assistant', message: { content: [{ type: 'text', text: GOOD }] } };
      })(),
    );
    const burst = 20;
    const results = await Promise.all(Array.from({ length: burst }, () => run(s)));

    expect(maxActive).toBe(1);
    // One running + EXPLORER_MAX_PENDING waiting; the rest are dropped without a spawn.
    expect(getSummarizerQueryCount()).toBe(EXPLORER_MAX_PENDING + 1);
    expect(results.filter((r) => r.goal).length).toBe(EXPLORER_MAX_PENDING + 1);
    // Once drained, capacity returns.
    await run(s);
    expect(getSummarizerQueryCount()).toBe(EXPLORER_MAX_PENDING + 2);
  });

  it('a failed exploration does not wedge the chain', async () => {
    mockQuery.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(run(s)).rejects.toThrow('boom');
    mockQuery.mockReturnValue(answer(GOOD));
    expect((await run(s)).goal).toBe('Build offline sync.');
  });

  it('backfill is claimed at most once per thread per session', () => {
    expect(s.hasClaimedGoalBackfill('t1')).toBe(false);
    expect(s.claimGoalBackfill('t1')).toBe(true);
    expect(s.claimGoalBackfill('t1')).toBe(false);
    expect(s.hasClaimedGoalBackfill('t1')).toBe(true);
    expect(s.claimGoalBackfill('t2')).toBe(true);
  });
});

describe('cheap path goal context', () => {
  it('passes the stored goal into the incremental and full prompts, with no tools', async () => {
    const s = new InProcessSummarizer();
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => answer('NO_SUMMARY'));
    const m = msgs(6);
    await s.summarize(m, '/c', 'haiku', '', undefined, 'prior', 0, 'Old title', 'Ship offline sync');
    await s.summarize(m, '/c', 'haiku', '', undefined, undefined, undefined, 'Old title', 'Ship offline sync');
    for (const [call] of mockQuery.mock.calls) {
      expect(call.prompt).toContain('Ship offline sync');
      expect(call.options.maxTurns).toBe(1);
      expect(call.options.mcpServers).toEqual({});
      expect(call.options).not.toHaveProperty('allowedTools');
    }
  });
});

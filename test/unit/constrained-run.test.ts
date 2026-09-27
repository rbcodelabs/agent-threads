import { describe, expect, it, vi } from 'vitest';
import { createConstrainedQueryRunner } from '../../src/ConstrainedRun';

const input = { prompt: 'fixture', options: { model: 'haiku', systemInstructions: 'Return a grade.', maxTurns: 1 as const, maxBudgetUsd: 0.1, timeoutMs: 500 }, signal: new AbortController().signal };

describe('constrained query runner', () => {
  it('enforces the closed input-only SDK option set and returns sanitized accounting', async () => {
    const query = vi.fn(async function* (request: any) {
      expect(request.options).toMatchObject({ tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true,
        settingSources: [], skills: [], plugins: [], persistSession: false, permissionMode: 'dontAsk', maxTurns: 1,
        enableFileCheckpointing: false, systemPrompt: 'Return a grade.' });
      expect(request.options.resume).toBeUndefined();
      expect(request.options.continue).toBeUndefined();
      yield { type: 'result', subtype: 'success', is_error: false, result: 'pass', usage: { input_tokens: 3, output_tokens: 1 }, total_cost_usd: 0.02, duration_ms: 10, num_turns: 1 };
    });
    const run = createConstrainedQueryRunner(() => ({ claudeBinaryPath: '/claude', extraEnv: '', provider: 'claude' }), query as any);
    await expect(run(input)).resolves.toEqual({ output: 'pass', usage: { inputTokens: 3, outputTokens: 1, costUsd: 0.02, durationMs: 10, turns: 1 } });
  });

  it('fails closed if the SDK ever emits a tool-use block', async () => {
    const query = async function* () { yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: '/secret' } }] } }; };
    const run = createConstrainedQueryRunner(() => ({ claudeBinaryPath: '/claude', extraEnv: '', provider: 'claude' }), query as any);
    await expect(run(input)).rejects.toThrow('Constraint violation');
  });

  const authFailure = [
    { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }] } },
    { type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed', usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0, duration_ms: 1, num_turns: 1 },
  ];
  const success = { type: 'result', subtype: 'success', is_error: false, result: 'pass', usage: { input_tokens: 3, output_tokens: 1 }, total_cost_usd: 0.02, duration_ms: 10, num_turns: 1 };

  it('retries once on a fresh CLI process after an expired sign-in', async () => {
    let calls = 0;
    const query = vi.fn(async function* () {
      calls++;
      if (calls === 1) { yield* authFailure; return; }
      yield success;
    });
    const run = createConstrainedQueryRunner(() => ({ claudeBinaryPath: '/claude', extraEnv: '', provider: 'claude' }), query as any);
    await expect(run(input)).resolves.toMatchObject({ output: 'pass' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('fails with a clear sign-in message when the retry also fails to authenticate — no further retries', async () => {
    const query = vi.fn(async function* () { yield* authFailure; });
    const run = createConstrainedQueryRunner(() => ({ claudeBinaryPath: '/claude', extraEnv: '', provider: 'claude' }), query as any);
    await expect(run(input)).rejects.toThrow('Claude sign-in expired — run `claude auth login`');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('retries once when the SDK throws an auth error', async () => {
    let calls = 0;
    const query = vi.fn(async function* () {
      calls++;
      if (calls === 1) throw new Error('Failed to authenticate. API Error: 401');
      yield success;
    });
    const run = createConstrainedQueryRunner(() => ({ claudeBinaryPath: '/claude', extraEnv: '', provider: 'claude' }), query as any);
    await expect(run(input)).resolves.toMatchObject({ output: 'pass' });
  });

  it('does not retry unrelated failures', async () => {
    const query = vi.fn(async function* () { yield { ...success, is_error: true, result: 'Prompt is too long' }; });
    const run = createConstrainedQueryRunner(() => ({ claudeBinaryPath: '/claude', extraEnv: '', provider: 'claude' }), query as any);
    await expect(run(input)).rejects.toThrow('Constrained run failed.');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation to the SDK AbortController', async () => {
    let sdkSignal: AbortSignal | undefined;
    const query = async function* (request: any) { sdkSignal = request.options.abortController.signal; await new Promise<void>((resolve) => sdkSignal!.addEventListener('abort', () => resolve(), { once: true })); throw new Error('aborted'); };
    const controller = new AbortController();
    const run = createConstrainedQueryRunner(() => ({ claudeBinaryPath: '/claude', extraEnv: '', provider: 'claude' }), query as any);
    const pending = run({ ...input, signal: controller.signal });
    await vi.waitFor(() => expect(sdkSignal).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(sdkSignal?.aborted).toBe(true);
  });
});

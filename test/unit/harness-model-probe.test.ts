import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { probeHarnessModels } from '../../src/harnessModelProbe';
import { DEFAULT_SETTINGS } from '../../src/types';

describe('probeHarnessModels', () => {
  it('probes Claude models with persistSession:false and closes query in finally', async () => {
    const close = vi.fn();
    const claudeQuery = vi.fn().mockImplementation(({ options }) => {
      expect(options.persistSession).toBe(false);
      return {
        supportedModels: async () => [
          { value: 'claude-opus-5-5', displayName: 'Opus', description: '' },
          { value: 'claude-sonnet-5-5', displayName: 'Sonnet', description: '' },
        ],
        close,
      };
    });

    const models = await probeHarnessModels('claude', DEFAULT_SETTINGS, '/tmp', { claudeQuery: claudeQuery as any });
    expect(models).toEqual([
      { value: 'claude-opus-5-5', displayName: 'Opus' },
      { value: 'claude-sonnet-5-5', displayName: 'Sonnet' },
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('probes Codex models via app-server model/list without thread/start and kills child', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const kill = vi.fn();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill });
    const seenMethods: string[] = [];

    stdin.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const msg = JSON.parse(line);
        seenMethods.push(msg.method);
        if (msg.method === 'initialize') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'codex-test' } })}\n`);
        } else if (msg.method === 'model/list') {
          stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { data: [{ id: 'gpt-5.6-codex', displayName: 'GPT-5.6 Codex' }] },
          })}\n`);
        }
      }
    });

    const models = await probeHarnessModels('codex', DEFAULT_SETTINGS, '/tmp', {
      codexSpawn: () => child as any,
    });
    expect(models).toEqual([{ value: 'gpt-5.6-codex', displayName: 'GPT-5.6 Codex' }]);
    expect(seenMethods).toEqual(['initialize', 'initialized', 'model/list']);
    expect(kill).toHaveBeenCalled();
  });

  it('probes OpenCode v2 models without creating a session and closes transport', async () => {
    const close = vi.fn();
    const requestedPaths: string[] = [];
    const models = await probeHarnessModels('opencode', DEFAULT_SETTINGS, '/tmp', {
      openCodeLauncher: async () => ({
        generation: 'v2',
        request: async (_method, path) => {
          requestedPaths.push(path);
          if (path === '/api/model') {
            return {
              status: 200,
              body: {
                data: [
                  { providerID: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', enabled: true },
                  { providerID: 'openai', id: 'disabled-model', name: 'Disabled', enabled: false },
                ],
              },
            };
          }
          return { status: 200, body: { data: [{ id: 'anthropic', name: 'Anthropic' }] } };
        },
        subscribe: () => {},
        close,
      }),
    });

    expect(models).toEqual([
      { value: 'anthropic/claude-sonnet-4-5', displayName: 'Anthropic: Claude Sonnet 4.5' },
    ]);
    expect(requestedPaths).not.toContain('/api/session');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('probes Antigravity models over ACP session/new and kills channel on completion', async () => {
    let onDataHandler: ((chunk: string) => void) | undefined;
    const kill = vi.fn();
    const models = await probeHarnessModels('antigravity', DEFAULT_SETTINGS, '/tmp', {
      antigravityLauncher: () => ({
        write: (line: string) => {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            onDataHandler?.(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })}\n`);
          } else if (msg.method === 'session/new') {
            onDataHandler?.(`${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                sessionId: 's-probe',
                models: {
                  availableModels: [
                    { modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
                    { modelId: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' },
                  ],
                },
              },
            })}\n`);
          }
        },
        onData: (h) => { onDataHandler = h; },
        onStderr: () => {},
        onExit: () => {},
        kill,
      }),
    });

    expect(models).toEqual([
      { value: 'gemini-4-carbon-medium', displayName: 'Gemini 4 Carbon (Medium)' },
      { value: 'gemini-4-carbon-high', displayName: 'Gemini 4 Carbon (High)' },
    ]);
    expect(kill).toHaveBeenCalled();
  });
});

import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { CodexSession } from '../../src/CodexSession';
import { DEFAULT_SETTINGS } from '../../src/types';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: { write: vi.fn() }, kill: vi.fn(),
  })),
}));

describe('Codex computer-use session policy', () => {
  it('defaults to disabled for existing settings without an explicit choice', () => {
    expect(DEFAULT_SETTINGS.codexComputerUseEnabled).toBe(false);
  });

  it.each([undefined, false, true])('applies choice %s to start and resume while preserving mirrored MCP servers', async (computerUseEnabled) => {
    for (const resume of [undefined, 'saved-thread']) {
      const session = new CodexSession('codex');
      const request = vi.spyOn(session as any, 'request').mockImplementation(async () => ({
        thread: { id: 'thread' }, data: [],
      }));
      await session.start({
        cwd: '/workspace', permissionMode: 'bypassPermissions', extraEnvRaw: '', resume,
        callbacks: {} as any,
        codex: {
          approvalPolicy: 'never', sandbox: 'workspace-write', computerUseEnabled,
          mcpServers: {
            example: { type: 'stdio', command: 'example-mcp' },
            node_repl: { type: 'stdio', command: 'legacy-repl' },
          },
        },
      });
      const method = resume ? 'thread/resume' : 'thread/start';
      const config = (request.mock.calls.find(([name]) => name === method)![1] as any).config;
      expect(config.mcp_servers.example).toEqual({ command: 'example-mcp' });
      if (computerUseEnabled) {
        expect(config).not.toHaveProperty('computer_use');
        expect(config).not.toHaveProperty('plugins');
        expect(config.mcp_servers.node_repl).toEqual({ command: 'legacy-repl' });
      } else {
        expect(config.computer_use.default_app_access).toBe('deny');
        expect(config.plugins['unified-computer-use@openai-bundled'].enabled).toBe(false);
        expect(config.plugins['computer-use@openai-bundled'].enabled).toBe(false);
        expect(config.mcp_servers.node_repl.enabled).toBe(false);
        expect(config.mcp_servers.cua_repl.enabled).toBe(false);
        expect(config.mcp_servers['computer-use'].enabled).toBe(false);
      }
      session.close();
    }
  });
});

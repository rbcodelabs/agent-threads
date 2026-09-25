/**
 * A one-shot "Allow" must not become a permanent permission rule.
 *
 * Live QA: clicking "Allow" once wrote CronList, CronCreate and even
 * already-trusted threads_get_current / vault_search into
 * `<vault>/.claude/settings.local.json`. Cause: canUseTool returned
 * `updatedPermissions: opts.suggestions` on every allow. The CLI persists
 * those suggestions (destination `localSettings` → `.claude/settings.local.json`)
 * — so the plugin was asking it to save a rule every time.
 *
 * The plugin never returns updatedPermissions now. "Always Allow" is persisted
 * by the plugin itself (`settings.alwaysAllowedTools`, visible and removable in
 * Settings), which auto-approves future requests without a prompt.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionCallbacks } from '../../src/ClaudeSession';

type CanUseTool = (name: string, input: unknown, opts: Record<string, unknown>) => Promise<Record<string, unknown>>;

const sdk = vi.hoisted(() => ({ canUseTool: null as CanUseTool | null, release: null as null | (() => void) }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: { options: { canUseTool?: unknown } }) => {
    sdk.canUseTool = opts.options.canUseTool as CanUseTool;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    sdk.release = release;
    async function* gen() {
      await gate;
      yield { type: 'result', subtype: 'success', session_id: 's', total_cost_usd: 0, num_turns: 1 };
    }
    const it = gen();
    return {
      [Symbol.asyncIterator]: () => it,
      close: () => {}, interrupt: async () => {}, supportedModels: async () => [], supportedAgents: async () => [],
      getContextUsage: async () => null, setPermissionMode: vi.fn(async () => {}), setModel: async () => {},
    };
  },
}));

const { ThreadSession } = await import('../../src/ThreadSession');
const { ClaudeSession } = await import('../../src/ClaudeSession');

/** What the CLI sends with a permission request: a suggested rule to save to .claude/settings.local.json. */
const SUGGESTIONS = [{
  type: 'addRules',
  rules: [{ toolName: 'mcp__claude_threads__CronList' }],
  behavior: 'allow',
  destination: 'localSettings',
}];

function callbacks(allow: boolean): SessionCallbacks {
  return {
    onToken: () => {}, onToolUse: () => {}, onMessage: () => {}, onRecap: () => {}, onDone: () => {},
    onInterrupted: () => {}, onError: () => {},
    onPermissionRequest: async () => allow,
    onAskUserQuestion: async () => ({}),
    onOpenNewTab: async () => ({ threadId: '', title: '' }),
  };
}

let vault: string;
let settingsLocal: string;
const ORIGINAL = JSON.stringify({ permissions: { allow: ['Read'] } }, null, 2);

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'allow-once-'));
  fs.mkdirSync(path.join(vault, '.claude'));
  settingsLocal = path.join(vault, '.claude', 'settings.local.json');
  fs.writeFileSync(settingsLocal, ORIGINAL);
  sdk.canUseTool = null;
});

afterEach(() => {
  sdk.release?.();
  fs.rmSync(vault, { recursive: true, force: true });
});

async function canUseToolFromThreadSession(allow: boolean) {
  const session = new ThreadSession('/fake/claude');
  await session.start({ claudePath: '/fake/claude', cwd: vault, permissionMode: 'default', extraEnvRaw: '', callbacks: callbacks(allow) });
  return { canUseTool: sdk.canUseTool!, close: () => session.close() };
}

async function canUseToolFromClaudeSession(allow: boolean) {
  const session = new ClaudeSession('/fake/claude');
  const running = session.run('hi', undefined, vault, 'default', '', callbacks(allow));
  for (let i = 0; i < 20 && !sdk.canUseTool; i++) await new Promise((r) => setTimeout(r, 0));
  return { canUseTool: sdk.canUseTool!, close: async () => { sdk.release?.(); await running.catch(() => {}); } };
}

for (const [label, open] of [
  ['ThreadSession', canUseToolFromThreadSession],
  ['ClaudeSession', canUseToolFromClaudeSession],
] as const) {
  describe(`${label} canUseTool`, () => {
    it('one-shot Allow returns allow without updatedPermissions, and settings.local.json is untouched', async () => {
      const { canUseTool, close } = await open(true);
      const result = await canUseTool('mcp__claude_threads__CronList', { a: 1 }, { suggestions: SUGGESTIONS, signal: new AbortController().signal });
      expect(result.behavior).toBe('allow');
      expect(result.updatedInput).toEqual({ a: 1 });
      expect(result).not.toHaveProperty('updatedPermissions');
      expect(fs.readFileSync(settingsLocal, 'utf8')).toBe(ORIGINAL);
      await close();
    });

    it('an allow with no suggestions is unchanged', async () => {
      const { canUseTool, close } = await open(true);
      const result = await canUseTool('mcp__claude_threads__threads_get_current', {}, { signal: new AbortController().signal });
      expect(result).toMatchObject({ behavior: 'allow' });
      expect(result).not.toHaveProperty('updatedPermissions');
      await close();
    });

    it('deny is unchanged', async () => {
      const { canUseTool, close } = await open(false);
      const result = await canUseTool('mcp__claude_threads__CronCreate', {}, { suggestions: SUGGESTIONS, signal: new AbortController().signal });
      expect(result).toEqual({ behavior: 'deny', message: 'Denied by user' });
      expect(fs.readFileSync(settingsLocal, 'utf8')).toBe(ORIGINAL);
      await close();
    });
  });
}

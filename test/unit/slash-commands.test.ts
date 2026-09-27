import { describe, it, expect } from 'vitest';
import {
  DISPATCH_BUILTIN_COMMANDS,
  DISPATCH_ARG_COMPLETIONS,
  THREAD_BUILTIN_COMMANDS,
  resolveCreatePrMessage,
  escalationCommand,
} from '../../src/slashCommands';
import { DEFAULT_SETTINGS } from '../../src/types';

describe('DISPATCH_BUILTIN_COMMANDS', () => {
  it('advertises exactly the commands the dispatch flow intercepts', () => {
    expect(DISPATCH_BUILTIN_COMMANDS.map((c) => c.name)).toEqual(['model', 'goal', 'loop']);
  });

  it('never advertises session-scoped commands (/compact, /clear, /cost)', () => {
    const names = new Set(DISPATCH_BUILTIN_COMMANDS.map((c) => c.name));
    for (const sessionOnly of ['compact', 'clear', 'cost']) {
      expect(names.has(sessionOnly)).toBe(false);
    }
  });

  it('stays a subset of the thread command list (single source of truth)', () => {
    const threadNames = new Set(THREAD_BUILTIN_COMMANDS.map((c) => c.name));
    for (const c of DISPATCH_BUILTIN_COMMANDS) {
      expect(threadNames.has(c.name)).toBe(true);
    }
  });

  it('only offers arg completions for commands with fixed argument sets', () => {
    // /model has a fixed alias list; /goal and /loop take free text at
    // dispatch (clear/stop are thread-only and must not be suggested).
    expect(Object.keys(DISPATCH_ARG_COMPLETIONS)).toEqual(['model']);
    expect(DISPATCH_ARG_COMPLETIONS.model.length).toBeGreaterThan(0);
  });
});

describe('THREAD_BUILTIN_COMMANDS', () => {
  it('advertises /usage while preserving the existing /cost command', () => {
    const names = THREAD_BUILTIN_COMMANDS.map((c) => c.name);
    expect(names).toContain('usage');
    expect(names).toContain('cost');
  });
});

describe('resolveCreatePrMessage', () => {
  it('uses independent defaults for regular and draft pull requests', () => {
    expect(resolveCreatePrMessage(DEFAULT_SETTINGS, false)).toBe('/create-pr');
    expect(resolveCreatePrMessage(DEFAULT_SETTINGS, true)).toBe('/create-pr --draft');
  });

  it('uses the independently configured message for each action', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      createPrMessage: 'Please open the finished PR',
      createDraftPrMessage: 'Please open a draft for review',
    };

    expect(resolveCreatePrMessage(settings, false)).toBe('Please open the finished PR');
    expect(resolveCreatePrMessage(settings, true)).toBe('Please open a draft for review');
  });

  it('trims outer whitespace while preserving internal newlines', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      createPrMessage: '  First line\n\nSecond line  ',
    };

    expect(resolveCreatePrMessage(settings, false)).toBe('First line\n\nSecond line');
  });

  it('falls back independently when a configured message is blank', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      createPrMessage: '  \n ',
      createDraftPrMessage: 'Custom draft message',
    };

    expect(resolveCreatePrMessage(settings, false)).toBe('/create-pr');
    expect(resolveCreatePrMessage(settings, true)).toBe('Custom draft message');
  });
});

describe('escalationCommand', () => {
  const base = { escalationEnabled: true, escalationKeyword: '/escalate', escalationModel: 'opus' };

  it('returns null when escalation is disabled', () => {
    expect(escalationCommand({ ...base, escalationEnabled: false })).toBeNull();
  });

  it('returns null for an empty keyword', () => {
    expect(escalationCommand({ ...base, escalationKeyword: '' })).toBeNull();
    expect(escalationCommand({ ...base, escalationKeyword: '   ' })).toBeNull();
  });

  it('returns null for a non-slash keyword', () => {
    expect(escalationCommand({ ...base, escalationKeyword: 'escalate' })).toBeNull();
  });

  it('returns null for a bare slash with nothing after it', () => {
    expect(escalationCommand({ ...base, escalationKeyword: '/' })).toBeNull();
  });

  it('returns the command with default keyword and model', () => {
    const cmd = escalationCommand(base);
    expect(cmd).toEqual({
      name: 'escalate',
      description: 'Escalate this turn to opus: /escalate <prompt>',
    });
  });

  it('reflects a renamed keyword and model', () => {
    const cmd = escalationCommand({ escalationEnabled: true, escalationKeyword: '/opus', escalationModel: 'fable' });
    expect(cmd).toEqual({
      name: 'opus',
      description: 'Escalate this turn to fable: /opus <prompt>',
    });
  });

  it('falls back to opus when no model is configured', () => {
    const cmd = escalationCommand({ escalationEnabled: true, escalationKeyword: '/escalate', escalationModel: '' });
    expect(cmd?.description).toContain('opus');
  });

  it('uses dispatch-specific wording when dispatch=true', () => {
    const cmd = escalationCommand(base, true);
    expect(cmd).toEqual({
      name: 'escalate',
      description: 'Dispatch on the escalation model (opus): /escalate <prompt>',
    });
  });
});

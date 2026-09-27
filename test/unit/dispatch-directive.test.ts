import { describe, it, expect } from 'vitest';
import { parseDispatchDirective, goalKickoffMessage } from '../../src/slashCommands';
import { SlashCommandRegistry } from '../../src/SlashCommandContributions';
import { createDesignSlashCommand } from '../harness/design-plugin/designSlashCommand';

async function designDirective(text: string) {
  const registry = new SlashCommandRegistry();
  let brief: string | undefined;
  registry.register({ pluginId: 'design' }, createDesignSlashCommand({
    getState: () => null, isDesktopFilesystem: () => true,
    prepare: async () => ({ artifact: { title: '' }, instructions: '' }), send: async () => {},
    dispatch: async value => { brief = value; return 'thread'; },
  }));
  const result = await registry.invoke({ surface: 'dispatch', text, hasImages: false, hasAttachment: false });
  return result ? { kind: 'design', brief: brief ?? '', ...(result.status === 'error' ? { error: result.message } : {}) } : null;
}

describe('parseDispatchDirective', () => {
  it('returns null for plain prompts', () => {
    expect(parseDispatchDirective('fix the login bug')).toBeNull();
  });

  it('returns null for unhandled slash commands', () => {
    expect(parseDispatchDirective('/compact')).toBeNull();
    expect(parseDispatchDirective('/cost')).toBeNull();
  });

  // ── /model ────────────────────────────────────────────────────────────────

  it('delegates /model to the model prefix parser', () => {
    expect(parseDispatchDirective('/model opus fix the bug')).toEqual({
      kind: 'model',
      model: 'opus',
      rest: 'fix the bug',
      error: undefined,
    });
  });

  it('surfaces /model errors', () => {
    expect(parseDispatchDirective('/model gpt5 do it')?.error).toContain('Unknown model');
  });

  // ── /goal ────────────────────────────────────────────────────────────────

  it('parses /goal with text', () => {
    expect(parseDispatchDirective('/goal ship the v1 login flow')).toEqual({
      kind: 'goal',
      goal: 'ship the v1 login flow',
    });
  });

  it('preserves multi-line goal text', () => {
    const d = parseDispatchDirective('/goal ship v1\nwith tests');
    expect(d).toEqual({ kind: 'goal', goal: 'ship v1\nwith tests' });
  });

  it('errors on bare /goal', () => {
    const d = parseDispatchDirective('/goal');
    expect(d?.kind).toBe('goal');
    expect(d?.error).toContain('Include a goal');
  });

  it('errors on /goal clear|off|done (thread-only variants)', () => {
    for (const arg of ['clear', 'off', 'done']) {
      const d = parseDispatchDirective(`/goal ${arg}`);
      expect(d?.kind).toBe('goal');
      expect(d?.error).toContain('inside a thread');
    }
  });

  it('does not treat /goals as a goal command', () => {
    expect(parseDispatchDirective('/goals for the week')).toBeNull();
  });

  // ── /loop ────────────────────────────────────────────────────────────────

  it('parses /loop with interval and prompt', () => {
    expect(parseDispatchDirective('/loop 10m check CI status')).toEqual({
      kind: 'loop',
      intervalSeconds: 600,
      prompt: 'check CI status',
    });
  });

  it('treats a bare number interval as minutes', () => {
    expect(parseDispatchDirective('/loop 5 check the build')).toEqual({
      kind: 'loop',
      intervalSeconds: 300,
      prompt: 'check the build',
    });
  });

  it('clamps tiny intervals to the minimum', () => {
    const d = parseDispatchDirective('/loop 1s poll the queue');
    expect(d?.kind).toBe('loop');
    expect((d as { intervalSeconds: number }).intervalSeconds).toBeGreaterThanOrEqual(30);
  });

  it('errors on bare /loop or missing prompt', () => {
    expect(parseDispatchDirective('/loop')?.error).toContain('Usage: /loop');
    expect(parseDispatchDirective('/loop 10m')?.error).toContain('Usage: /loop');
  });

  it('errors on /loop stop|off|cancel|clear (thread-only variants)', () => {
    for (const arg of ['stop', 'off', 'cancel', 'clear']) {
      const d = parseDispatchDirective(`/loop ${arg}`);
      expect(d?.kind).toBe('loop');
      expect(d?.error).toContain('inside a thread');
    }
  });

  it('does not treat /loops as a loop command', () => {
    expect(parseDispatchDirective('/loops everywhere')).toBeNull();
  });

  // ── /design ────────────────────────────────────────────────

  it('routes /design with a brief through its contribution, not the core parser', async () => {
    expect(parseDispatchDirective('/design create a responsive settings card')).toBeNull();
    expect(await designDirective('/design create a responsive settings card')).toEqual({
      kind: 'design',
      brief: 'create a responsive settings card',
    });
  });

  it('preserves multi-line design briefs and matches case-insensitively', async () => {
    expect(await designDirective('/DESIGN settings card\nwith mobile navigation')).toEqual({
      kind: 'design',
      brief: 'settings card\nwith mobile navigation',
    });
  });

  it('errors on bare /design because a new thread has no artifact to reopen', async () => {
    const directive = await designDirective('/design');
    expect(directive?.kind).toBe('design');
    expect(directive?.error).toContain('Include a brief');
  });

  it('does not treat /designer as a design command', async () => {
    expect(await designDirective('/designer create a settings card')).toBeNull();
    expect(parseDispatchDirective('/designer create a settings card')).toBeNull();
  });
});

describe('parseDispatchDirective — escalation keyword', () => {
  it('returns an error directive for a bare keyword with no prompt', () => {
    const d = parseDispatchDirective('/escalate', '/escalate');
    expect(d?.kind).toBe('escalate');
    expect(d?.error).toContain('Include a prompt');
  });

  it('is case-insensitive for the bare-keyword check', () => {
    const d = parseDispatchDirective('/ESCALATE', '/escalate');
    expect(d?.kind).toBe('escalate');
  });

  it('ignores surrounding whitespace on a bare keyword', () => {
    const d = parseDispatchDirective('  /escalate  ', '/escalate');
    expect(d?.kind).toBe('escalate');
  });

  it('returns null for keyword + prompt (handled by the existing keyword path)', () => {
    expect(parseDispatchDirective('/escalate fix the failing build', '/escalate')).toBeNull();
  });

  it('returns null when no keyword is passed (escalation disabled)', () => {
    expect(parseDispatchDirective('/escalate')).toBeNull();
  });

  it('respects a renamed keyword', () => {
    const d = parseDispatchDirective('/opus', '/opus');
    expect(d?.kind).toBe('escalate');
    expect(parseDispatchDirective('/escalate', '/opus')).toBeNull();
  });
});

describe('goalKickoffMessage', () => {
  it('embeds the goal text', () => {
    const msg = goalKickoffMessage('ship v1');
    expect(msg).toContain('"ship v1"');
    expect(msg).toContain('Work toward the goal');
  });
});

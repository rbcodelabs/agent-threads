import { describe, expect, it } from 'vitest';
import {
  describeComposerSettings,
  filterProjects,
  modelTier,
  sortProjects,
} from '../../src/composerSettings';

describe('modelTier', () => {
  it.each([
    ['haiku', 'haiku'],
    ['claude-haiku-4-5', 'haiku'],
    ['sonnet', 'sonnet'],
    ['sonnet[1m]', 'sonnet'],
    ['us.anthropic.claude-sonnet-4-6', 'sonnet'],
    ['opus', 'opus'],
    ['claude-opus-4-8', 'opus'],
    ['fable', 'fable'],
    ['gpt-5', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
  ])('%s -> %s', (model, tier) => {
    expect(modelTier(model)).toBe(tier);
  });
});

describe('describeComposerSettings', () => {
  const base = { harness: undefined, model: undefined, activeModel: undefined, vmMode: undefined, settingsVmMode: undefined } as const;

  it('maps the tier to notch count and tint', () => {
    expect(describeComposerSettings({ ...base, model: 'haiku' }).model).toMatchObject({ glyph: 'chip-1', tier: 'haiku', label: 'Haiku' });
    expect(describeComposerSettings({ ...base, model: 'sonnet' }).model).toMatchObject({ glyph: 'chip-2', tier: 'sonnet' });
    expect(describeComposerSettings({ ...base, model: 'opus' }).model).toMatchObject({ glyph: 'chip-3', tier: 'opus' });
    expect(describeComposerSettings({ ...base, model: 'fable' }).model).toMatchObject({ glyph: 'sparkle', tier: 'fable' });
  });

  it('falls back to a plain chip for unknown or default models', () => {
    expect(describeComposerSettings(base).model).toMatchObject({ glyph: 'chip', tier: 'unknown', label: 'Default' });
    expect(describeComposerSettings({ ...base, harness: 'codex', model: 'gpt-5' }).model).toMatchObject({ glyph: 'chip', label: 'gpt-5' });
  });

  it('prefers the model the provider actually ran over the selected alias', () => {
    const d = describeComposerSettings({ ...base, model: 'sonnet', activeModel: 'claude-opus-4-8' });
    expect(d.model.tier).toBe('opus');
    expect(d.model.label).toBe('Opus');
  });

  it('treats a missing harness as Claude and maps the provider glyph', () => {
    expect(describeComposerSettings(base).provider).toEqual({ glyph: 'claude', label: 'Claude' });
    expect(describeComposerSettings({ ...base, harness: 'codex' }).provider).toEqual({ glyph: 'codex', label: 'Codex' });
    expect(describeComposerSettings({ ...base, harness: 'opencode' }).provider).toEqual({ glyph: 'opencode', label: 'OpenCode' });
  });

  it('derives host vs container from the thread override, then settings, for Claude only', () => {
    expect(describeComposerSettings({ ...base, vmMode: 'never' }).location.glyph).toBe('laptop');
    expect(describeComposerSettings({ ...base, vmMode: 'always' }).location).toMatchObject({ glyph: 'cube', label: 'container' });
    expect(describeComposerSettings({ ...base, settingsVmMode: 'always' }).location.glyph).toBe('cube');
    expect(describeComposerSettings({ ...base, vmMode: 'always', harness: 'codex' }).location.glyph).toBe('laptop');
  });

  it('shows a cloud for remote threads with a connection marker', () => {
    const connected = describeComposerSettings({ ...base, remote: { daemonName: 'homelab', connection: 'connected' } });
    expect(connected.location).toMatchObject({ glyph: 'cloud', label: 'remote', marker: 'connected' });
    const down = describeComposerSettings({ ...base, remote: { daemonName: 'homelab', connection: 'unreachable' } });
    expect(down.location.marker).toBe('unreachable');
    const pending = describeComposerSettings({ ...base, remote: { daemonName: 'homelab', connection: 'pending' } });
    expect(pending.location.marker).toBeUndefined();
  });

  it('summarises the state for assistive tech', () => {
    expect(describeComposerSettings({ ...base, model: 'opus', vmMode: 'never' }).ariaLabel).toBe('Composer settings: Opus, Claude, host');
    expect(describeComposerSettings({ ...base, remote: { daemonName: 'homelab', connection: 'unreachable' } }).ariaLabel)
      .toBe('Composer settings: Default, Claude, remote on homelab (unreachable)');
    expect(describeComposerSettings({ ...base, remote: { daemonName: 'homelab', connection: 'connected' } }).ariaLabel)
      .toBe('Composer settings: Default, Claude, remote on homelab (connected)');
  });
});

describe('project list helpers', () => {
  const projects = [
    { id: 'a', name: 'Zeta', createdAt: 1 },
    { id: 'b', name: 'alpha', createdAt: 2 },
    { id: 'c', name: 'Mid', createdAt: 3 },
  ];
  const threads = [
    { projectId: 'a', updatedAt: 500 },
    { projectId: 'c', updatedAt: 100 },
    { projectId: 'a', updatedAt: 50 },
    { projectId: undefined, updatedAt: 900 },
  ];

  it('sorts A-Z case-insensitively', () => {
    expect(sortProjects(projects, threads, 'alpha').map(p => p.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by latest thread activity, falling back to creation time', () => {
    expect(sortProjects(projects, threads, 'recent').map(p => p.id)).toEqual(['a', 'c', 'b']);
  });

  it('filters by case-insensitive substring and ignores blank queries', () => {
    expect(filterProjects(projects, 'ET').map(p => p.id)).toEqual(['a']);
    expect(filterProjects(projects, '  ').length).toBe(3);
  });
});

import { describe, it, expect } from 'vitest';
import {
  activeModelLabel,
  aliasLabel,
  buildClaudeModelOptions,
  formatModelId,
  isReportedModelId,
  modelVersionFromId,
  parseClaudeModelId,
} from '../../src/modelOptions';

describe('modelVersionFromId', () => {
  it('parses single- and two-part versions', () => {
    expect(modelVersionFromId('claude-sonnet-5')).toBe('5');
    expect(modelVersionFromId('claude-opus-4-8')).toBe('4.8');
  });

  it('ignores date suffixes and context-window tags', () => {
    expect(modelVersionFromId('claude-haiku-4-5-20251001')).toBe('4.5');
    expect(modelVersionFromId('claude-sonnet-5-20260101')).toBe('5');
    expect(modelVersionFromId('claude-sonnet-5[1m]')).toBe('5');
  });

  it('returns undefined for unparseable ids', () => {
    expect(modelVersionFromId(undefined)).toBeUndefined();
    expect(modelVersionFromId('gpt-5')).toBeUndefined();
  });
});

describe('aliasLabel', () => {
  it('uses the catalog resolvedModel when present', () => {
    const catalog = [{ value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-4-9' }];
    expect(aliasLabel('opus', catalog)).toBe('Opus 4.9 (latest)');
  });

  it('falls back to built-in versions before any session has run', () => {
    expect(aliasLabel('sonnet')).toBe('Sonnet 5 (latest)');
    expect(aliasLabel('haiku')).toBe('Haiku 4.5 (latest)');
  });

  it('leaves unknown values untouched', () => {
    expect(aliasLabel('claude-opus-4-1')).toBe('claude-opus-4-1');
  });
});

describe('buildClaudeModelOptions', () => {
  it('lists Default then each family alias with a version, with no catalog', () => {
    const options = buildClaudeModelOptions();
    expect(options.map((o) => o.value)).toEqual([undefined, 'opus', 'sonnet', 'haiku', 'fable']);
    expect(options.map((o) => o.label)).toEqual([
      'Default',
      'Opus 4.8 (latest)',
      'Sonnet 5 (latest)',
      'Haiku 4.5 (latest)',
      'Fable 5 (latest)',
    ]);
  });

  it('adds pinned catalog models but not aliases, default, or alias targets', () => {
    const catalog = [
      { value: 'default', displayName: 'Default (recommended)' },
      { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-4-8' },
      { value: 'claude-opus-4-8', displayName: 'Claude Opus 4.8' },
      { value: 'claude-opus-4-7', displayName: 'Claude Opus 4.7' },
      { value: 'claude-opus-4-7', displayName: 'Claude Opus 4.7 (dup)' },
      { value: 'sonnet[1m]', displayName: 'Sonnet 5 (1M context)', resolvedModel: 'claude-sonnet-5' },
    ];
    const options = buildClaudeModelOptions(catalog);
    expect(options.slice(5)).toEqual([
      { label: 'Claude Opus 4.7', value: 'claude-opus-4-7' },
      { label: 'Sonnet 5 (1M context)', value: 'sonnet[1m]' },
    ]);
  });
});

describe('parseClaudeModelId', () => {
  it('handles Bedrock and Vertex id forms', () => {
    expect(parseClaudeModelId('us.anthropic.claude-opus-5-5')).toEqual({ family: 'Opus', version: '5.5' });
    expect(parseClaudeModelId('anthropic.claude-sonnet-5-v1:0')).toEqual({ family: 'Sonnet', version: '5' });
    expect(parseClaudeModelId('claude-opus-4-8@20260101')).toEqual({ family: 'Opus', version: '4.8' });
  });

  it('rejects non-Claude ids', () => {
    expect(parseClaudeModelId('gpt-5.5')).toBeUndefined();
    expect(parseClaudeModelId('')).toBeUndefined();
  });
});

describe('formatModelId / activeModelLabel', () => {
  it('names a parseable id and keeps the raw id visible', () => {
    expect(formatModelId('us.anthropic.claude-opus-5-5')).toBe('Opus 5.5');
    expect(activeModelLabel('us.anthropic.claude-opus-5-5')).toBe('Opus 5.5 (us.anthropic.claude-opus-5-5)');
  });

  it('falls back to the raw id when unparseable', () => {
    expect(formatModelId('gpt-5.5')).toBe('gpt-5.5');
    expect(activeModelLabel('gpt-5.5')).toBe('gpt-5.5');
  });
});

describe('isReportedModelId', () => {
  it('accepts real ids and rejects placeholders and empties', () => {
    expect(isReportedModelId('claude-opus-4-8')).toBe(true);
    expect(isReportedModelId('<synthetic>')).toBe(false);
    expect(isReportedModelId('  ')).toBe(false);
    expect(isReportedModelId(undefined)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { parsePermissionDetail, summarizePermissionDetail } from '../../src/permissionDetail';

describe('parsePermissionDetail', () => {
  it('returns empty for empty input', () => {
    expect(parsePermissionDetail('')).toEqual({ summary: '', fields: null });
  });

  it('keeps plain text as-is', () => {
    expect(parsePermissionDetail('Run the build')).toEqual({ summary: 'Run the build', fields: null });
  });

  it('summarizes JSON by its primary key and exposes fields', () => {
    const r = parsePermissionDetail(JSON.stringify({ command: 'npm test', timeout: 5000 }));
    expect(r.summary).toBe('npm test');
    expect(r.fields).toEqual([
      { key: 'command', value: 'npm test' },
      { key: 'timeout', value: '5000' },
    ]);
  });

  it('falls back to key: value summary when no primary key', () => {
    expect(summarizePermissionDetail('{"a":1,"b":"x"}')).toBe('a: 1, b: x');
  });

  it('pretty-prints nested values and truncates long summaries', () => {
    const r = parsePermissionDetail(JSON.stringify({ command: 'x'.repeat(300), opts: { a: 1 } }));
    expect(r.summary.length).toBeLessThanOrEqual(120);
    expect(r.fields?.[1].value).toBe('{\n  "a": 1\n}');
  });

  it('keeps line breaks for multi-line plain text while the summary stays flat', () => {
    const r = parsePermissionDetail('Project: A\nWorking directory: /x\nPrompt: go');
    expect(r.multiline).toBe('Project: A\nWorking directory: /x\nPrompt: go');
    expect(r.summary).toBe('Project: A Working directory: /x Prompt: go');
  });

  it('does not set multiline for single-line text', () => {
    expect(parsePermissionDetail('Run the build').multiline).toBeUndefined();
  });

  it('treats malformed JSON as text', () => {
    expect(parsePermissionDetail('{"command": "ls').fields).toBeNull();
  });
});

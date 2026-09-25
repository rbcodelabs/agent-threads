import { beforeEach, describe, expect, it, vi } from 'vitest';

const addIcon = vi.fn();

vi.mock('obsidian', () => ({ addIcon }));

describe('harness brand icons', () => {
  beforeEach(() => {
    addIcon.mockClear();
    vi.resetModules();
  });

  it('renders both official marks with the surrounding Obsidian theme color', async () => {
    await import('../../src/harnessBrandIcons');

    const registrations = new Map(addIcon.mock.calls.map(([name, svg]) => [name, svg]));
    expect(registrations.get('claude-spark')).toContain('fill="currentColor"');
    expect(registrations.get('openai-blossom')).toContain('fill="currentColor"');
    expect(registrations.get('opencode-mark')).toContain('fill="currentColor"');
    expect(registrations.get('opencode-mark')).not.toContain('#131010');
    // Glyph bounds (256 x 320 of a 512 viewbox) fill Obsidian's 100 x 100 wrapper.
    expect(registrations.get('opencode-mark')).toContain('translate(-30 -30) scale(0.3125)');
    expect(registrations.get('claude-spark')).not.toContain('#D97757');
  });

  it('scales each glyph to Obsidian\'s real 100x100 addIcon viewBox, not an assumed 24x24', async () => {
    // Real Obsidian's addIcon() wraps custom icon content in
    // `<svg viewBox="0 0 100 100">` (Obsidian's `Sg = {viewBox:"0 0 100 100"}`
    // constant), not 24x24. The inline `scale(...)` transform on each glyph's
    // <g> must convert its own source viewBox up to that 100x100 target. This
    // test pins the exact scale factors so a future edit can't silently
    // regress back to a 24x24 assumption (which shrinks the glyph to a speck).
    await import('../../src/harnessBrandIcons');

    const registrations = new Map(addIcon.mock.calls.map(([name, svg]) => [name, svg]));

    const claudeSvg = registrations.get('claude-spark') as string;
    const openaiSvg = registrations.get('openai-blossom') as string;

    const claudeScaleMatch = claudeSvg.match(/scale\(([\d.]+)\)/);
    const openaiScaleMatch = openaiSvg.match(/scale\(([\d.]+)\)/);

    expect(claudeScaleMatch).not.toBeNull();
    expect(openaiScaleMatch).not.toBeNull();

    const claudeScale = Number(claudeScaleMatch![1]);
    const openaiScale = Number(openaiScaleMatch![1]);

    // Pinned literal values.
    expect(claudeScale).toBeCloseTo(1.06382979, 8);
    expect(openaiScale).toBeCloseTo(2.43902439, 8);

    // claude-spark source is 94x94; openai-blossom source is 41x41. Scaled by
    // the factor above, each must land on a 100x100 target -- if this drifts
    // toward ~24 the scale was recomputed against the wrong viewBox again.
    const CLAUDE_SOURCE_SIZE = 94;
    const OPENAI_SOURCE_SIZE = 41;
    const TARGET_SIZE = 100;

    expect(claudeScale * CLAUDE_SOURCE_SIZE).toBeCloseTo(TARGET_SIZE, 4);
    expect(openaiScale * OPENAI_SOURCE_SIZE).toBeCloseTo(TARGET_SIZE, 4);
  });
});

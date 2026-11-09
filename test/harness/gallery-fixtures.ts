import type { ChatMessage, Thread, ToolCallRecord } from '../../src/types';

/**
 * Image-bearing state for the Agent Board Gallery screenshot tests.
 *
 * `applyGalleryFixtures` decorates EXISTING kanban fixture threads (no new
 * threads, so the status / folder / project baselines are untouched) with
 * tool-result images as inline SVG data, which Chromium renders identically
 * everywhere. Opt-in via `?gallery=1` (see kanban-index.ts).
 *
 * Coverage: Browser screenshot, plain Image, 5 images on one thread (filmstrip
 * +N), a Needs-you thread (the awaiting-permission one), a Working thread, a
 * private thread that HAS images (must render as a placeholder), and plenty of
 * threads with none (placeholders).
 */

type Scene = 'web' | 'terminal' | 'chart' | 'diff' | 'table' | 'form';

const PALETTE: Record<Scene, { bg: string; fg: string; accent: string }> = {
  web: { bg: '#f4f1ea', fg: '#2d2a26', accent: '#c4552d' },
  terminal: { bg: '#10151c', fg: '#9be3a8', accent: '#e5c07b' },
  chart: { bg: '#fbfbfd', fg: '#26324a', accent: '#3b6fe0' },
  diff: { bg: '#1c2128', fg: '#d6dce4', accent: '#4caf50' },
  table: { bg: '#ffffff', fg: '#222222', accent: '#7c3aed' },
  form: { bg: '#eef3f8', fg: '#1f2d3d', accent: '#0a8f6a' },
};

function svg(scene: Scene, label: string): string {
  const { bg, fg, accent } = PALETTE[scene];
  const rows = Array.from({ length: 5 }, (_, i) =>
    `<rect x="40" y="${120 + i * 44}" width="${380 - i * 36}" height="14" rx="4" fill="${fg}" opacity="${0.55 - i * 0.07}"/>`).join('');
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">` +
    `<rect width="640" height="400" fill="${bg}"/>` +
    `<rect width="640" height="44" fill="${accent}"/>` +
    `<circle cx="22" cy="22" r="7" fill="${bg}"/><circle cx="46" cy="22" r="7" fill="${bg}" opacity=".7"/>` +
    `<text x="40" y="92" font-family="sans-serif" font-size="28" font-weight="700" fill="${fg}">${label}</text>` +
    rows +
    `<rect x="440" y="110" width="160" height="220" rx="12" fill="${accent}" opacity=".85"/></svg>`;
  return btoa(markup);
}

const png = (scene: Scene, label: string) => ({ mediaType: 'image/svg+xml', data: svg(scene, label) });

const screenshotCall: ToolCallRecord = {
  name: 'mcp__claude_threads__browser_screenshot', summary: 'Screenshot', status: 'success',
};

function withImages(
  thread: Thread,
  images: Array<{ mediaType: string; data: string }>,
  /** `browser`: number of completed browser_screenshot calls; they pair FIFO with the first images. */
  opts: { browser?: number } = {},
): void {
  const base = (thread.messages[thread.messages.length - 1]?.timestamp ?? thread.updatedAt) + 1000;
  const messages: ChatMessage[] = [];
  if (opts.browser) {
    messages.push({
      id: `${thread.id}-shot`, role: 'assistant', content: '', timestamp: base,
      toolCalls: Array.from({ length: opts.browser }, () => screenshotCall),
    });
  }
  messages.push({ id: `${thread.id}-img`, role: 'assistant', content: '', timestamp: base + 1000, toolResultImages: images });
  thread.messages.push(...messages);
}

export function applyGalleryFixtures(threads: Thread[]): void {
  const by = (id: string): Thread => {
    const t = threads.find((x) => x.id === id);
    if (!t) throw new Error(`gallery fixture thread missing: ${id}`);
    return t;
  };
  // Working: two images, first from a browser_screenshot call.
  withImages(by('k-hiptrip-running'), [png('web', 'Itinerary card'), png('chart', 'Provenance chart')], { browser: 2 });
  // Needs you (awaiting permission): three images.
  withImages(by('k-hiptrip-awaiting'), [png('terminal', 'Deploy dry run'), png('diff', 'Signals diff'), png('table', 'Quality table')]);
  // One plain image.
  withImages(by('k-hiptrip-new'), [png('form', 'Nudge mock')]);
  // Five images: filmstrip shows 3 with +3.
  withImages(by('k-hiptrip-done'), [
    png('web', 'Staging 401'), png('terminal', 'Log tail'), png('diff', 'auth.ts'), png('chart', 'Error rate'), png('table', 'Env vars'),
  ], { browser: 1 });
  // Browser screenshot.
  withImages(by('k-threads-new'), [png('web', 'Swimlane board')], { browser: 1 });
  // Private thread that has images: must render as a placeholder, never thumbnails.
  const priv = by('k-acme-tasks');
  withImages(priv, [png('table', 'Secret table')]);
  priv.private = true;
}

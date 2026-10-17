/**
 * Small original SVG glyphs for the composer settings indicator. They are
 * deliberately simple marks, not vendor logos. All strokes use currentColor so
 * the host theme (light, dark, mobile) and the per-tier tint in CSS drive colour.
 */
import type { LocationGlyph, ModelGlyph, ProviderGlyph } from './composerSettings';

const SVG_NS = 'http://www.w3.org/2000/svg';

type Shape = [tag: 'path' | 'circle' | 'rect' | 'line' | 'polyline', attrs: Record<string, string>, filled?: boolean];

const CHIP_BODY: Shape[] = [
  ['rect', { x: '3.5', y: '3.5', width: '9', height: '9', rx: '2' }],
  ['path', { d: 'M6 1.6v1.9M10 1.6v1.9M6 12.5v1.9M10 12.5v1.9M1.6 6h1.9M1.6 10h1.9M12.5 6h1.9M12.5 10h1.9' }],
];
const notch = (cx: number): Shape => ['circle', { cx: String(cx), cy: '8', r: '0.95' }, true];

const GLYPHS: Record<ModelGlyph | ProviderGlyph | LocationGlyph, Shape[]> = {
  chip: CHIP_BODY,
  'chip-1': [...CHIP_BODY, notch(8)],
  'chip-2': [...CHIP_BODY, notch(6.6), notch(9.4)],
  'chip-3': [...CHIP_BODY, notch(5.9), notch(8), notch(10.1)],
  sparkle: [['path', { d: 'M8 1.8l1.35 4.85L14.2 8l-4.85 1.35L8 14.2 6.65 9.35 1.8 8l4.85-1.35z' }]],
  // Burst: eight rays around a centre point.
  claude: [['path', { d: 'M8 1.8v3.2M8 11v3.2M1.8 8H5M11 8h3.2M3.6 3.6l2.2 2.2M10.2 10.2l2.2 2.2M12.4 3.6l-2.2 2.2M5.8 10.2l-2.2 2.2' }]],
  // Hexagon with a prompt.
  codex: [
    ['path', { d: 'M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z' }],
    ['polyline', { points: '5.7,6.7 7.5,8 5.7,9.3' }],
    ['line', { x1: '8.6', y1: '9.5', x2: '10.4', y2: '9.5' }],
  ],
  // Angle brackets.
  opencode: [
    ['polyline', { points: '6,4.5 2.5,8 6,11.5' }],
    ['polyline', { points: '10,4.5 13.5,8 10,11.5' }],
  ],
  laptop: [
    ['rect', { x: '3', y: '3.5', width: '10', height: '7', rx: '1' }],
    ['line', { x1: '1.5', y1: '12.5', x2: '14.5', y2: '12.5' }],
  ],
  cube: [
    ['path', { d: 'M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z' }],
    ['path', { d: 'M2.6 4.9L8 8l5.4-3.1M8 8v6.2' }],
  ],
  cloud: [['path', { d: 'M4.6 12.2h6.6a2.8 2.8 0 0 0 .3-5.58A4 4 0 0 0 3.8 7.4a2.4 2.4 0 0 0 .8 4.8z' }]],
};

/** Builds a 16px SVG element for a glyph id. Decorative: aria-hidden, labelled by its button. */
export function createGlyph(id: ModelGlyph | ProviderGlyph | LocationGlyph): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('ct-glyph', `ct-glyph-${id}`);
  for (const [tag, attrs, filled] of GLYPHS[id]) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (filled) { el.setAttribute('fill', 'currentColor'); el.setAttribute('stroke', 'none'); }
    svg.appendChild(el);
  }
  return svg;
}

/**
 * DOM layer for the chat's browser session card (design: docs/mockups/browser-session-card).
 *
 * Pure presentation: it draws a BrowserSessionViewModel (browserSession.ts) and
 * reports user intent through callbacks. It owns no session state, so the live
 * and the finalized render are literally the same code path and cannot drift.
 *
 * Nothing here ever reads a login page: the "control" viewport shows whatever
 * frame the caller hands it via `setFrame`, and forwards raw pointer/keyboard
 * events back out through `callbacks`. Frames are set on the <img> only, never
 * stored anywhere else.
 */

import { Modal, setIcon, type App } from 'obsidian';
import { HANDOFF_TTL_SECONDS, type BrowserSessionStep, type BrowserSessionViewModel } from './browserSession';

export interface BrowserCardCallbacks {
  /** User expanded (true) or collapsed (false) a finished/ended session. */
  onExpandedChange(key: string, expanded: boolean): void;
  /** User opened or closed the step list (stacked layout). */
  onStepsOpenChange(key: string, open: boolean): void;
  /** Click on a real screenshot: open it larger. */
  openScreenshot(src: string, vm: BrowserSessionViewModel): void;
  takeControl(): void;
  notNow(): void;
  returnControl(): void;
  /** Pointer / keyboard aimed at the login frame while the human is in control. */
  pointer(type: 'mouseDown' | 'mouseUp', event: PointerEvent, rect: DOMRect): void;
  key(event: KeyboardEvent): void;
}

export interface BrowserCardInput {
  vm: BrowserSessionViewModel;
  /** Latest real screenshot for this session, if the resolver found one. */
  screenshotSrc: string | null;
  /** Latest live frame (sign-in page in control mode; the agent's page when `live`). Memory/DOM only. */
  frameSrc: string | null;
  /**
   * This card is the active session and should mirror the agent's page with
   * live frames, settling to its final screenshot when `live` is false.
   */
  live?: boolean;
  /** The user expanded a card that is collapsed by default. */
  expanded: boolean;
  stepsOpen: boolean;
}

export interface BrowserCardHandle {
  el: HTMLElement;
  /** Paint a new frame (sign-in or live view) without rebuilding the card. */
  setFrame(dataUrl: string | null): void;
  /** Update the requested-state countdown in place. */
  setCountdown(remainingSeconds: number): void;
  /** Move keyboard focus to the mode's primary action (Return control / Take control). */
  focusPrimaryAction(): void;
  /** True when the login-frame viewport currently owns keyboard focus. */
  frameHasFocus(): boolean;
  focusFrame(): void;
}

const RING_C = 2 * Math.PI * 12;

const STATE_CLASS: Record<BrowserSessionViewModel['state'], string> = {
  navigating: 'is-navigating',
  live: 'is-live',
  finished: 'is-done',
  error: 'is-error',
  ended: 'is-closed',
};

function icon(parent: HTMLElement, name: string, cls?: string): HTMLElement {
  const span = parent.createSpan({ cls: cls ? `ct-bc-ico ${cls}` : 'ct-bc-ico' });
  span.setAttribute('aria-hidden', 'true');
  setIcon(span, name);
  return span;
}

function skeleton(parent: HTMLElement): HTMLElement {
  const skel = parent.createDiv('ct-bc-skel');
  skel.setAttribute('aria-hidden', 'true');
  skel.createDiv('ct-bc-skel-b ct-bc-skel-w38');
  skel.createDiv('ct-bc-skel-b ct-bc-skel-w78');
  skel.createDiv('ct-bc-skel-b ct-bc-skel-w58');
  const row = skel.createDiv('ct-bc-skel-r');
  row.createDiv('ct-bc-skel-c');
  row.createDiv('ct-bc-skel-c is-hot');
  row.createDiv('ct-bc-skel-c');
  return skel;
}

function ringEl(remaining: number): HTMLElement {
  const ring = document.createElement('span');
  ring.className = 'ct-bc-ring';
  ring.setAttribute('aria-hidden', 'true');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  const track = document.createElementNS(ns, 'circle');
  track.setAttribute('class', 'ct-bc-ring-track');
  for (const [k, v] of [['cx', '16'], ['cy', '16'], ['r', '12']]) track.setAttribute(k, v);
  const val = document.createElementNS(ns, 'circle');
  val.setAttribute('class', 'ct-bc-ring-val');
  for (const [k, v] of [['cx', '16'], ['cy', '16'], ['r', '12']]) val.setAttribute(k, v);
  val.setAttribute('stroke-dasharray', RING_C.toFixed(2));
  svg.append(track, val);
  const label = document.createElement('b');
  ring.append(svg, label);
  paintRing(ring, remaining);
  return ring;
}

function paintRing(ring: HTMLElement, remaining: number): void {
  const val = ring.querySelector('.ct-bc-ring-val');
  const label = ring.querySelector('b');
  val?.setAttribute('stroke-dashoffset', (RING_C * (1 - remaining / HANDOFF_TTL_SECONDS)).toFixed(2));
  if (label) label.textContent = String(remaining);
}

function stepRow(list: HTMLElement, step: BrowserSessionStep): void {
  const li = list.createEl('li', { cls: `ct-bc-step is-${step.outcome}` });
  li.createEl('i').setAttribute('aria-hidden', 'true');
  li.createSpan({ cls: 'ct-bc-step-v', text: step.verb });
  li.createSpan({ cls: 'ct-bc-step-t', text: step.target });
  if (step.duration) li.createSpan({ cls: 'ct-bc-step-d', text: step.duration });
}

export function renderBrowserSessionCard(
  parent: HTMLElement,
  input: BrowserCardInput,
  callbacks: BrowserCardCallbacks,
): BrowserCardHandle {
  const { vm } = input;
  const collapsed = vm.collapsedByDefault && !input.expanded;
  // The stylesheet's mode classes: is-request / is-control / is-returned / is-expired.
  const stateCls = vm.mode ? `is-${vm.mode === 'requested' ? 'request' : vm.mode} has-mode` : STATE_CLASS[vm.state];

  const card = parent.createEl('article', {
    cls: `ct-bc ${stateCls}${collapsed ? ' is-collapsed' : ''}${input.stepsOpen ? ' steps-open' : ''}`,
    attr: {
      'aria-label': `Browser session: ${vm.mode ? vm.banner?.title ?? vm.mode : vm.statusLabel}`,
      'data-session-key': vm.key,
    },
  });

  // ── Collapsed chip ──
  if (vm.collapsedByDefault) {
    const chip = card.createEl('button', {
      cls: 'ct-bc-chip',
      attr: { type: 'button', 'aria-expanded': 'false', 'aria-label': `Expand browser session: ${vm.chip.title}` },
    });
    const thumb = chip.createSpan('ct-bc-thumb');
    if (input.screenshotSrc) thumb.createEl('img', { attr: { src: input.screenshotSrc, alt: '' } });
    const main = chip.createSpan('ct-bc-chip-main');
    main.createSpan({ cls: 'ct-bc-chip-l1', text: vm.chip.title });
    main.createSpan({ cls: 'ct-bc-chip-l2', text: vm.chip.subtitle });
    icon(chip, 'chevron-down', 'ct-bc-chip-chev');
    chip.addEventListener('click', () => {
      card.removeClass('is-collapsed');
      callbacks.onExpandedChange(vm.key, true);
    });
  }

  // ── Mode banner (handoff) ──
  if (vm.banner) {
    const banner = card.createDiv('ct-bc-mode');
    icon(banner, vm.banner.icon, 'ct-bc-mode-ico');
    const text = banner.createSpan('ct-bc-mode-text');
    text.createEl('strong', { text: vm.banner.title });
    const sub = vm.banner.showRing && vm.banner.remainingSeconds !== undefined
      ? `${vm.banner.subtitle} · ${vm.banner.remainingSeconds}s left`
      : vm.banner.subtitle;
    text.createSpan({ cls: 'ct-bc-mode-sub', text: sub });
    if (vm.banner.showRing && vm.banner.remainingSeconds !== undefined) {
      banner.appendChild(ringEl(vm.banner.remainingSeconds));
    }
  }

  // ── Browser chrome ──
  const chrome = card.createEl('header', { cls: 'ct-bc-chrome' });
  const dots = chrome.createSpan('ct-bc-dots');
  dots.setAttribute('aria-hidden', 'true');
  dots.createEl('i');
  dots.createEl('i');
  dots.createEl('i');
  const urlBar = chrome.createSpan({ cls: 'ct-bc-url', attr: { title: vm.url ?? '' } });
  icon(urlBar, 'lock');
  const urlText = urlBar.createSpan('ct-bc-url-text');
  urlText.append(vm.host || 'browser');
  if (vm.path) urlText.createEl('b', { text: vm.path });
  const status = chrome.createSpan('ct-bc-status');
  status.createEl('i').setAttribute('aria-hidden', 'true');
  status.append(vm.statusLabel);

  card.createDiv('ct-bc-progress').setAttribute('aria-hidden', 'true');

  // ── Viewport ──
  const showFrame = vm.viewport === 'frame';
  // A live session (no handoff layered on it) mirrors the agent's real screen:
  // the freshest frame wins over the last step screenshot until the session ends.
  const wantsLive = !!input.live && !showFrame && !vm.mode;
  const viewSrc = showFrame
    ? input.frameSrc
    : wantsLive && input.frameSrc ? input.frameSrc
    : vm.viewport === 'screenshot' ? input.screenshotSrc : null;
  const zoomable = !!viewSrc && !showFrame && !vm.overlay;
  const viewLabel = showFrame
    ? 'Temporary sign-in page. Your clicks and typing are sent here.'
    : zoomable ? 'Open screenshot larger'
    : vm.overlay ? 'Page waiting for sign-in'
    : viewSrc ? 'Latest screenshot'
    : 'No screenshot yet';

  // Control mode needs a keyboard-focusable surface that is NOT a button (a
  // button would swallow Space/Enter); everything else is a native button.
  const view = showFrame
    ? card.createDiv({ cls: 'ct-bc-view is-frame', attr: { tabindex: '0', role: 'group', 'aria-label': viewLabel } })
    : card.createEl('button', { cls: 'ct-bc-view', attr: { type: 'button', 'aria-label': viewLabel } });
  if (!zoomable) view.setAttribute('data-empty', 'true');

  let frameImg: HTMLImageElement | null = null;
  let frameSkeleton: HTMLElement | null = null;
  if (viewSrc) {
    const alt = showFrame ? 'Temporary sign-in page'
      : wantsLive && input.frameSrc ? `Live view of ${vm.host || 'the browser'}`
      : vm.url ? `Latest screenshot of ${vm.host}${vm.path}` : 'Latest screenshot';
    const img = view.createEl('img', { attr: { src: viewSrc, alt } });
    if (showFrame || wantsLive) frameImg = img;
  } else {
    frameSkeleton = skeleton(view);
  }
  if ((showFrame || wantsLive) && !frameImg) {
    // No frame has arrived yet; keep an <img> ready so setFrame can fill it.
    frameImg = view.createEl('img', { cls: 'is-pending', attr: { alt: showFrame ? 'Temporary sign-in page' : `Live view of ${vm.host || 'the browser'}` } });
  }
  if (vm.error) {
    const overlay = view.createDiv({ cls: 'ct-bc-overlay is-scrim', attr: { role: 'alert' } });
    icon(overlay, 'circle-alert');
    overlay.createEl('strong', { text: vm.error.title });
    overlay.createSpan({ text: vm.error.detail });
  }
  if (vm.overlay) {
    const overlay = view.createDiv('ct-bc-overlay is-scrim');
    icon(overlay, vm.overlay.icon);
    overlay.createEl('strong', { text: vm.overlay.title });
    overlay.createSpan({ text: vm.overlay.text });
  }
  if (vm.state === 'finished' && !vm.mode && viewSrc) view.createSpan({ cls: 'ct-bc-tag', text: 'Last capture' });
  if (vm.state === 'ended' && viewSrc) view.createSpan({ cls: 'ct-bc-tag', text: 'Session ended' });
  if (vm.cue) {
    const cue = view.createSpan('ct-bc-cue');
    icon(cue, 'keyboard');
    cue.append(vm.cue);
  }
  if (zoomable) {
    icon(view, 'maximize-2', 'ct-bc-zoom');
    view.addEventListener('click', () => callbacks.openScreenshot(viewSrc!, vm));
  }
  if (showFrame) {
    const forward = (type: 'mouseDown' | 'mouseUp') => (event: Event) =>
      callbacks.pointer(type, event as PointerEvent, (frameImg ?? view).getBoundingClientRect());
    view.addEventListener('pointerdown', forward('mouseDown'));
    view.addEventListener('pointerup', forward('mouseUp'));
    view.addEventListener('keydown', (e) => callbacks.key(e as KeyboardEvent));
    view.addEventListener('keyup', (e) => callbacks.key(e as KeyboardEvent));
  }

  // ── Side column: privacy, caption, actions, steps ──
  const side = card.createDiv('ct-bc-side');
  if (vm.privacy) {
    const privacy = side.createDiv('ct-bc-privacy');
    icon(privacy, 'eye-off');
    privacy.createSpan({ text: vm.privacy });
  }

  const stepsId = `ct-bc-steps-${vm.key.replace(/[^a-z0-9]/gi, '')}`;
  const caption = side.createDiv('ct-bc-caption');
  const grow = caption.createSpan('ct-bc-grow');
  grow.createSpan({ cls: 'ct-bc-verb', text: vm.verb });
  grow.createSpan({ cls: 'ct-bc-target', text: vm.target });
  if (vm.collapsedByDefault) {
    const collapse = caption.createEl('button', { cls: 'ct-bc-toggle ct-bc-collapse', text: 'Collapse', attr: { type: 'button' } });
    collapse.addEventListener('click', () => {
      card.addClass('is-collapsed');
      card.removeClass('steps-open');
      callbacks.onExpandedChange(vm.key, false);
      card.querySelector<HTMLElement>('.ct-bc-chip')?.focus();
    });
  }
  const toggle = caption.createEl('button', {
    cls: 'ct-bc-toggle ct-bc-steps-toggle',
    attr: { type: 'button', 'aria-expanded': String(input.stepsOpen), 'aria-controls': stepsId },
  });
  toggle.append(`${vm.steps.length} step${vm.steps.length === 1 ? '' : 's'}`);
  icon(toggle, 'chevron-down');
  toggle.addEventListener('click', () => {
    const open = card.classList.toggle('steps-open');
    toggle.setAttribute('aria-expanded', String(open));
    callbacks.onStepsOpenChange(vm.key, open);
  });

  let primary: HTMLElement | null = null;
  if (vm.actions === 'request') {
    const actions = side.createDiv('ct-bc-actions');
    primary = actions.createEl('button', { cls: 'ct-bc-btn is-primary', text: 'Take control', attr: { type: 'button' } });
    primary.addEventListener('click', () => callbacks.takeControl());
    actions.createEl('button', { cls: 'ct-bc-btn', text: 'Not now', attr: { type: 'button' } })
      .addEventListener('click', () => callbacks.notNow());
    const agent = actions.createSpan('ct-bc-agent');
    icon(agent, 'pause');
    agent.append('Claude is waiting');
  } else if (vm.actions === 'control') {
    const actions = side.createDiv('ct-bc-actions');
    const agent = actions.createSpan('ct-bc-agent');
    icon(agent, 'pause');
    agent.append('Claude is waiting');
    primary = actions.createEl('button', { cls: 'ct-bc-btn is-primary is-big', text: 'Return control', attr: { type: 'button' } });
    primary.addEventListener('click', () => callbacks.returnControl());
  } else if (vm.hint) {
    const actions = side.createDiv('ct-bc-actions');
    const hint = actions.createSpan('ct-bc-hint');
    hint.append(vm.hint.lead);
    hint.createEl('b', { text: vm.hint.strong });
    hint.append(vm.hint.trail);
  }

  const steps = side.createEl('ol', { cls: 'ct-bc-steps', attr: { id: stepsId, 'aria-label': 'Actions in this session' } });
  for (const step of vm.steps) stepRow(steps, step);

  return {
    el: card,
    setFrame(dataUrl) {
      if (!frameImg || !dataUrl) return;
      frameImg.src = dataUrl;
      frameImg.removeClass('is-pending');
      // The placeholder only stands in until the first real frame.
      frameSkeleton?.remove();
      frameSkeleton = null;
    },
    setCountdown(remaining) {
      const ring = card.querySelector<HTMLElement>('.ct-bc-ring');
      if (ring) paintRing(ring, remaining);
      const sub = card.querySelector('.ct-bc-mode-sub');
      if (sub && vm.banner) sub.textContent = `${vm.banner.subtitle} · ${remaining}s left`;
    },
    focusPrimaryAction() { primary?.focus(); },
    frameHasFocus() { return showFrame && document.activeElement === view; },
    focusFrame() { if (showFrame) view.focus(); },
  };
}

/** Obsidian Modal that shows a screenshot at full size. */
export class BrowserScreenshotModal extends Modal {
  constructor(
    app: App,
    private readonly src: string,
    private readonly vm: BrowserSessionViewModel,
  ) {
    super(app);
  }

  onOpen(): void {
    (this as unknown as { modalEl?: HTMLElement }).modalEl?.addClass('ct-bc-lightbox');
    this.titleEl?.setText?.(`${this.vm.host}${this.vm.path}` || 'Browser screenshot');
    const body = this.contentEl.createDiv('ct-bc-lightbox-body');
    body.createEl('img', { attr: { src: this.src, alt: 'Screenshot of the page the agent is viewing' } });
    body.createDiv({ cls: 'ct-bc-lightbox-cap', text: `${this.vm.verb} ${this.vm.target}` });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

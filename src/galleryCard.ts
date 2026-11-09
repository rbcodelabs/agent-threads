import { setIcon } from 'obsidian';
import type { GalleryImage } from './galleryImages';
import { relativeTime } from './dashboardUtils';

/**
 * One Agent Board Gallery card: hero image (16:10) + source badge + relative
 * time, a capped filmstrip with a "+N" slot, prev/next arrows and an "n / m"
 * live counter. Pure DOM: everything environmental (URL resolution, thumbnail
 * backfill, opening the thread) comes in through {@link GalleryCardHooks}, so the
 * board (KanbanView) stays in charge of actions and live updates.
 *
 * Memory: one hero <img> per card plus one preload, thumbs are 160px sidecars
 * where available. `setVisible(false)` clears every src so off-screen cards hold
 * no decoded bitmaps.
 */

export type GalleryStatusKind = 'working' | 'needs' | 'waiting' | 'new' | 'reviewed' | 'failed' | 'ready';

export interface GalleryCardModel {
  threadId: string;
  title: string;
  statusLabel: string;
  statusKind: GalleryStatusKind;
  projectName?: string;
  /** One-line last message / live activity. */
  message: string;
  /** Longer excerpt shown inside placeholder cards. */
  excerpt: string;
  updatedAt: number;
  images: GalleryImage[];
  featured: boolean;
  /** Needs-you thread that did not fit in the featured area: chip only. */
  needsYouChip: boolean;
  /** Small kicker line for featured cards ("Needs you · asked 4m ago"). */
  kicker?: string;
  /** Max filmstrip slots (3 compact / 4 narrow / 5 featured); the last shows "+N". */
  stripCap: number;
  /** Tag shown inside a placeholder card. */
  placeholderTag: string;
  /** Image key to show first, and whether the user is following the newest image. */
  startKey?: string;
  atNewest?: boolean;
}

export interface GalleryCardHooks {
  /** URL for an image; 'thumb' resolves the sidecar only (null when there is none). */
  resolveUrl(img: GalleryImage, kind: 'full' | 'thumb'): string | null;
  /** Lazy thumbnail backfill; resolves to the new thumbnail's URL or null. */
  requestThumbnail(img: GalleryImage): Promise<string | null>;
  openThread(): void;
  onPosition(key: string, atNewest: boolean): void;
}

const INTERACTIVE = 'button, a, input, textarea, select, pre, [data-draft-key], .ct-gallery-actions, .ct-kanban-inbox';

export class GalleryCard {
  readonly el: HTMLElement;
  /** Host-owned area (inbox form, permission actions) that update() never touches. */
  readonly slotEl: HTMLElement;
  /** The one-line message element (registered as the card's live activity line by the board). */
  messageEl!: HTMLElement;
  model: GalleryCardModel;

  private mediaHost: HTMLElement;
  private stripHost: HTMLElement;
  private titleLink!: HTMLAnchorElement;
  private statusEl!: HTMLElement;
  private chipHost!: HTMLElement;
  private kickerEl!: HTMLElement;

  private heroEl: HTMLImageElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private timeEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private thumbEls: Array<{ btn: HTMLElement; img: HTMLImageElement; image: GalleryImage; usingThumb: boolean }> = [];
  private preloadEl: HTMLImageElement | null = null;
  private requestedBackfill = new Set<string>();

  private idx = 0;
  private visible = false;

  constructor(model: GalleryCardModel, private hooks: GalleryCardHooks) {
    this.model = model;
    this.el = document.createElement('article');
    this.mediaHost = document.createElement('div');
    this.stripHost = document.createElement('div');
    this.el.className = 'ct-gallery-card';
    this.el.dataset.threadId = model.threadId;
    this.buildFrame();
    this.slotEl = this.el.querySelector<HTMLElement>('.ct-gallery-slot')!;
    this.mediaHost.addEventListener('keydown', (e) => {
      if (this.model.images.length < 2) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.show(this.idx - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.show(this.idx + 1); }
    });
    this.el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(INTERACTIVE)) return;
      this.hooks.openThread();
    });
    this.applyModel(model);
  }

  /** Replaces the model and rebuilds media + strip + text in place (the article and slot survive). */
  update(model: GalleryCardModel): void {
    this.model = model;
    this.applyModel(model);
  }

  get currentIndex(): number { return this.idx; }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) {
      this.applyHeroSrc();
      this.applyThumbSrcs();
      this.preloadNext();
      this.backfillThumbs();
    } else {
      this.heroEl?.removeAttribute('src');
      for (const t of this.thumbEls) t.img.removeAttribute('src');
      this.preloadEl = null;
    }
  }

  /** Re-label relative times without rebuilding. */
  refreshTimes(): void {
    this.refreshHeroMeta();
    this.refreshKicker();
  }

  /** Step by `delta` (wraps). Exposed for the board and tests. */
  step(delta: number): void {
    this.show(this.idx + delta);
  }

  // ── construction ─────────────────────────────────────────────────────────

  private buildFrame(): void {
    const el = this.el;
    el.appendChild(this.mediaHost);
    el.appendChild(this.stripHost);
    const body = el.createDiv('ct-gallery-body');
    this.kickerEl = body.createEl('p', { cls: 'ct-gallery-kicker' });
    const h = body.createEl('h3', { cls: 'ct-gallery-title' });
    this.titleLink = h.createEl('a', { cls: 'ct-gallery-title-link', attr: { href: '#' } });
    this.titleLink.addEventListener('click', (e) => { e.preventDefault(); this.hooks.openThread(); });
    const meta = body.createDiv('ct-gallery-meta');
    this.statusEl = meta.createSpan('ct-gallery-status');
    this.chipHost = meta.createSpan('ct-gallery-chips');
    this.messageEl = body.createEl('p', { cls: 'ct-gallery-msg' });
    body.createDiv('ct-gallery-slot');
  }

  private applyModel(m: GalleryCardModel): void {
    const el = this.el;
    // Toggle rather than overwrite className: the board adds its own state classes (active, stale).
    const hasImages = m.images.length > 0;
    el.toggleClass('ct-gallery-featured', m.featured);
    el.toggleClass('is-needs', m.statusKind === 'needs');
    el.toggleClass('ct-gallery-textfirst', !hasImages && m.featured);
    el.toggleClass('is-placeholder', !hasImages && !m.featured);
    el.setAttribute('aria-labelledby', `ct-gallery-title-${m.threadId}`);
    this.titleLink.parentElement!.id = `ct-gallery-title-${m.threadId}`;
    this.titleLink.setText(m.title);

    this.statusEl.className = `ct-gallery-status st-${m.statusKind}`;
    this.statusEl.setText(m.statusLabel);
    this.chipHost.empty();
    if (m.needsYouChip) this.chipHost.createSpan({ cls: 'ct-gallery-chip ct-gallery-chip-needs', text: 'Needs you' });
    if (m.projectName) this.chipHost.createSpan({ cls: 'ct-gallery-chip', text: m.projectName, attr: { title: m.projectName } });
    this.messageEl.setText(m.message);
    this.kickerEl.toggleClass('ct-hidden', !m.kicker);
    this.refreshKicker();

    // Position: keep following the newest image, else keep the same image by key.
    const n = m.images.length;
    if (n === 0) this.idx = 0;
    else if (m.atNewest !== false || !m.startKey) this.idx = 0;
    else {
      const found = m.startKey ? m.images.findIndex((i) => i.key === m.startKey) : -1;
      this.idx = found >= 0 ? found : 0;
    }
    this.buildMedia();
    this.buildStrip();
  }

  private refreshKicker(): void {
    const m = this.model;
    if (m.kicker) this.kickerEl.setText(m.kicker);
  }

  private buildMedia(): void {
    const m = this.model;
    const host = this.mediaHost;
    host.empty();
    this.heroEl = null; this.badgeEl = null; this.timeEl = null; this.countEl = null;
    const n = m.images.length;
    if (n === 0) {
      if (m.featured) { host.className = 'ct-hidden'; return; }
      host.className = 'ct-gallery-media ct-gallery-ph';
      for (const a of ['tabindex', 'role', 'aria-label']) host.removeAttribute(a);
      const icon = host.createSpan('ct-gallery-ph-icon');
      icon.setAttribute('aria-hidden', 'true');
      setIcon(icon, 'image-off');
      host.createSpan({ cls: 'ct-gallery-ph-tag', text: m.placeholderTag });
      host.createEl('p', { cls: 'ct-gallery-ph-excerpt', text: m.excerpt });
      return;
    }
    host.className = 'ct-gallery-media';
    host.tabIndex = 0;
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', `Images for ${m.title}. Use left and right arrow keys to browse.`);
    this.heroEl = host.createEl('img', {
      cls: 'ct-gallery-hero',
      attr: { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' },
    });
    this.heroEl.addEventListener('error', () => {
      if (!this.heroEl?.getAttribute('src')) return;
      host.addClass('is-broken');
    });
    this.heroEl.addEventListener('load', () => host.removeClass('is-broken'));
    host.createDiv({ cls: 'ct-gallery-unavailable', text: 'Image unavailable', attr: { role: 'status' } });
    const badges = host.createDiv('ct-gallery-badges');
    this.badgeEl = badges.createSpan('ct-gallery-badge');
    this.timeEl = host.createSpan('ct-gallery-time');
    if (n > 1) {
      const prev = host.createEl('button', { cls: 'ct-gallery-nav ct-gallery-prev', attr: { type: 'button', 'aria-label': 'Previous image' } });
      setIcon(prev, 'chevron-left');
      prev.addEventListener('click', (e) => { e.stopPropagation(); this.show(this.idx - 1); });
      const next = host.createEl('button', { cls: 'ct-gallery-nav ct-gallery-next', attr: { type: 'button', 'aria-label': 'Next image' } });
      setIcon(next, 'chevron-right');
      next.addEventListener('click', (e) => { e.stopPropagation(); this.show(this.idx + 1); });
    }
    this.countEl = host.createSpan({ cls: 'ct-gallery-count', attr: { 'aria-live': 'polite' } });
    this.refreshHero();
  }

  private buildStrip(): void {
    const m = this.model;
    const host = this.stripHost;
    host.empty();
    this.thumbEls = [];
    host.className = 'ct-gallery-strip-host';
    if (m.images.length === 0 && m.featured) { host.addClass('ct-hidden'); return; }
    const ul = host.createEl('ul', { cls: 'ct-gallery-strip' });
    const n = m.images.length;
    const cap = Math.max(1, m.stripCap);
    const shown = Math.min(n, cap);
    if (n === 0) ul.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < cap; i++) {
      const li = ul.createEl('li');
      if (i >= shown) {
        li.setAttribute('aria-hidden', 'true');
        li.createSpan('ct-gallery-thumb ct-gallery-skel');
        continue;
      }
      const more = n > cap && i === cap - 1 ? n - (cap - 1) : 0;
      const btn = li.createEl('button', {
        cls: 'ct-gallery-thumb',
        attr: { type: 'button', 'data-i': String(i), 'aria-label': `Show image ${i + 1} of ${n}${more ? ` (and ${more - 1} more)` : ''}` },
      });
      const img = btn.createEl('img', { attr: { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' } });
      if (more) btn.createSpan({ cls: 'ct-gallery-more', text: `+${more}` });
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.show(i); });
      const entry = { btn, img, image: m.images[i], usingThumb: false };
      img.addEventListener('error', () => this.onThumbError(entry));
      this.thumbEls.push(entry);
    }
    this.refreshStripState();
    if (this.visible) { this.applyThumbSrcs(); this.backfillThumbs(); }
  }

  // ── behaviour ────────────────────────────────────────────────────────────

  private show(i: number): void {
    const n = this.model.images.length;
    if (n === 0) return;
    this.idx = ((i % n) + n) % n;
    this.heroEl?.parentElement?.removeClass('is-broken');
    this.refreshHero();
    this.refreshStripState();
    this.hooks.onPosition(this.model.images[this.idx].key, this.idx === 0);
    if (this.visible) { this.applyHeroSrc(); this.preloadNext(); }
  }

  private refreshHero(): void {
    const m = this.model;
    const image = m.images[this.idx];
    if (!image || !this.heroEl) return;
    this.heroEl.alt = `${m.title}, image ${this.idx + 1} of ${m.images.length}`;
    this.refreshHeroMeta();
    if (this.countEl) this.countEl.setText(`${this.idx + 1} / ${m.images.length}`);
    if (this.visible) this.applyHeroSrc();
  }

  private refreshHeroMeta(): void {
    const image = this.model.images[this.idx];
    if (!image) return;
    this.badgeEl?.setText(image.source);
    this.timeEl?.setText(relativeTime(image.timestamp ?? this.model.updatedAt));
  }

  private refreshStripState(): void {
    const n = this.model.images.length;
    const last = this.thumbEls.length - 1;
    this.thumbEls.forEach((t, j) => {
      const on = j === this.idx || (j === last && this.thumbEls.length < n && this.idx >= last);
      if (on) t.btn.setAttribute('aria-current', 'true');
      else t.btn.removeAttribute('aria-current');
    });
  }

  private applyHeroSrc(): void {
    const image = this.model.images[this.idx];
    if (!this.heroEl || !image) return;
    const url = this.hooks.resolveUrl(image, 'full');
    if (url) { if (this.heroEl.getAttribute('src') !== url) this.heroEl.setAttribute('src', url); }
    else { this.heroEl.removeAttribute('src'); this.mediaHost.addClass('is-broken'); }
  }

  private preloadNext(): void {
    const n = this.model.images.length;
    if (n < 2) { this.preloadEl = null; return; }
    const url = this.hooks.resolveUrl(this.model.images[(this.idx + 1) % n], 'full');
    if (!url) { this.preloadEl = null; return; }
    // A single detached element: replacing its src drops the previous preload.
    const pre = this.preloadEl ?? new Image();
    pre.src = url;
    this.preloadEl = pre;
  }

  private applyThumbSrcs(): void {
    for (const t of this.thumbEls) {
      const thumb = this.hooks.resolveUrl(t.image, 'thumb');
      const url = thumb ?? this.hooks.resolveUrl(t.image, 'full');
      t.usingThumb = !!thumb;
      if (url) t.img.setAttribute('src', url);
    }
  }

  /** A broken sidecar falls back to the full image once; a broken full image just stays blank. */
  private onThumbError(t: { btn: HTMLElement; img: HTMLImageElement; image: GalleryImage; usingThumb: boolean }): void {
    if (!t.img.getAttribute('src')) return;
    if (t.usingThumb) {
      t.usingThumb = false;
      const full = this.hooks.resolveUrl(t.image, 'full');
      if (full) { t.img.setAttribute('src', full); return; }
    }
    t.btn.addClass('is-broken');
  }

  private backfillThumbs(): void {
    for (const t of this.thumbEls) {
      const image = t.image;
      if (image.thumbPath || image.pending || !image.path) continue;
      if (this.requestedBackfill.has(image.key)) continue;
      this.requestedBackfill.add(image.key);
      void this.hooks.requestThumbnail(image).then((url) => {
        if (!url) return; // generation failed or unsupported: the full image stays in use
        if (this.visible && this.thumbEls.includes(t)) {
          t.usingThumb = true;
          t.img.setAttribute('src', url);
        }
      }, () => undefined);
    }
  }
}

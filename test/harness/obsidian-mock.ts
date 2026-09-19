/**
 * Obsidian API mock for the Playwright harness.
 * Must be imported first — sets up HTMLElement.prototype extensions.
 */
import { LUCIDE_ICONS } from './lucide-icons.generated';

// ─── HTMLElement.prototype extensions ────────────────────────────────────────

interface CreateElOptions {
  cls?: string;
  text?: string;
  attr?: Record<string, string | boolean>;
  placeholder?: string;
  type?: string;
  value?: string;
  title?: string;
}

function applyCreateEl<K extends keyof HTMLElementTagNameMap>(
  el: HTMLElementTagNameMap[K],
  opts?: CreateElOptions | string,
): HTMLElementTagNameMap[K] {
  if (!opts) return el;
  if (typeof opts === 'string') {
    el.className = opts;
    return el;
  }
  if (opts.cls) el.className = opts.cls;
  if (opts.text) el.textContent = opts.text;
  if (opts.attr) {
    for (const [k, v] of Object.entries(opts.attr)) {
      if (typeof v === 'boolean') {
        if (v) el.setAttribute(k, '');
        else el.removeAttribute(k);
      } else {
        el.setAttribute(k, v);
      }
    }
  }
  // Convenience shorthands
  if (opts.placeholder) el.setAttribute('placeholder', opts.placeholder);
  if (opts.type) el.setAttribute('type', opts.type);
  if (opts.value) (el as HTMLInputElement).value = opts.value;
  if (opts.title) el.setAttribute('title', opts.title);
  return el;
}

declare global {
  interface HTMLElement {
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      opts?: CreateElOptions | string,
    ): HTMLElementTagNameMap[K];
    createDiv(opts?: CreateElOptions | string): HTMLDivElement;
    createSpan(opts?: CreateElOptions | string): HTMLSpanElement;
    empty(): void;
    addClass(...classes: string[]): void;
    removeClass(...classes: string[]): void;
    hasClass(cls: string): boolean;
    toggleClass(cls: string, force?: boolean): void;
    setText(text: string): void;
    appendText(text: string): void;
  }
}

HTMLElement.prototype.createEl = function <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts?: CreateElOptions | string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyCreateEl(el, opts);
  this.appendChild(el);
  return el;
};

HTMLElement.prototype.createDiv = function (
  opts?: CreateElOptions | string,
): HTMLDivElement {
  return this.createEl('div', opts);
};

HTMLElement.prototype.createSpan = function (
  opts?: CreateElOptions | string,
): HTMLSpanElement {
  return this.createEl('span', opts);
};

HTMLElement.prototype.empty = function (): void {
  while (this.firstChild) this.removeChild(this.firstChild);
};

HTMLElement.prototype.addClass = function (...classes: string[]): void {
  for (const cls of classes) {
    if (cls) this.classList.add(cls);
  }
};

HTMLElement.prototype.removeClass = function (...classes: string[]): void {
  for (const cls of classes) {
    if (cls) this.classList.remove(cls);
  }
};

HTMLElement.prototype.hasClass = function (cls: string): boolean {
  return this.classList.contains(cls);
};

HTMLElement.prototype.toggleClass = function (cls: string, force?: boolean): void {
  if (force !== undefined) {
    this.classList.toggle(cls, force);
  } else {
    this.classList.toggle(cls);
  }
};

HTMLElement.prototype.setText = function (text: string): void {
  this.textContent = text;
};

HTMLElement.prototype.appendText = function (text: string): void {
  this.appendChild(document.createTextNode(text));
};

// ─── Lucide SVG strings ───────────────────────────────────────────────────────

// Generated from the pinned lucide-static package by
// scripts/gen-harness-icons.mts, which runs at the top of the harness build.
// Copied into a mutable object because addIcon() writes new entries at runtime.
const ICONS: Record<string, string> = { ...LUCIDE_ICONS };

/**
 * Rendered when an icon name has no entry in the map. Deliberately hideous —
 * a magenta box with a diagonal cross — so a miss is impossible to overlook in
 * a screenshot diff. The old fallback was a plain grey circle, which read as a
 * legitimate glyph and let 46 unmapped icons hide in the baselines.
 */
function missingIconSvg(name: string): string {
  return (
    `<svg class="svg-icon ct-missing-icon" data-missing-icon="${name}" ` +
    `xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ` +
    `fill="none" stroke="#ff00ff" stroke-width="2">` +
    `<rect x="2" y="2" width="20" height="20"/><path d="M2 2 22 22"/><path d="M22 2 2 22"/>` +
    `</svg>`
  );
}

/**
 * Record a miss on the window so test/screenshots/ui.spec.ts can fail the run
 * instead of quietly baking a placeholder into a baseline. De-duplicated, and
 * created lazily so a run with no misses leaves the global undefined.
 */
function recordMissingIcon(name: string): void {
  const w = window as unknown as { __ctMissingIcons?: string[] };
  if (!w.__ctMissingIcons) w.__ctMissingIcons = [];
  if (!w.__ctMissingIcons.includes(name)) {
    w.__ctMissingIcons.push(name);
    console.warn(
      `[harness] no Lucide icon mapped for "${name}" — rendering the missing-icon ` +
        `marker. If it is referenced dynamically, add it to EXTRA_ICONS in ` +
        `scripts/gen-harness-icons.mts.`,
    );
  }
}

// ─── Mock exports ─────────────────────────────────────────────────────────────

const mockSecrets: Record<string, string> = {
  'openai-api-key': 'sk-mock0000000000000000abcd',
  'ct-secret-STRIPE_SECRET_KEY': 'sk_live_mock00000000efgh',
};

type WorkspaceCallback = (...args: unknown[]) => void;
const workspaceCallbacks = new Map<string, Set<WorkspaceCallback>>();

export const mockWorkspace = {
  on: (name: string, callback: WorkspaceCallback) => {
    let callbacks = workspaceCallbacks.get(name);
    if (!callbacks) {
      callbacks = new Set();
      workspaceCallbacks.set(name, callbacks);
    }
    callbacks.add(callback);
    return { name, callback };
  },
  offref: (ref: { name: string; callback: WorkspaceCallback }) => {
    workspaceCallbacks.get(ref.name)?.delete(ref.callback);
  },
  trigger: (name: string, ...args: unknown[]) => {
    for (const callback of workspaceCallbacks.get(name) ?? []) callback(...args);
  },
  requestSaveLayout: () => {},
};

export const mockApp = {
  vault: {
    adapter: {
      getBasePath: () => '/mock/vault',
      getResourcePath: (p: string) => p,
    },
  },
  workspace: mockWorkspace,
  secretStorage: {
    getSecret: (name: string) => mockSecrets[name] ?? null,
    setSecret: (name: string, value: string) => { mockSecrets[name] = value; },
  },
  internalPlugins: {
    plugins: { webviewer: { enabled: true } },
  },
};

let headerUpdateCalls = 0;
export const getHeaderUpdateCalls = (): number => headerUpdateCalls;

export const mockLeaf: {
  app: typeof mockApp;
  view: ItemView | null;
  updateHeader: () => void;
} = {
  app: mockApp,
  view: null,
  updateHeader: () => {
    headerUpdateCalls += 1;
    mockLeaf.view?.refreshHeaderTitle();
  },
};

export class ItemView {
  containerEl: HTMLElement;
  app = mockApp;
  leaf: unknown;
  private cleanupCallbacks: Array<() => void> = [];

  constructor(_leaf: unknown) {
    this.leaf = _leaf;
    this.containerEl = document.createElement('div');
    // Mirror Obsidian/Geode's generic ItemView header closely enough that
    // plugin tests exercise the supported host surface instead of custom chrome.
    const header = document.createElement('div');
    header.className = 'view-header';
    const left = document.createElement('div');
    left.className = 'view-header-left';
    const titleContainer = document.createElement('div');
    titleContainer.className = 'view-header-title-container mod-at-start mod-fade mod-at-end';
    const title = document.createElement('div');
    title.className = 'view-header-title';
    titleContainer.appendChild(title);
    const actions = document.createElement('div');
    actions.className = 'view-actions';
    header.append(left, titleContainer, actions);
    const content = document.createElement('div');
    // Real Obsidian gives the ItemView content element the `view-content`
    // class, and views add their own root class alongside it (e.g.
    // `containerEl.children[1].addClass('ct-skills-root')`). Stylesheet rules
    // are written against BOTH — `.view-content.ct-skills-root { display:flex }`
    // — so omitting it here silently dropped those rules in the harness only:
    // the pane fell back to `display:block`, `flex:1` children stopped
    // stretching, and screenshots captured a content-height layout that the
    // real plugin never renders.
    content.className = 'view-content';
    this.containerEl.appendChild(header);
    this.containerEl.appendChild(content);
    if (_leaf === mockLeaf) mockLeaf.view = this;
    queueMicrotask(() => this.refreshHeaderTitle());
  }

  register(cb: () => void): void {
    this.cleanupCallbacks.push(cb);
  }
  registerEvent(ref: { name: string; callback: WorkspaceCallback }): void {
    this.register(() => mockWorkspace.offref(ref));
  }
  registerDomEvent(el: HTMLElement, type: string, handler: EventListener): void {
    el.addEventListener(type, handler);
    this.register(() => el.removeEventListener(type, handler));
  }

  unload(): void {
    for (const cleanup of this.cleanupCallbacks.splice(0).reverse()) cleanup();
  }

  getDisplayText(): string { return ''; }

  refreshHeaderTitle(): void {
    this.containerEl.querySelector('.view-header-title')?.setText(this.getDisplayText());
  }

  addAction(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const action = document.createElement('button');
    action.className = 'clickable-icon view-action';
    action.setAttribute('aria-label', title);
    action.title = title;
    setIcon(action, icon);
    action.addEventListener('click', callback);
    this.containerEl.querySelector('.view-actions')?.appendChild(action);
    return action;
  }
}

export class WorkspaceLeaf {}

export class Modal {
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  onClose(): void {}

  private overlay: HTMLElement;
  private container: HTMLElement;

  constructor(_app: unknown) {
    // Build a modal-container overlay in the document body
    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay';
    this.overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'background:rgba(0,0,0,0.5)',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'z-index:9999',
    ].join(';');

    this.container = document.createElement('div');
    this.container.className = 'modal-container';
    this.container.style.cssText = [
      'background:var(--background-primary,#1e1e1e)',
      'border:1px solid var(--background-modifier-border,#404040)',
      'border-radius:8px',
      'padding:20px',
      'min-width:300px',
      'max-width:420px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.4)',
    ].join(';');

    this.titleEl = document.createElement('h2');
    this.titleEl.style.cssText = 'margin:0 0 12px;font-size:16px;color:var(--text-normal,#dcddde)';

    this.contentEl = document.createElement('div');
    this.contentEl.style.cssText = 'color:var(--text-normal,#dcddde)';

    this.container.appendChild(this.titleEl);
    this.container.appendChild(this.contentEl);
    this.overlay.appendChild(this.container);
  }

  open(): void {
    document.body.appendChild(this.overlay);
    this.onOpen();
  }

  onOpen(): void {}

  close(): void {
    if (this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
    this.onClose();
  }
}

export function addIcon(name: string, svgContent: string): void {
  // Real Obsidian's addIcon() wraps custom (non-Lucide) icon content in
  // `<svg viewBox="0 0 100 100">` — the constant is `Sg = {viewBox:"0 0 100 100"}`
  // in Obsidian's app.js. It is NOT 24x24; only Lucide's own icons ship with a
  // 24x24 viewBox baked into their source. Mirror that here so glyphs scaled
  // for a 100x100 target render at the correct size in harness screenshots too.
  ICONS[name] = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 100 100">${svgContent}</svg>`;
}

export function setIcon(el: HTMLElement, name: string): void {
  const svg = ICONS[name];
  if (svg === undefined) {
    recordMissingIcon(name);
    el.innerHTML = missingIconSvg(name);
    return;
  }
  el.innerHTML = svg;
}

export function setTooltip(el: HTMLElement, tooltip: string, _options?: { placement?: string }): void {
  el.setAttribute('aria-label', tooltip);
  el.setAttribute('title', tooltip);
}

export class App {}

// ─── Settings API mocks (PluginSettingTab, Setting, components) ──────────────

export const Platform = {
  isMobile: false,
  isMobileApp: false,
  isDesktop: true,
  isDesktopApp: true,
  isMacOS: true,
};

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl: HTMLElement;

  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement('div');
    this.containerEl.className = 'vertical-tab-content';
  }

  display(): void {}
  hide(): void {}
}

export class TextComponent {
  inputEl: HTMLInputElement;

  constructor(containerEl: HTMLElement) {
    this.inputEl = containerEl.createEl('input', { type: 'text' });
  }

  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  onChange(cb: (value: string) => unknown): this {
    this.inputEl.addEventListener('input', () => cb(this.inputEl.value));
    return this;
  }

  then(cb: (component: this) => unknown): this {
    cb(this);
    return this;
  }
}

export class SearchComponent extends TextComponent {
  clearButtonEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    const searchContainer = containerEl.createDiv({ cls: 'search-input-container' });
    super(searchContainer);
    this.inputEl.type = 'search';
    this.clearButtonEl = searchContainer.createDiv({ cls: 'search-input-clear-button' });
    this.clearButtonEl.setAttribute('aria-label', 'Clear search');
    this.clearButtonEl.addEventListener('click', () => {
      this.setValue('');
      this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      this.inputEl.focus();
    });
  }

  onChanged(): void {}
}

export class TextAreaComponent {
  inputEl: HTMLTextAreaElement;

  constructor(containerEl: HTMLElement) {
    this.inputEl = containerEl.createEl('textarea');
  }

  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  onChange(cb: (value: string) => unknown): this {
    this.inputEl.addEventListener('input', () => cb(this.inputEl.value));
    return this;
  }
}

export class ToggleComponent {
  toggleEl: HTMLElement;
  private value = false;
  private changeCb: ((value: boolean) => unknown) | null = null;
  private disabled = false;

  constructor(containerEl: HTMLElement) {
    this.toggleEl = containerEl.createDiv({ cls: 'checkbox-container' });
    this.toggleEl.createEl('input', { type: 'checkbox' });
    this.toggleEl.addEventListener('click', () => {
      if (this.disabled) return;
      this.setValue(!this.value);
      this.changeCb?.(this.value);
    });
  }

  setValue(value: boolean): this {
    this.value = value;
    this.toggleEl.toggleClass('is-enabled', value);
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.toggleEl.toggleClass('is-disabled', disabled);
    return this;
  }

  onChange(cb: (value: boolean) => unknown): this {
    this.changeCb = cb;
    return this;
  }
}

export class DropdownComponent {
  selectEl: HTMLSelectElement;

  constructor(containerEl: HTMLElement) {
    this.selectEl = containerEl.createEl('select', { cls: 'dropdown' });
  }

  addOption(value: string, display: string): this {
    const opt = this.selectEl.createEl('option', { text: display });
    opt.value = value;
    return this;
  }

  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }

  onChange(cb: (value: string) => unknown): this {
    this.selectEl.addEventListener('change', () => cb(this.selectEl.value));
    return this;
  }
}

export class ButtonComponent {
  buttonEl: HTMLButtonElement;

  constructor(containerEl: HTMLElement) {
    this.buttonEl = containerEl.createEl('button');
  }

  setButtonText(text: string): this {
    this.buttonEl.setText(text);
    return this;
  }

  setIcon(name: string): this {
    setIcon(this.buttonEl, name);
    return this;
  }

  setCta(): this {
    this.buttonEl.addClass('mod-cta');
    return this;
  }

  setWarning(): this {
    this.buttonEl.addClass('mod-warning');
    return this;
  }

  setTooltip(tooltip: string): this {
    setTooltip(this.buttonEl, tooltip);
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.buttonEl.disabled = disabled;
    return this;
  }

  onClick(cb: (evt: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener('click', cb);
    return this;
  }
}

export class ExtraButtonComponent {
  extraSettingsEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.extraSettingsEl = containerEl.createDiv({ cls: 'clickable-icon extra-setting-button' });
  }

  setIcon(name: string): this {
    setIcon(this.extraSettingsEl, name);
    return this;
  }

  setTooltip(tooltip: string): this {
    setTooltip(this.extraSettingsEl, tooltip);
    return this;
  }

  onClick(cb: () => unknown): this {
    this.extraSettingsEl.addEventListener('click', () => cb());
    return this;
  }
}

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
    this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
    this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
    this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
    this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
  }

  setName(name: string): this {
    this.nameEl.setText(name);
    return this;
  }

  setDesc(desc: string): this {
    this.descEl.setText(desc);
    return this;
  }

  setHeading(): this {
    this.settingEl.addClass('setting-item-heading');
    return this;
  }

  setClass(cls: string): this {
    this.settingEl.addClass(cls);
    return this;
  }

  setTooltip(tooltip: string): this {
    setTooltip(this.settingEl, tooltip);
    return this;
  }

  addText(cb: (component: TextComponent) => unknown): this {
    cb(new TextComponent(this.controlEl));
    return this;
  }

  addTextArea(cb: (component: TextAreaComponent) => unknown): this {
    cb(new TextAreaComponent(this.controlEl));
    return this;
  }

  addToggle(cb: (component: ToggleComponent) => unknown): this {
    cb(new ToggleComponent(this.controlEl));
    return this;
  }

  addDropdown(cb: (component: DropdownComponent) => unknown): this {
    cb(new DropdownComponent(this.controlEl));
    return this;
  }

  addButton(cb: (component: ButtonComponent) => unknown): this {
    cb(new ButtonComponent(this.controlEl));
    return this;
  }

  addExtraButton(cb: (component: ExtraButtonComponent) => unknown): this {
    cb(new ExtraButtonComponent(this.controlEl));
    return this;
  }
}

/** Mock of Obsidian's secret picker component — renders a button that does nothing. */
export class SecretComponent {
  private changeCb: ((secretName: string) => unknown) | null = null;

  constructor(_app: unknown, containerEl: HTMLElement) {
    containerEl.createEl('button', { text: 'Select secret' });
  }

  onChange(cb: (secretName: string) => unknown): this {
    this.changeCb = cb;
    return this;
  }
}

export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content;
}

export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const match = linktext.match(/^([^#]*)(#.*)?$/);
  return { path: match?.[1] ?? linktext, subpath: match?.[2] ?? '' };
}

export class Menu {
  private items: MenuItem[] = [];

  addItem(cb: (item: MenuItem) => void): this {
    const item = new MenuItem();
    cb(item);
    this.items.push(item);
    return this;
  }

  addSeparator(): this { return this; }

  private show(): void {
    const menuEl = document.createElement('div');
    menuEl.className = 'menu';
    menuEl.style.cssText = [
      'position:fixed',
      'z-index:10000',
      'background:var(--background-primary,#1e1e1e)',
      'border:1px solid var(--background-modifier-border,#404040)',
      'border-radius:6px',
      'padding:4px 0',
      'min-width:160px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    ].join(';');

    for (const item of this.items) {
      const itemEl = document.createElement('div');
      itemEl.className = `menu-item${item.checked ? ' is-checked' : ''}${item.disabled ? ' is-disabled' : ''}`;
      itemEl.setAttribute('role', 'menuitemcheckbox');
      itemEl.setAttribute('aria-checked', String(item.checked));
      itemEl.setAttribute('aria-disabled', String(item.disabled));
      itemEl.style.cssText = 'padding:6px 12px;cursor:pointer;color:var(--text-normal,#dcddde);font-size:14px;';
      itemEl.textContent = item.checked ? `\u2713 ${item.title}` : item.title;
      itemEl.addEventListener('click', () => {
        if (item.disabled) return;
        item.triggerClick();
        if (menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
      });
      menuEl.appendChild(itemEl);
    }

    document.body.appendChild(menuEl);

    // Dismiss on next outside click
    const dismiss = (e: MouseEvent) => {
      if (!menuEl.contains(e.target as Node)) {
        if (menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
        document.removeEventListener('click', dismiss);
      }
    };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
  }

  showAtMouseEvent(_event: MouseEvent): void {
    this.show();
  }

  showAtPosition(_pos: { x: number; y: number }): void {
    this.show();
  }
}

class MenuItem {
  title = '';
  checked = false;
  disabled = false;
  private _cb?: () => void;

  setTitle(title: string): this { this.title = title; return this; }
  setIcon(_icon: string): this { return this; }
  setChecked(checked: boolean): this { this.checked = checked; return this; }
  setDisabled(disabled: boolean): this { this.disabled = disabled; return this; }
  onClick(cb: () => void): this { this._cb = cb; return this; }
  triggerClick(): void { this._cb?.(); }
}

export class Notice {
  constructor(_msg: string, _duration?: number) {}
}

export class FileSystemAdapter {}

export class TFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
  constructor(path = '') {
    this.path = path;
    this.name = path.split('/').pop() ?? path;
    this.basename = this.name.replace(/\.[^.]+$/, '');
    this.extension = this.name.includes('.') ? this.name.split('.').pop() ?? '' : '';
  }
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Mock for Obsidian's MarkdownRenderer — used by ThreadsView and MobileView.
 * In the real plugin this calls into Obsidian's internal Markdown pipeline
 * (which handles [[wikilinks]] etc.). For the test harness we render via
 * `marked` so that code blocks, bold, etc. look correct in screenshots.
 */
export class MarkdownRenderer {
  static async render(
    _app: unknown,
    markdown: string,
    el: HTMLElement,
    _sourcePath: string,
    _component: unknown,
  ): Promise<void> {
    // Dynamic import keeps this optional at type-check time and avoids
    // a circular-import issue in the esbuild harness bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { marked } = require('marked') as typeof import('marked');

    // Pre-process Obsidian [[wikilinks]] and [[target|alias]] before handing
    // off to marked, since marked doesn't know about them.  The real Obsidian
    // renderer resolves these to vault-internal hrefs; in the harness we just
    // produce <a data-href="…"> anchors so the rendered HTML has actual links.
    const withLinks = markdown.replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_match, target: string, alias?: string) => {
        const label = alias ?? target.split('/').pop() ?? target;
        return `<a class="internal-link" data-href="${target}" href="#">${label}</a>`;
      },
    );

    el.innerHTML = await marked(withLinks, { async: true });
  }
}

/**
 * Mock for Obsidian's requestUrl — used by SkillsManagerView to bypass CORS.
 * In the test harness we delegate to the global fetch so network calls still
 * work; the real plugin uses Electron's main-process fetch path instead.
 */
export async function requestUrl(options: { url: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<{ json: unknown; status: number }> {
  const res = await fetch(options.url, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
  });
  const json = await res.json();
  return { json, status: res.status };
}
// Filesystem authoring is verified against real temp directories in unit tests.
export function parseYaml(_text: string): unknown { throw new Error('YAML parsing is outside the visual harness'); }

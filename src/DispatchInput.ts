import { App, setIcon, setTooltip, Notice } from 'obsidian';
import type { ImageAttachment, ImageMediaType } from './types';
import { MAX_ATTACHMENT_BYTES } from './attachmentUtils';
import { SttController } from './stt';
import fs from 'fs';
import path from 'path';
import os from 'os';
import './harnessBrandIcons';

export interface DispatchPayload {
  text: string;
  images: ImageAttachment[];
  attachment: string | null;
  /** Harness selected by a kickoff picker, when that picker is enabled. */
  agentHarness?: 'claude' | 'codex';
}

export interface DispatchInputOptions {
  app: App;
  placeholder?: string;
  /**
   * Built-in slash commands to show before skill completions. Accepts a
   * static array or a resolver function — pass a function when the list can
   * change at runtime (e.g. it's derived from plugin settings) so the popup
   * reflects the latest value on every keystroke without re-mounting.
   */
  builtinCommands?: { name: string; description: string }[] | (() => { name: string; description: string }[]);
  subscribeCommands?: (listener: () => void) => () => void;
  /**
   * Argument completions per command name. When the input starts with
   * "/<command> " and the cursor is in the first argument word, the matching
   * options are offered in the same dropdown (e.g. /model → fable|opus|...).
   */
  argCompletions?: Record<string, { name: string; description: string }[]>;
  /** Called with the raw payload after the user submits */
  onSend: (payload: DispatchPayload) => Promise<void> | void;

  // ── New optional features ──────────────────────────────────────────────────
  /** Show a stop (■) button alongside send; toggle via setStreaming() */
  showStopBtn?: boolean;
  /** Called when the stop button is clicked or Escape is pressed while streaming */
  onStop?: () => void;
  /** Include "@this (currently open file)" as the first option in the file dropdown */
  showThisMention?: boolean;
  /** Show the thread context pill in the footer row; updated via setContext() */
  showContextChip?: boolean;
  /** Called when the thread context pill is clicked */
  onContextClick?: (e: MouseEvent) => void;
  /** Intercept pastes ≥500 chars as an attachment chip instead of inline text */
  captureLongPaste?: boolean;
  /** Called on every textarea keystroke */
  onInput?: () => void;
  /** Called when a chip is added or removed */
  onChipChange?: () => void;
  /** Slot for the caller to inject extra buttons into the footer actions area */
  appendFooterActions?: (container: HTMLElement) => void;
  /**
   * Slot for read-mostly status chips that sit between the CWD chip and the
   * footer action buttons. Kept separate from appendFooterActions so metadata
   * reads as part of the left-hand context group rather than the button cluster.
   */
  appendFooterMetadata?: (container: HTMLElement) => void;
  /**
   * When true, renders a compact single-row layout suitable for wider panels:
   *   [attach · mic]  [textarea (auto-grow)]  [send/stop]
   * No footer row is rendered in this mode.
   */
  inlineLayout?: boolean;
  /** Override the textarea CSS class (default: 'ct-agents-dispatch-input') */
  inputCls?: string;
  /** Minimum text length to allow sending when no attachment/images (default: 0) */
  minTextLength?: number;
  /** Text/symbol for the send button (default: '▶') */
  sendBtnText?: string;
  /** Title tooltip for the send button (default: 'Start task') */
  sendBtnTitle?: string;
  /** Turn the send button into a locally sticky kickoff harness picker. */
  harnessPicker?: { initialHarness: 'claude' | 'codex' };
  /**
   * Called on every keydown/keyup to retrieve the current push-to-talk hotkey
   * string (e.g. "Alt+Space"). When provided, hold-to-record PTT is enabled.
   * Reading from settings on each event means hotkey changes take effect
   * immediately without re-mounting the component.
   */
  getPttKey?: () => string;
  /**
   * Extra directories to scan for skills in addition to ~/.claude/skills/.
   * Pass the skills directories from configured plugin sources and the vault
   * skills root so they appear in the /command autocomplete immediately
   * (before the session fires commands_changed).
   */
  extraSkillDirs?: ExtraSkillDir[];
}

/** A directory of skill subdirectories, plus how its skills are namespaced as slash commands. */
export interface ExtraSkillDir {
  /** Directory containing one subdirectory per skill. */
  dir: string;
  /**
   * Shared namespace prefix for every skill in `dir`, e.g. `vault` → `/vault:foo`.
   * Omit for directories whose skills are registered as one local plugin each,
   * which the SDK names after the skill itself → `/foo:foo`.
   *
   * Getting this right matters: the names shown before the first session must
   * match the ones `commands_changed` reports afterwards, or autocomplete
   * offers a command string that does not resolve.
   */
  prefix?: string;
}

export class DispatchInput {
  private app: App;
  private options: DispatchInputOptions;

  private rootEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private inputRow!: HTMLElement;
  private pasteChipsEl!: HTMLElement;
  private hiddenFileInput!: HTMLInputElement;

  private sendBtn!: HTMLButtonElement;
  private stopBtn: HTMLButtonElement | null = null;
  private contextChipNameEl: HTMLElement | null = null;
  private contextChipEl: HTMLElement | null = null;

  private pendingImages: ImageAttachment[] = [];
  private pendingAttachment: string | null = null;

  // @mention dropdown
  private fileDropdown: HTMLElement | null = null;
  private fileDropdownItems: { path: string; basename: string; isThis?: boolean }[] = [];
  private fileDropdownIndex = 0;

  // /slash dropdown
  private skills: { name: string; description: string }[] = [];
  private skillDropdown: HTMLElement | null = null;
  private unsubscribeCommands?: () => void;
  private skillDropdownItems: { name: string; description: string }[] = [];
  private skillDropdownIndex = 0;
  // 'command' completes the /command word itself; 'arg' completes its first argument
  private skillDropdownMode: 'command' | 'arg' = 'command';

  // Active built-in command rendered as a pill before the textarea (e.g. /goal).
  // The command text is removed from the textarea and re-assembled on send.
  private pendingCommand: string | null = null;
  private commandPillEl: HTMLElement | null = null;

  private sttController: SttController | null = null;
  private dispatching = false;
  private selectedHarness: 'claude' | 'codex' | null = null;
  private harnessMenu: HTMLElement | null = null;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressNextSendClick = false;
  private readonly closeHarnessMenuOnPointerDown = (event: PointerEvent): void => {
    if (this.harnessMenu && !this.harnessMenu.contains(event.target as Node) && event.target !== this.sendBtn) {
      this.closeHarnessMenu();
    }
  };
  private readonly closeHarnessMenuOnEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.harnessMenu) {
      event.preventDefault();
      this.closeHarnessMenu(true);
    }
  };

  constructor(options: DispatchInputOptions) {
    this.app = options.app;
    this.options = options;
    this.loadSkills();
  }

  /**
   * Build the dispatch UI inside `parent` and return the root element.
   * The root element has class `ct-dispatch-root`.
   */
  mount(parent: HTMLElement): HTMLElement {
    this.rootEl = parent.createDiv('ct-dispatch-root');

    // Paste chips strip — hidden until attachments are added
    this.pasteChipsEl = this.rootEl.createDiv('ct-paste-chips ct-dispatch-chips ct-hidden');

    // Input row: textarea + action buttons
    const isInline = !!this.options.inlineLayout;
    this.inputRow = this.rootEl.createDiv(isInline ? 'ct-dispatch-inline-row' : 'ct-agents-dispatch-row');

    // In inline mode, action buttons sit to the LEFT of the textarea (created first so they appear left)
    const leftActionsEl = isInline ? this.inputRow.createDiv('ct-dispatch-left-actions') : null;

    this.inputEl = this.inputRow.createEl('textarea', {
      cls: this.options.inputCls ?? 'ct-agents-dispatch-input',
      attr: {
        placeholder: this.options.placeholder ?? 'Dispatch a task',
        rows: '1',
      },
    });

    const inputActions = this.inputRow.createDiv('ct-input-actions');

    const sendBtn = inputActions.createEl('button', {
      cls: 'ct-send-btn ct-agents-dispatch-btn',
      text: this.options.sendBtnText ?? '▶',
      attr: { title: this.options.sendBtnTitle ?? 'Start task' },
    });
    this.sendBtn = sendBtn;
    this.selectedHarness = this.options.harnessPicker?.initialHarness ?? null;
    if (this.selectedHarness) this.configureHarnessPicker();
    sendBtn.addEventListener('click', () => {
      if (this.suppressNextSendClick) {
        this.suppressNextSendClick = false;
        return;
      }
      this.send();
    });

    // Optional stop button (shown/hidden via setStreaming())
    if (this.options.showStopBtn) {
      this.stopBtn = inputActions.createEl('button', {
        cls: 'ct-stop-btn ct-hidden',
        text: '■',
        attr: { title: 'Stop' },
      });
      this.stopBtn.addEventListener('click', () => this.options.onStop?.());
    }

    // Build attach button (appended into footer or inputActions below)
    const attachBtn = document.createElement('button');
    attachBtn.className = 'ct-more-btn ct-agents-dispatch-attach-btn';
    attachBtn.title = 'Attach file';
    setIcon(attachBtn, 'paperclip');

    // Hidden file picker triggered by attachBtn
    this.hiddenFileInput = document.createElement('input');
    this.hiddenFileInput.type = 'file';
    this.hiddenFileInput.accept = '*';
    this.hiddenFileInput.multiple = true;
    this.hiddenFileInput.style.display = 'none';
    this.hiddenFileInput.addEventListener('change', () => {
      for (const f of Array.from(this.hiddenFileInput.files ?? [])) {
        if (f.type.startsWith('image/')) {
          this.addImageAttachment(f);
        } else {
          this.addFileAsTextAttachment(f);
        }
      }
      this.hiddenFileInput.value = '';
    });
    this.inputRow.appendChild(this.hiddenFileInput);
    attachBtn.addEventListener('click', () => this.hiddenFileInput.click());

    // Mic button for speech-to-text
    this.sttController = new SttController(this.app);
    const micBtn = this.sttController.createMicButton(this.inputEl);
    if (this.options.getPttKey) {
      this.sttController.attachPttToTextarea(this.inputEl, this.options.getPttKey);
    }

    if (isInline) {
      // ── Inline layout: attach + mic sit LEFT of the textarea ─────────────
      this.contextChipNameEl = null;
      this.contextChipEl = null;
      leftActionsEl!.appendChild(attachBtn);
      leftActionsEl!.appendChild(micBtn);
    } else {
      // ── Column layout: footer row or fallback to input-actions column ────
      const needsFooter = !!(this.options.showContextChip || this.options.appendFooterActions || this.options.appendFooterMetadata);
      if (needsFooter) {
        const inputFooter = this.rootEl.createDiv('ct-input-footer');

        if (this.options.showContextChip) {
          const contextChipEl = inputFooter.createEl('button', {
            cls: 'ct-footer-context',
            attr: { type: 'button', 'aria-haspopup': 'menu' },
          });
          const contextIcon = contextChipEl.createSpan('ct-footer-context-icon');
          setIcon(contextIcon, 'folder');
          this.contextChipNameEl = contextChipEl.createSpan({ cls: 'ct-footer-context-name' });
          const contextChevron = contextChipEl.createSpan('ct-footer-context-chevron');
          setIcon(contextChevron, 'chevron-up');
          this.contextChipEl = contextChipEl;
          if (this.options.onContextClick) {
            contextChipEl.addEventListener('click', (e) => this.options.onContextClick!(e));
          }
        } else {
          this.contextChipNameEl = null;
          this.contextChipEl = null;
        }

        if (this.options.appendFooterMetadata) {
          const footerMetaEl = inputFooter.createDiv('ct-input-footer-meta');
          this.options.appendFooterMetadata(footerMetaEl);
        }

        const footerActionsEl = inputFooter.createDiv('ct-input-footer-actions');
        this.options.appendFooterActions?.(footerActionsEl);
        // Attach + mic live in the footer bottom row (keeps input area compact)
        footerActionsEl.appendChild(attachBtn);
        footerActionsEl.appendChild(micBtn);
      } else {
        this.contextChipNameEl = null;
        this.contextChipEl = null;
        // No footer — fall back to putting attach + mic in the input actions column
        inputActions.appendChild(attachBtn);
        inputActions.appendChild(micBtn);
      }
    }

    // Keyboard handlers
    this.inputEl.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.inputEl.addEventListener('input', () => this.onInput());
    this.inputEl.addEventListener('blur', () => {
      // Delay so mousedown on a dropdown item fires before blur hides it
      setTimeout(() => {
        this.hideFileDropdown();
        this.hideSkillDropdown();
      }, 150);
    });

    // Paste: capture image files and (optionally) long text from clipboard
    this.inputEl.addEventListener('paste', (e) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      const imageFiles = files.filter(f => f.type.startsWith('image/'));
      if (imageFiles.length > 0) {
        e.preventDefault();
        imageFiles.forEach(f => this.addImageAttachment(f));
        return;
      }
      if (this.options.captureLongPaste) {
        const plainText = e.clipboardData?.getData('text/plain') ?? '';
        if (plainText.length >= 500) {
          e.preventDefault();
          this.setPendingAttachment(plainText);
          this.options.onChipChange?.();
          return;
        }
      }
    });

    // Drag-and-drop onto the root element
    this.rootEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.rootEl.addClass('ct-drag-over');
    });
    this.rootEl.addEventListener('dragleave', (e) => {
      if (!this.rootEl.contains(e.relatedTarget as Node | null)) {
        this.rootEl.removeClass('ct-drag-over');
      }
    });
    this.rootEl.addEventListener('drop', (e) => {
      e.preventDefault();
      this.rootEl.removeClass('ct-drag-over');
      const files = Array.from(e.dataTransfer?.files ?? []);
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          this.addImageAttachment(file);
        } else {
          this.addFileAsTextAttachment(file);
        }
      }
    });

    this.unsubscribeCommands = this.options.subscribeCommands?.(() => this.refreshCommands());
    return this.rootEl;
  }

  /** Resolves the current builtin command list, whether static or a function. */
  private getBuiltinCommands(): { name: string; description: string }[] {
    const bc = this.options.builtinCommands;
    if (!bc) return [];
    return typeof bc === 'function' ? bc() : bc;
  }

  focus(): void { this.inputEl?.focus(); }

  /** Resize the textarea to fit its content (used in inline layout). */
  private autoGrow(): void {
    if (!this.inputEl) return;
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = `${this.inputEl.scrollHeight}px`;
  }

  destroy(): void {
    this.unsubscribeCommands?.();
    this.unsubscribeCommands = undefined;
    this.clearLongPressTimer();
    this.closeHarnessMenu();
    this.sttController?.destroy();
    this.hideFileDropdown();
    this.hideSkillDropdown();
  }

  // ── Public getters / setters ──────────────────────────────────────────────

  /** Full logical value, including any active command pill. */
  getValue(): string {
    const raw = this.inputEl?.value ?? '';
    return this.pendingCommand ? `/${this.pendingCommand} ${raw}` : raw;
  }

  setValue(v: string): void {
    if (!this.inputEl) return;
    this.removeCommandPill();
    this.inputEl.value = v;
    // Re-pill a restored draft that starts with a built-in command
    this.maybeConvertCommandPill();
  }

  /**
   * Set the draft, then focus with the caret parked at the end.
   *
   * Plain `focus()` on a textarea restores the previous selection (usually
   * offset 0), which would drop the caret *before* a seeded `@[[doc]]` mention.
   * Used by "Chat about this document" so the user types straight after it.
   */
  setValueAndFocus(v: string): void {
    if (!this.inputEl) return;
    this.setValue(v);
    this.autoGrow();
    this.inputEl.focus();
    const end = this.inputEl.value.length;
    this.inputEl.setSelectionRange(end, end);
  }

  setPlaceholder(placeholder: string): void {
    if (!this.inputEl) return;
    this.inputEl.placeholder = placeholder;
  }

  setStreaming(v: boolean, allowSend = false): void {
    if (!this.options.showStopBtn) return;
    if (v) {
      this.sendBtn.toggleClass('ct-hidden', !allowSend);
      this.stopBtn?.removeClass('ct-hidden');
    } else {
      this.sendBtn.removeClass('ct-hidden');
      this.stopBtn?.addClass('ct-hidden');
      this.inputEl?.focus();
    }
  }

  setContext(displayText: string, tooltip: string): void {
    if (!this.contextChipNameEl || !this.contextChipEl) return;
    this.contextChipNameEl.textContent = displayText;
    setTooltip(this.contextChipEl, tooltip);
  }

  getPendingAttachment(): string | null { return this.pendingAttachment; }

  setPendingAttachment(v: string | null): void {
    this.pendingAttachment = v;
    this.renderChips();
  }

  getPendingImages(): ImageAttachment[] { return this.pendingImages.slice(); }

  setPendingImages(imgs: ImageAttachment[]): void {
    this.pendingImages = [...imgs];
    this.renderChips();
  }

  clearAttachments(): void {
    this.pendingAttachment = null;
    this.pendingImages = [];
    this.renderChips();
  }

  triggerSend(): void { this.send(); }

  // ── Send ─────────────────────────────────────────────────────────────────

  private async send(): Promise<void> {
    if (this.dispatching) return;
    const raw = this.inputEl.value.trim();
    const text = this.pendingCommand ? `/${this.pendingCommand}${raw ? ' ' + raw : ''}` : raw;
    const attachment = this.pendingAttachment;
    const images = this.pendingImages.slice();
    if (!text && !attachment && images.length === 0) return;

    this.dispatching = true;
    this.inputEl.value = '';
    this.removeCommandPill();
    this.autoGrow();
    this.pendingAttachment = null;
    this.pendingImages = [];
    this.renderChips();

    try {
      await this.options.onSend({
        text,
        images,
        attachment,
        ...(this.selectedHarness ? { agentHarness: this.selectedHarness } : {}),
      });
    } catch (err) {
      // Dispatch can fail after selection state changes (for example, a
      // Project is deleted in another view). Merge the failed payload back
      // into anything the user typed or attached while the async dispatch was
      // pending so neither version of the draft is lost.
      this.restoreFailedDraft(text, images, attachment);
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Could not dispatch: ${message}`);
    } finally {
      this.dispatching = false;
    }
  }

  // ── Kickoff harness picker ───────────────────────────────────────────────

  /** Restore a failed submission without overwriting a draft typed while it ran. */
  restoreFailedDraft(text: string, images: ImageAttachment[], attachment: string | null): void {
    const newerText = this.getValue().trim();
    this.setValue([text, newerText].filter(Boolean).join('\n\n'));
    const parts = [attachment, this.pendingAttachment].filter((part): part is string => !!part);
    this.pendingAttachment = parts.length ? parts.join('\n\n') : null;
    this.pendingImages = [...images, ...this.pendingImages];
    this.autoGrow();
    this.renderChips();
  }

  private configureHarnessPicker(): void {
    this.rootEl.addClass('ct-harness-picker-root');
    this.sendBtn.addClass('ct-harness-send-btn');
    this.renderHarnessIdentity();
    this.sendBtn.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.openHarnessMenu();
    });
    this.sendBtn.addEventListener('keydown', (event) => {
      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu' || (event.altKey && event.key === 'ArrowDown')) {
        event.preventDefault();
        this.openHarnessMenu();
      }
    });
    this.sendBtn.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.clearLongPressTimer();
      this.longPressTimer = setTimeout(() => {
        this.longPressTimer = null;
        this.suppressNextSendClick = true;
        this.openHarnessMenu();
      }, 500);
    });
    this.sendBtn.addEventListener('pointerup', () => {
      this.clearLongPressTimer();
      // A synthesized click follows pointerup synchronously. If the platform
      // omits that click, avoid suppressing the user's next intentional send.
      if (this.suppressNextSendClick) setTimeout(() => { this.suppressNextSendClick = false; }, 0);
    });
    this.sendBtn.addEventListener('pointercancel', () => {
      this.clearLongPressTimer();
      this.suppressNextSendClick = false;
    });
    this.sendBtn.addEventListener('pointerleave', () => this.clearLongPressTimer());
  }

  private renderHarnessIdentity(): void {
    if (!this.selectedHarness) return;
    const name = this.selectedHarness === 'claude' ? 'Claude' : 'Codex';
    this.sendBtn.empty();
    this.createHarnessMark(this.sendBtn, this.selectedHarness);
    const label = `Start task with ${name}; right-click or hold to change agent`;
    this.sendBtn.setAttribute('aria-label', label);
    this.sendBtn.setAttribute('aria-haspopup', 'menu');
    this.sendBtn.setAttribute('aria-expanded', this.harnessMenu ? 'true' : 'false');
    this.sendBtn.title = label;
  }

  private openHarnessMenu(): void {
    if (this.harnessMenu) return;
    const menu = this.rootEl.createDiv({ cls: 'ct-harness-menu', attr: { role: 'menu', 'aria-label': 'Choose agent harness' } });
    this.harnessMenu = menu;
    for (const harness of ['claude', 'codex'] as const) {
      const name = harness === 'claude' ? 'Claude' : 'Codex';
      const item = menu.createEl('button', {
        cls: 'ct-harness-menu-item',
        attr: {
          role: 'menuitemradio',
          'aria-checked': String(this.selectedHarness === harness),
          'data-harness': harness,
        },
      });
      this.createHarnessMark(item, harness);
      item.createSpan({ text: name });
      item.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.selectedHarness = harness;
        this.closeHarnessMenu(true);
        this.renderHarnessIdentity();
      });
      item.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        items[(items.indexOf(item) + offset + items.length) % items.length]?.focus();
      });
    }
    this.sendBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', this.closeHarnessMenuOnPointerDown);
    document.addEventListener('keydown', this.closeHarnessMenuOnEscape);
    menu.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }

  private createHarnessMark(container: HTMLElement, harness: 'claude' | 'codex'): void {
    const icon = harness === 'claude' ? 'claude-spark' : 'openai-blossom';
    const mark = container.createSpan({
      cls: `ct-harness-mark ct-harness-mark-${harness}`,
      attr: { 'aria-hidden': 'true', 'data-icon': icon },
    });
    setIcon(mark, icon);
  }

  private closeHarnessMenu(restoreFocus = false): void {
    if (!this.harnessMenu) return;
    this.harnessMenu.remove();
    this.harnessMenu = null;
    this.sendBtn?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.closeHarnessMenuOnPointerDown);
    document.removeEventListener('keydown', this.closeHarnessMenuOnEscape);
    if (restoreFocus) this.sendBtn?.focus();
  }

  private clearLongPressTimer(): void {
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.longPressTimer = null;
  }

  // ── Attachment handling ───────────────────────────────────────────────────

  private addImageAttachment(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      this.pendingImages.push({
        base64,
        mediaType: file.type as ImageMediaType,
        name: file.name || 'image',
      });
      this.renderChips();
      this.options.onChipChange?.();
    };
    reader.readAsDataURL(file);
  }

  private addFileAsTextAttachment(file: File): void {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      new Notice(`"${file.name}" is too large to attach (max 500 KB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      this.pendingAttachment = `${file.name}\n${reader.result as string}`;
      this.renderChips();
      this.options.onChipChange?.();
    };
    reader.onerror = () => new Notice(`Could not read "${file.name}".`);
    reader.readAsText(file);
  }

  private renderChips(): void {
    this.pasteChipsEl.empty();
    if (!this.pendingAttachment && this.pendingImages.length === 0) {
      this.pasteChipsEl.addClass('ct-hidden');
      return;
    }
    this.pasteChipsEl.removeClass('ct-hidden');

    if (this.pendingAttachment) {
      const chip = this.pasteChipsEl.createDiv('ct-paste-chip');
      const fileName = this.pendingAttachment.split('\n')[0].trim().slice(0, 40);
      chip.createSpan({ cls: 'ct-paste-chip-icon', text: '📄' });
      chip.createSpan({ cls: 'ct-paste-chip-label', text: fileName || 'attached file' });
      chip.createSpan({ cls: 'ct-paste-chip-meta', text: `${this.pendingAttachment.length.toLocaleString()} chars` });
      const removeBtn = chip.createEl('button', { cls: 'ct-paste-chip-remove', text: '×', attr: { title: 'Remove' } });
      removeBtn.addEventListener('click', () => {
        this.pendingAttachment = null;
        this.renderChips();
        this.options.onChipChange?.();
      });
    }

    this.pendingImages.forEach((img) => {
      const chip = this.pasteChipsEl.createDiv('ct-paste-chip ct-paste-chip-image');
      const thumb = chip.createEl('img', { cls: 'ct-paste-chip-thumb' });
      thumb.src = `data:${img.mediaType};base64,${img.base64}`;
      chip.createSpan({ cls: 'ct-paste-chip-label', text: img.name });
      const removeBtn = chip.createEl('button', { cls: 'ct-paste-chip-remove', text: '×', attr: { title: 'Remove' } });
      removeBtn.addEventListener('click', () => {
        this.pendingImages = this.pendingImages.filter(i => i !== img);
        this.renderChips();
        this.options.onChipChange?.();
      });
    });
  }

  // ── @mention autocomplete ────────────────────────────────────────────────

  private getAtQuery(): string | null {
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart ?? val.length;
    let start = pos - 1;
    while (start >= 0 && val[start] !== ' ' && val[start] !== '\n') start--;
    const word = val.slice(start + 1, pos);
    return word.startsWith('@') ? word.slice(1) : null;
  }

  private showFileDropdown(query: string): void {
    const q = query.toLowerCase();
    const showThis = this.options.showThisMention && 'this'.startsWith(q);
    const files = this.app.vault.getMarkdownFiles()
      .filter(f => q === '' || f.basename.toLowerCase().includes(q))
      .slice(0, showThis ? 19 : 20);
    const allItems: { path: string; basename: string; isThis?: boolean }[] = [
      ...(showThis ? [{ path: '', basename: 'this', isThis: true as const }] : []),
      ...files.map(f => ({ path: f.path, basename: f.basename })),
    ];
    if (allItems.length === 0) { this.hideFileDropdown(); return; }
    this.fileDropdownItems = allItems;
    if (this.fileDropdownIndex >= this.fileDropdownItems.length) this.fileDropdownIndex = 0;
    if (!this.fileDropdown) {
      this.fileDropdown = this.inputRow.createDiv('ct-file-dropdown');
    }
    this.renderFileDropdown();
  }

  private renderFileDropdown(): void {
    if (!this.fileDropdown) return;
    this.fileDropdown.empty();
    this.fileDropdownItems.forEach((file, i) => {
      const item = this.fileDropdown!.createDiv({
        cls: `ct-skill-item${i === this.fileDropdownIndex ? ' ct-skill-item-active' : ''}`,
      });
      const nameRow = item.createDiv({ cls: 'ct-skill-name' });
      nameRow.createSpan({ cls: 'ct-file-at', text: '@' });
      if (file.isThis) {
        nameRow.createSpan({ text: 'this' });
        item.createDiv({ cls: 'ct-skill-desc', text: 'currently open file' });
        item.addEventListener('mousedown', (e) => { e.preventDefault(); this.insertThisMention(); });
      } else {
        nameRow.createSpan({ text: file.basename });
        const pathParts = file.path.split('/');
        if (pathParts.length > 1) {
          const folder = pathParts.slice(0, -1).join('/');
          item.createDiv({ cls: 'ct-skill-desc', text: folder });
        }
        item.addEventListener('mousedown', (e) => { e.preventDefault(); this.insertFileMention(file.basename); });
      }
    });
  }

  private insertFileMention(basename: string): void {
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart ?? val.length;
    let start = pos - 1;
    while (start >= 0 && val[start] !== ' ' && val[start] !== '\n') start--;
    start++;
    const inserted = `@[[${basename}]] `;
    this.inputEl.value = val.slice(0, start) + inserted + val.slice(pos);
    this.inputEl.selectionStart = this.inputEl.selectionEnd = start + inserted.length;
    this.hideFileDropdown();
    this.inputEl.focus();
  }

  private insertThisMention(): void {
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart ?? val.length;
    let start = pos - 1;
    while (start >= 0 && val[start] !== ' ' && val[start] !== '\n') start--;
    start++;
    const inserted = '@this ';
    this.inputEl.value = val.slice(0, start) + inserted + val.slice(pos);
    this.inputEl.selectionStart = this.inputEl.selectionEnd = start + inserted.length;
    this.hideFileDropdown();
    this.inputEl.focus();
  }

  private hideFileDropdown(): void {
    this.fileDropdown?.remove();
    this.fileDropdown = null;
    this.fileDropdownItems = [];
    this.fileDropdownIndex = 0;
  }

  // ── Command pill ─────────────────────────────────────────────────────────

  /**
   * Converts a completed built-in command at the start of the input
   * ("/goal ") into a pill chip and strips it from the textarea. Skills are
   * left as text — pills are only for commands the plugin intercepts.
   */
  private maybeConvertCommandPill(): void {
    if (this.pendingCommand || !this.inputEl) return;
    const val = this.inputEl.value;
    const match = val.match(/^\/(\S+)(\s)/);
    if (!match) return;
    const name = match[1].toLowerCase();
    if (!this.getBuiltinCommands().some(c => c.name === name)) return;
    const pos = this.inputEl.selectionStart ?? val.length;
    this.setCommandPill(name);
    this.inputEl.value = val.slice(match[0].length);
    const newPos = Math.max(0, pos - match[0].length);
    this.inputEl.selectionStart = this.inputEl.selectionEnd = newPos;
  }

  private setCommandPill(name: string): void {
    this.pendingCommand = name;
    if (!this.commandPillEl) {
      this.commandPillEl = document.createElement('span');
      this.commandPillEl.className = 'ct-command-pill';
      this.inputRow.insertBefore(this.commandPillEl, this.inputEl);
    }
    this.commandPillEl.empty();
    this.commandPillEl.createSpan({ cls: 'ct-command-pill-name', text: `/${name}` });
    const removeBtn = this.commandPillEl.createSpan({ cls: 'ct-command-pill-x', text: '×' });
    removeBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.removeCommandPill();
      this.inputEl.focus();
    });
  }

  private removeCommandPill(): void {
    this.pendingCommand = null;
    this.commandPillEl?.remove();
    this.commandPillEl = null;
  }

  // ── /slash autocomplete ──────────────────────────────────────────────────

  private loadSkills(): void {
    const allSkills: { name: string; description: string }[] = [];

    // Scan ~/.claude/skills/ (individual skills and non-plugin symlinks)
    const skillsDir = path.join(os.homedir(), '.claude', 'skills');
    try {
      for (const entry of fs.readdirSync(skillsDir)) {
        const name = entry.replace(/\.md$/, '');
        const entryPath = path.join(skillsDir, entry);
        const isDir = fs.statSync(entryPath).isDirectory();
        let filePath = isDir ? '' : entryPath;
        if (isDir) {
          const candidates = ['index.md', 'skill.md', 'SKILL.md', name + '.md'];
          const found = candidates.find(f => fs.existsSync(path.join(entryPath, f)));
          if (found) filePath = path.join(entryPath, found);
          else {
            const first = fs.readdirSync(entryPath).find(f => f.endsWith('.md'));
            if (first) filePath = path.join(entryPath, first);
          }
        }
        allSkills.push({ name, description: filePath ? this.readSkillDescription(filePath) : '' });
      }
    } catch { /* ignore missing dir */ }

    // Also scan extra dirs supplied by the caller (plugin sources, vault skills
    // root). Unlike the ~/.claude/skills scan above — whose skills the CLI
    // loads bare — these are registered as plugins and are only invocable under
    // a namespace, so the name shown here has to carry the prefix.
    for (const { dir: extraDir, prefix } of (this.options.extraSkillDirs ?? [])) {
      try {
        for (const entry of fs.readdirSync(extraDir)) {
          const entryPath = path.join(extraDir, entry);
          try {
            if (!fs.statSync(entryPath).isDirectory()) continue;
            const candidates = ['SKILL.md', 'skill.md', 'index.md', entry + '.md'];
            const skillFile = candidates.find(f => fs.existsSync(path.join(entryPath, f)));
            if (!skillFile) continue;
            const desc = this.readSkillDescription(path.join(entryPath, skillFile));
            allSkills.push({ name: `${prefix ?? entry}:${entry}`, description: desc });
          } catch { continue; }
        }
      } catch { /* ignore missing dir */ }
    }

    this.skills = allSkills;
  }

  private readSkillDescription(filePath: string): string {
    try {
      const content = fs.readFileSync(filePath, 'utf8').slice(0, 2000);
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const fm = fmMatch[1];
        const inline = fm.match(/^description:\s+([^>|\n][^\n]*)/m);
        if (inline) return inline[1].trim();
        const block = fm.match(/^description:\s*>-?\s*\n((?:[ \t]+[^\n]*\n?)+)/m);
        if (block) return block[1].replace(/^[ \t]+/mg, '').replace(/\n/g, ' ').trim();
      }
      const body = content.replace(/^---[\s\S]*?---\n/, '');
      for (const line of body.split('\n')) {
        const clean = line.replace(/^#+\s*/, '').trim();
        if (clean && !clean.startsWith('---')) return clean;
      }
      return '';
    } catch {
      return '';
    }
  }

  /**
   * Replace the cached skill list with the dynamically-discovered command list
   * from an SDKCommandsChangedMessage. Deduplication happens at display time so
   * removing a peer command restores any same-named underlying skill.
   */
  setAvailableCommands(commands: { name: string; description: string }[]): void {
    this.skills = commands.map(c => ({ name: c.name, description: c.description }));
    this.refreshCommands();
  }

  /** Registry changes preserve the draft and the underlying SDK skill catalog. */
  refreshCommands(): void {
    if (!this.inputEl) return;
    if (this.pendingCommand && !this.getBuiltinCommands().some(c => c.name === this.pendingCommand)) {
      this.setValue(this.getValue());
    }
    if (this.skillDropdown) {
      const arg = this.getArgQuery();
      const query = this.getSlashQuery();
      if (arg) this.showArgDropdown(arg.options, arg.partial);
      else if (query !== null) this.showSkillDropdown(query);
      else this.hideSkillDropdown();
    }
  }

  private getSlashQuery(): string | null {
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart ?? val.length;
    let start = pos - 1;
    while (start >= 0 && val[start] !== ' ' && val[start] !== '\n') start--;
    const word = val.slice(start + 1, pos);
    return word.startsWith('/') ? word.slice(1) : null;
  }

  /**
   * Detects "/command <partial-arg>" with the cursor in the first argument
   * word and returns the matching completion options. Only commands listed in
   * options.argCompletions participate.
   */
  private getArgQuery(): { options: { name: string; description: string }[]; partial: string } | null {
    const completions = this.options.argCompletions;
    if (!completions) return null;
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart ?? val.length;
    const before = val.slice(0, pos);
    // With an active command pill, the textarea holds only the arguments —
    // offer completions while the cursor is in the first word.
    if (this.pendingCommand) {
      if (!/^\S*$/.test(before)) return null;
      const options = completions[this.pendingCommand];
      return options ? { options, partial: before } : null;
    }
    const match = before.match(/^\/(\S+)\s+(\S*)$/);
    if (!match) return null;
    const options = completions[match[1].toLowerCase()];
    if (!options) return null;
    return { options, partial: match[2] };
  }

  private showSkillDropdown(query: string): void {
    const q = query.toLowerCase();
    const catalog = this.getBuiltinCommands();
    const builtinNames = new Set(catalog.map(c => c.name.toLowerCase()));
    const builtins = catalog.filter(c => c.name.toLowerCase().startsWith(q));
    const skills = this.skills.filter(s => !builtinNames.has(s.name.toLowerCase()) && s.name.toLowerCase().startsWith(q));
    this.skillDropdownMode = 'command';
    this.openDropdownWith([...builtins, ...skills]);
  }

  private showArgDropdown(options: { name: string; description: string }[], partial: string): void {
    const q = partial.toLowerCase();
    this.skillDropdownMode = 'arg';
    this.openDropdownWith(options.filter(o => o.name.startsWith(q)));
  }

  private openDropdownWith(matches: { name: string; description: string }[]): void {
    if (matches.length === 0) { this.hideSkillDropdown(); return; }
    this.skillDropdownItems = matches;
    if (this.skillDropdownIndex >= matches.length) this.skillDropdownIndex = 0;
    if (!this.skillDropdown) {
      this.skillDropdown = this.inputRow.createDiv('ct-skill-dropdown');
    }
    this.renderSkillDropdown();
  }

  private renderSkillDropdown(): void {
    if (!this.skillDropdown) return;
    this.skillDropdown.empty();
    this.skillDropdownItems.forEach((skill, i) => {
      const item = this.skillDropdown!.createDiv({
        cls: `ct-skill-item${i === this.skillDropdownIndex ? ' ct-skill-item-active' : ''}`,
      });
      const nameRow = item.createDiv({ cls: 'ct-skill-name' });
      if (this.skillDropdownMode === 'command') {
        nameRow.createSpan({ cls: 'ct-skill-slash', text: '/' });
      }
      nameRow.createSpan({ text: skill.name });
      if (skill.description) {
        item.createDiv({ cls: 'ct-skill-desc', text: skill.description });
      }
      item.addEventListener('mousedown', (e) => { e.preventDefault(); this.insertSkill(skill.name); });
    });
  }

  private insertSkill(skillName: string): void {
    const val = this.inputEl.value;
    const pos = this.inputEl.selectionStart ?? val.length;
    let start = pos - 1;
    while (start >= 0 && val[start] !== ' ' && val[start] !== '\n') start--;
    start++;
    // Selecting a built-in command at the start of the input becomes a pill
    // chip instead of inserted text (skills stay as text in the message).
    const isBuiltin = this.getBuiltinCommands().some(c => c.name === skillName);
    if (this.skillDropdownMode === 'command' && start === 0 && isBuiltin && !this.pendingCommand) {
      this.setCommandPill(skillName);
      this.inputEl.value = val.slice(pos);
      this.inputEl.selectionStart = this.inputEl.selectionEnd = 0;
      this.hideSkillDropdown();
      this.inputEl.focus();
      return;
    }
    // In arg mode, replace just the partial argument word (no leading slash).
    const inserted = this.skillDropdownMode === 'arg' ? skillName + ' ' : '/' + skillName + ' ';
    this.inputEl.value = val.slice(0, start) + inserted + val.slice(pos);
    this.inputEl.selectionStart = this.inputEl.selectionEnd = start + inserted.length;
    this.hideSkillDropdown();
    this.inputEl.focus();
  }

  private hideSkillDropdown(): void {
    this.skillDropdown?.remove();
    this.skillDropdown = null;
    this.skillDropdownItems = [];
    this.skillDropdownIndex = 0;
    this.skillDropdownMode = 'command';
  }

  // ── Event handlers ───────────────────────────────────────────────────────

  private onKeyDown(e: KeyboardEvent): void {
    if (this.fileDropdown) {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.fileDropdownIndex = Math.min(this.fileDropdownIndex + 1, this.fileDropdownItems.length - 1); this.renderFileDropdown(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.fileDropdownIndex = Math.max(this.fileDropdownIndex - 1, 0); this.renderFileDropdown(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selectedItem = this.fileDropdownItems[this.fileDropdownIndex];
        if (selectedItem.isThis) {
          this.insertThisMention();
        } else {
          this.insertFileMention(selectedItem.basename);
        }
        return;
      }
      if (e.key === 'Escape') { this.hideFileDropdown(); return; }
    }
    if (this.skillDropdown) {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.skillDropdownIndex = Math.min(this.skillDropdownIndex + 1, this.skillDropdownItems.length - 1); this.renderSkillDropdown(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.skillDropdownIndex = Math.max(this.skillDropdownIndex - 1, 0); this.renderSkillDropdown(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.insertSkill(this.skillDropdownItems[this.skillDropdownIndex].name); return; }
      if (e.key === 'Escape') { this.hideSkillDropdown(); return; }
    }
    // A single backspace at the very start of the input deletes the command pill
    if (
      e.key === 'Backspace' &&
      this.pendingCommand &&
      this.inputEl.selectionStart === 0 &&
      this.inputEl.selectionEnd === 0
    ) {
      e.preventDefault();
      this.removeCommandPill();
      return;
    }
    // Escape while streaming triggers stop
    if (e.key === 'Escape' && this.options.showStopBtn && this.stopBtn && !this.stopBtn.hasClass('ct-hidden')) {
      this.options.onStop?.();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.send();
    }
  }

  private onInput(): void {
    this.autoGrow();
    const atQuery = this.getAtQuery();
    if (atQuery !== null) {
      this.hideSkillDropdown();
      this.showFileDropdown(atQuery);
      this.options.onInput?.();
      return;
    }
    this.hideFileDropdown();
    this.maybeConvertCommandPill();
    const slashQuery = this.getSlashQuery();
    if (slashQuery !== null) {
      this.showSkillDropdown(slashQuery);
    } else {
      const argQuery = this.getArgQuery();
      if (argQuery) this.showArgDropdown(argQuery.options, argQuery.partial);
      else this.hideSkillDropdown();
    }
    this.options.onInput?.();
  }
}

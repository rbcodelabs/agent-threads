import { App, Modal } from 'obsidian';
import type { McpServerEntry } from './mcpServerStore';

/** Host-owned approval, independent of either harness's tool permission mode. */
export class McpRegistrationModal extends Modal {
  private confirmed = false;
  private resolved = false;
  constructor(app: App, private entry: McpServerEntry, private onResult: (confirmed: boolean) => void) {
    super(app);
  }
  onOpen(): void {
    this.contentEl.addClass('ct-mcp-registration');
    this.contentEl.createEl('h2', { text: 'Register MCP server?' });
    this.contentEl.createEl('p', { text: 'This adds the server globally to Agent Threads settings for all projects and threads.' });
    this.contentEl.createEl('p', { text: this.entry.type === 'stdio'
      ? 'Newly initialized sessions may run this command with your account permissions. Registration itself does not run it.'
      : 'Newly initialized sessions may connect to this endpoint and send configured headers. Registration itself does not connect.' });
    this.contentEl.createEl('pre', { text: JSON.stringify(this.entry, null, 2), cls: 'ct-mcp-registration-config' });
    this.contentEl.createEl('p', { text: 'Secret placeholders stay unresolved here. The current session keeps its existing tools.' });
    const buttons = this.contentEl.createDiv({ cls: 'ct-mcp-registration-buttons' });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    buttons.createEl('button', { text: 'Register server', cls: 'mod-cta' }).addEventListener('click', () => {
      this.confirmed = true;
      this.close();
    });
  }
  onClose(): void {
    this.contentEl.empty();
    if (this.resolved) return;
    this.resolved = true;
    this.onResult(this.confirmed);
  }
}

/**
 * Yes/no confirmation dialog. Lived in SkillsManagerView.ts until the archive
 * context menu needed it too; moved here so a leaf module can depend on it
 * without pulling in the whole skills manager.
 *
 * The move also fixes a latent bug. The original resolved `onResult` inside the
 * two button handlers and did nothing in `onClose`, so dismissing the dialog
 * with Esc or a click outside never called back at all — and
 * `ThreadsView.closeThread`, which wraps this in `new Promise`, hung forever.
 *
 * The fix resolves in `onClose` **only**. Resolving in the button handlers too
 * would be worse than the bug: they call `close()` first, so `onClose` would
 * deliver `false` before the handler delivered `true`.
 */
export class ConfirmModal extends Modal {
  private onResult: (confirmed: boolean) => void;
  private message: string;
  private confirmLabel: string;
  private danger: boolean;
  /** Set by the confirm button before it closes; read once by `onClose`. */
  private result = false;
  /** Guards against a second `onClose` (Obsidian may call it more than once). */
  private resolved = false;

  constructor(
    app: App,
    message: string,
    confirmLabel: string,
    onResult: (confirmed: boolean) => void,
    danger = true,
  ) {
    super(app);
    this.danger = danger;
    this.message = message;
    this.confirmLabel = confirmLabel;
    this.onResult = onResult;
  }

  onOpen(): void {
    this.contentEl.createEl('p', { text: this.message });
    const btns = this.contentEl.createEl('div', { cls: 'ct-skills-modal-btns' });
    btns.createEl('button', { cls: 'ct-skills-btn', text: 'Cancel' }).addEventListener('click', () => {
      this.close();
    });
    btns.createEl('button', { cls: this.danger ? 'ct-skills-btn ct-skills-btn--danger' : 'ct-skills-btn mod-cta', text: this.confirmLabel }).addEventListener('click', () => {
      this.result = true;
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.resolved) return;
    this.resolved = true;
    this.onResult(this.result);
  }
}

/**
 * Promise wrapper around ConfirmModal. Safe to `await` because dismissal now
 * resolves `false` rather than leaving the promise pending.
 */
export function promptConfirm(
  app: App,
  confirm: { message: string; confirmLabel: string; /** Red destructive styling; defaults to true. */ danger?: boolean },
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    new ConfirmModal(app, confirm.message, confirm.confirmLabel, resolve, confirm.danger ?? true).open();
  });
}

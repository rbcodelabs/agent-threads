import { App, Modal } from 'obsidian';

/**
 * Display/open path for an absolute href that points outside the vault:
 * the `#subpath` is dropped (it means nothing to the OS) and percent escapes
 * (marked encodes hrefs) are decoded, falling back to raw on a malformed one.
 */
export function outsideVaultLinkPath(href: string): string {
  const trimmed = href.trim();
  const hash = trimmed.indexOf('#');
  const pathPart = hash === -1 ? trimmed : trimmed.slice(0, hash);
  try { return decodeURIComponent(pathPart); } catch { return pathPart; }
}

export interface OutsideVaultLinkActions {
  open: (path: string) => void | Promise<void>;
  reveal: (path: string) => void | Promise<void>;
  copy: (path: string) => void | Promise<void>;
}

/** Confirmation shown when a clicked link targets a file outside the vault. */
export class OutsideVaultLinkModal extends Modal {
  private readonly path: string;

  constructor(app: App, href: string, private actions: OutsideVaultLinkActions) {
    super(app);
    this.path = outsideVaultLinkPath(href);
  }

  onOpen(): void {
    this.titleEl.setText('Open file outside this vault?');
    this.contentEl.addClass('ct-outside-link-modal');
    this.contentEl.createEl('p', { text: 'This link points to a file that is not in this vault:' });
    this.contentEl.createEl('code', { text: this.path, cls: 'ct-outside-link-path' });
    const buttons = this.contentEl.createDiv('ct-skills-modal-btns');
    const add = (text: string, run: (path: string) => void | Promise<void>, cls?: string) => {
      buttons.createEl('button', { text, cls }).addEventListener('click', () => {
        this.close();
        void run(this.path);
      });
    };
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    add('Copy path', this.actions.copy);
    add('Reveal in Finder', this.actions.reveal);
    add('Open', this.actions.open, 'mod-cta');
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

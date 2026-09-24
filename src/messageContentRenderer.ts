/** DOM-only renderer. Providers supply data, never nodes or host-origin HTML. */
import { escapeMessageContentHtml, MessageContentProviderRegistry } from './MessageContent';
import type { MessageContentContext, MessageContentMarker, MessageContentActionHost, MessageContentPresentation } from './MessageContent';
import { setIcon } from 'obsidian';

const DOCUMENT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * The trusted outer shell's frame-src policy also constrains child navigation.
 * A payload CSP alone cannot prevent window.location navigation in Chromium.
 */
export function sandboxMessageDocument(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('base,meta,iframe,frame,frameset,object,embed,form,portal').forEach(node => node.remove());
  parsed.querySelectorAll('a,area').forEach(node => { node.removeAttribute('href'); node.removeAttribute('target'); node.removeAttribute('ping'); node.removeAttribute('download'); });
  const policy = parsed.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy'); policy.setAttribute('content', DOCUMENT_CSP);
  parsed.head.prepend(policy);
  const child = `<!doctype html>${parsed.documentElement.outerHTML}`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${escapeMessageContentHtml(DOCUMENT_CSP)}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%}</style></head><body><iframe title="Document content" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeMessageContentHtml(child)}"></iframe></body></html>`;
}

interface Mount {
  readonly card: HTMLElement;
  readonly marker: MessageContentMarker;
  readonly context: MessageContentContext;
  readonly streaming: boolean;
  controller: AbortController;
}

export class MessageContentMountManager {
  private readonly mounts = new Set<Mount>();
  private readonly unsubscribe: () => void;
  private disposed = false;
  private observer: MutationObserver | undefined;
  private readonly pendingDocuments = new Map<Element, () => void>();
  private visibilityObserver: IntersectionObserver | undefined;
  constructor(private readonly registry: MessageContentProviderRegistry | undefined, private readonly host: Omit<MessageContentActionHost, 'signal'>) {
    this.unsubscribe = registry?.subscribe(() => {
      for (const mount of this.mounts) {
        mount.controller.abort(); mount.controller = new AbortController();
        if (mount.card.isConnected) void this.render(mount);
      }
    }) ?? (() => {});
    if (typeof IntersectionObserver !== 'undefined') this.visibilityObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        const mountDocument = this.pendingDocuments.get(entry.target);
        this.pendingDocuments.delete(entry.target); this.visibilityObserver?.unobserve(entry.target); mountDocument?.();
      }
    });
    if (typeof MutationObserver !== 'undefined') {
      this.observer = new MutationObserver(() => {
        for (const mount of this.mounts) if (!mount.card.isConnected) { mount.controller.abort(); this.mounts.delete(mount); this.pendingDocuments.delete(mount.card); this.visibilityObserver?.unobserve(mount.card); }
      });
      this.observer.observe(document.body, { childList: true, subtree: true });
    }
  }
  reset(): void { for (const mount of this.mounts) mount.controller.abort(); this.mounts.clear(); this.pendingDocuments.clear(); this.visibilityObserver?.disconnect(); }
  dispose(): void { this.disposed = true; this.reset(); this.unsubscribe(); this.observer?.disconnect(); }

  async hydrate(el: HTMLElement, markers: readonly MessageContentMarker[], context: MessageContentContext, options: { streaming?: boolean } = {}): Promise<void> {
    if (this.disposed || context.signal.aborted) return;
    const tasks: Promise<void>[] = [];
    for (const marker of markers) {
      // Only a nonce actually generated for this parse can become a card.
      const slots = Array.from(el.querySelectorAll<HTMLElement>('.ct-message-content-slot')).filter(slot => slot.getAttribute('data-ct-content') === marker.token);
      if (slots.length !== 1) continue;
      const card = document.createElement('section'); card.className = 'ct-inline-content';
      card.setAttribute('aria-label', marker.ref.title);
      const slot = slots[0];
      const parent = slot.parentElement;
      if (parent?.tagName === 'P' && parent.childNodes.length === 1) parent.replaceWith(card); else slot.replaceWith(card);
      const mount: Mount = { card, marker, context, streaming: !!options.streaming, controller: new AbortController() };
      this.mounts.add(mount); tasks.push(this.render(mount));
    }
    await Promise.all(tasks);
  }

  private fallback(mount: Mount, message: string): void {
    mount.card.replaceChildren(); mount.card.dataset.kind = 'fallback';
    this.text(mount.card, 'ct-inline-content-title', mount.marker.ref.title);
    this.text(mount.card, 'ct-inline-content-status', message);
  }
  private text(parent: HTMLElement, className: string, text: string): HTMLElement {
    const element = document.createElement('div'); element.className = className; element.textContent = text; parent.appendChild(element); return element;
  }
  private async render(mount: Mount): Promise<void> {
    const { controller } = mount;
    const valid = () => !this.disposed && !controller.signal.aborted && !mount.context.signal.aborted && this.mounts.has(mount) && mount.card.isConnected;
    this.fallback(mount, mount.streaming ? 'Content will be available when the response finishes.' : `Content unavailable — ${mount.marker.ref.providerId}`);
    if (mount.streaming || !this.registry || !valid()) return;
    const abort = () => controller.abort();
    mount.context.signal.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener('abort', () => mount.context.signal.removeEventListener('abort', abort), { once: true });
    const context = Object.freeze({ threadId: mount.context.threadId, messageId: mount.context.messageId, signal: controller.signal });
    const presentation = await this.registry.present(mount.marker.ref, context);
    if (!valid() || !presentation) return;
    this.draw(mount, presentation, context, valid);
  }
  private draw(mount: Mount, presentation: MessageContentPresentation, context: MessageContentContext, valid: () => boolean): void {
    const { card } = mount;
    card.replaceChildren(); card.dataset.kind = presentation.kind;
    const heading = this.text(card, 'ct-inline-content-heading', '');
    if (presentation.icon) { const icon = this.text(heading, 'ct-inline-content-icon', ''); setIcon(icon, presentation.icon); }
    this.text(heading, 'ct-inline-content-title', presentation.title);
    if (presentation.subtitle) this.text(card, 'ct-inline-content-subtitle', presentation.subtitle);
    if (presentation.kind === 'card' && presentation.body) this.text(card, 'ct-inline-content-body', presentation.body);
    if (presentation.kind === 'image') {
      const image = document.createElement('img'); image.className = 'ct-inline-content-image'; image.alt = presentation.alt;
      image.referrerPolicy = 'no-referrer'; image.loading = 'lazy'; image.src = presentation.src;
      image.addEventListener('error', () => { if (valid()) { image.remove(); this.text(card, 'ct-inline-content-status', 'Image unavailable'); } }, { once: true });
      card.appendChild(image);
    }
    if (presentation.kind === 'document') {
      const mountDocument = () => {
        if (!valid()) return;
        const frame = document.createElement('iframe'); frame.className = 'ct-inline-content-document'; frame.title = presentation.title;
        frame.setAttribute('sandbox', 'allow-scripts'); frame.referrerPolicy = 'no-referrer';
        frame.style.height = `${presentation.height ?? 360}px`;
        frame.srcdoc = sandboxMessageDocument(presentation.html);
        card.insertBefore(frame, card.querySelector('.ct-inline-content-actions'));
        context.signal.addEventListener('abort', () => frame.remove(), { once: true });
      };
      if (this.visibilityObserver) {
        this.pendingDocuments.set(card, mountDocument); this.visibilityObserver.observe(card);
        context.signal.addEventListener('abort', () => { this.pendingDocuments.delete(card); this.visibilityObserver?.unobserve(card); }, { once: true });
      } else mountDocument();
    }
    if (presentation.actions?.length) {
      const actions = this.text(card, 'ct-inline-content-actions', '');
      for (const action of presentation.actions) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = action.label;
        button.className = `ct-inline-content-action${action.variant === 'primary' ? ' mod-cta' : ''}`;
        actions.appendChild(button);
        button.addEventListener('click', async () => {
          if (!valid() || button.disabled) return;
          button.disabled = true;
          const result = await this.registry!.invoke(action.id, mount.marker.ref, context, { openView: state => valid() ? this.host.openView(state) : Promise.resolve('unavailable') });
          if (!valid()) return;
          button.disabled = false;
          card.querySelector('.ct-inline-content-action-status')?.remove();
          if (result.message) {
            const status = this.text(card, 'ct-inline-content-action-status', result.message); status.setAttribute('role', 'status');
          }
        });
      }
    }
  }
}

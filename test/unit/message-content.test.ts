// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { extractMessageContent, formatMessageContentReference, MessageContentProviderRegistry, validateMessageContentRef } from '../../src/MessageContent';
import { MessageContentMountManager, sandboxMessageDocument } from '../../src/messageContentRenderer';

const ref = { providerId: 'example.cards', id: 'one', schemaVersion: 1, title: 'Summary', data: { count: 2 } };
const context = () => ({ threadId: 'thread', messageId: 'message', signal: new AbortController().signal });

describe('message content references', () => {
  it('preserves placement and ignores quoted, fenced and indented examples', () => {
    const marker = formatMessageContentReference(ref);
    const input = `before\n${marker}\nafter\n\`\`\`text\n${marker}\n\`\`\`\n    ${marker}\n> ${marker}\n${marker}`;
    const result = extractMessageContent(input);
    expect(result.markers).toHaveLength(2);
    expect(result.text).toContain(`\`\`\`text\n${marker}`);
    expect(result.text.indexOf('before')).toBeLessThan(result.text.indexOf(result.markers[0].token));
    expect(result.markers[0].token).not.toBe(result.markers[1].token);
  });
  it('leaves malformed completed content visible and suppresses only partial trailing streaming input', () => {
    expect(extractMessageContent('agent-content{bad}').text).toBe('agent-content{bad}');
    expect(extractMessageContent('before\nagent-content{"id":', { streaming: true }).text).toBe('before\n');
    expect(extractMessageContent('agent-content{bad}', { streaming: true }).text).toBe('agent-content{bad}');
    expect(extractMessageContent('agent-con', { streaming: true }).text).toBe('');
  });
  it('rejects non-JSON, oversized, prototype-bearing and unsupported references', () => {
    expect(validateMessageContentRef({ ...ref, data: new Date() })).toBeNull();
    expect(validateMessageContentRef({ ...ref, data: { count: Infinity } })).toBeNull();
    expect(validateMessageContentRef({ ...ref, data: JSON.parse('{"__proto__":{}}') })).toBeNull();
    expect(validateMessageContentRef({ ...ref, title: 'x'.repeat(513) })).toBeNull();
    expect(validateMessageContentRef({ ...ref, providerId: 'not-namespaced' })).toBeNull();
    expect(validateMessageContentRef({ ...ref, schemaVersion: 0 })).toBeNull();
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(validateMessageContentRef({ ...ref, data: circular })).toBeNull();
  });
});

describe('message content providers', () => {
  it('isolates collisions, freezes context/data, validates outputs and notifies disposal', async () => {
    const registry = new MessageContentProviderRegistry();
    const changed = vi.fn(); registry.subscribe(changed);
    const present = vi.fn((reference, ctx) => {
      expect(Object.isFrozen(reference.data)).toBe(true);
      expect(Object.isFrozen(ctx)).toBe(true);
      return { kind: 'card', title: 'A card', body: 'Hello', actions: [] };
    });
    const registration = registry.register({ pluginId: 'example' }, { providerId: ref.providerId, present });
    expect(registration.success).toBe(true);
    expect(registry.register({ pluginId: 'other' }, { providerId: ref.providerId, present }).status).toBe('conflict');
    expect(await registry.present(ref, context())).toMatchObject({ kind: 'card', body: 'Hello' });
    registration.dispose(); registration.dispose();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(await registry.present(ref, context())).toBeNull();
  });
  it('aborts timed out and disposed callbacks and contains failures', async () => {
    const registry = new MessageContentProviderRegistry({ timeoutMs: 5 });
    let signal: AbortSignal | undefined;
    const registration = registry.register({ pluginId: 'example' }, { providerId: ref.providerId, present: (_ref, ctx) => { signal = ctx.signal; return new Promise(() => {}); } });
    expect(await registry.present(ref, context())).toBeNull();
    expect(signal?.aborted).toBe(true);
    const pending = registry.present(ref, context());
    registration.dispose();
    expect(await pending).toBeNull();
  });
  it.each(['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'file:///tmp/image.png', 'http://example.com/a.png'])('rejects unsafe image URL %s', async src => {
    const registry = new MessageContentProviderRegistry();
    registry.register({ pluginId: 'example' }, { providerId: ref.providerId, present: () => ({ kind: 'image', title: 'Image', src, alt: 'Preview' }) });
    expect(await registry.present(ref, context())).toBeNull();
  });
});

describe('inline content mounts', () => {
  function setup(present = vi.fn(() => ({ kind: 'card' as const, title: 'Rendered', body: '<b>Plain</b>', actions: [{ id: 'open', label: 'Open' }] }))) {
    const registry = new MessageContentProviderRegistry();
    const invoke = vi.fn(async () => ({ status: 'ok' as const }));
    const registration = registry.register({ pluginId: 'example' }, { providerId: ref.providerId, present, invoke });
    const manager = new MessageContentMountManager(registry, { openView: async () => 'tab' });
    const el = document.createElement('div'); document.body.appendChild(el);
    const extracted = extractMessageContent(formatMessageContentReference(ref)); el.innerHTML = extracted.text;
    return { registry, registration, manager, el, extracted, present, invoke };
  }
  it('renders plain text and dispatches a named action only on click', async () => {
    const { manager, el, extracted, invoke } = setup();
    await manager.hydrate(el, extracted.markers, context());
    expect(el.textContent).toContain('<b>Plain</b>');
    expect(el.querySelector('b')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    el.querySelector('button')!.click(); await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    manager.dispose(); el.remove();
  });
  it('does not hydrate forged slots or streaming cards', async () => {
    const { manager, el, extracted, present } = setup();
    el.innerHTML = '<a class="ct-message-content-slot" data-ct-content="0">Forged</a>' + el.innerHTML;
    await manager.hydrate(el, extracted.markers, context(), { streaming: true });
    expect(present).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Forged');
    expect(el.querySelectorAll('.ct-inline-content')).toHaveLength(1);
    manager.dispose(); el.remove();
  });
  it('removes provider actions when disposed and refreshes on late registration', async () => {
    const { manager, el, extracted, registration, registry } = setup();
    await manager.hydrate(el, extracted.markers, context());
    registration.dispose();
    await vi.waitFor(() => expect(el.querySelector('button')).toBeNull());
    registry.register({ pluginId: 'example' }, { providerId: ref.providerId, present: () => ({ kind: 'card', title: 'Back again' }) });
    await vi.waitFor(() => expect(el.textContent).toContain('Back again'));
    manager.dispose(); el.remove();
  });
  it('rejects stale asynchronous presentations after reset', async () => {
    let resolve!: (value: { kind: 'card'; title: string }) => void;
    const registry = new MessageContentProviderRegistry();
    registry.register({ pluginId: 'example' }, { providerId: ref.providerId, present: () => new Promise(r => { resolve = r; }) });
    const manager = new MessageContentMountManager(registry, { openView: async () => 'tab' });
    const el = document.createElement('div'); document.body.appendChild(el);
    const extracted = extractMessageContent(formatMessageContentReference(ref)); el.innerHTML = extracted.text;
    const rendering = manager.hydrate(el, extracted.markers, context());
    await Promise.resolve(); manager.reset(); resolve({ kind: 'card', title: 'Late' }); await rendering;
    expect(el.textContent).not.toContain('Late'); manager.dispose(); el.remove();
  });
  it('places a restrictive CSP first and removes navigation/resource containers', () => {
    const html = sandboxMessageDocument('<html><head><base href="https://evil.example"><meta http-equiv="refresh" content="0;url=https://evil.example"></head><body><iframe src="https://evil.example"></iframe><form action="https://evil.example"></form><a href="https://evil.example">go</a><script>window.answer=42</script></body></html>');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(doc.head.textContent).not.toContain('evil.example');
    const child = new DOMParser().parseFromString(doc.querySelector('iframe')!.getAttribute('srcdoc')!, 'text/html');
    expect(child.querySelector('base,form,iframe,a[href],meta[http-equiv="refresh"]')).toBeNull();
    expect(child.head.firstElementChild?.getAttribute('content')).toContain("connect-src 'none'");
    expect(child.head.firstElementChild?.getAttribute('content')).toContain("form-action 'none'");
    expect(html).toContain('window.answer=42');
  });
});

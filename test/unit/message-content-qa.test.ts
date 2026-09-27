// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractMessageContent, formatMessageContentReference, MessageContentProviderRegistry, validateMessageContentRef } from '../../src/MessageContent';
import type { MessageContentActionHost, MessageContentContribution, MessageContentPresentation } from '../../src/MessageContent';
import { MessageContentMountManager } from '../../src/messageContentRenderer';

const ref = { providerId: 'example.cards', id: 'preview', schemaVersion: 1, title: 'Preview', data: {} };
const card = { kind: 'card' as const, title: 'Ready', actions: [{ id: 'open', label: 'Open' }] };
const context = (controller = new AbortController()) => ({ threadId: 'thread', messageId: 'message', signal: controller.signal });
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); document.body.replaceChildren(); vi.useRealTimers(); });

function registryWith(contribution: Partial<MessageContentContribution> = {}, timeoutMs = 1000) {
  const registry = new MessageContentProviderRegistry({ timeoutMs });
  const registration = registry.register({ pluginId: 'example' }, { providerId: ref.providerId, present: () => card, ...contribution });
  cleanup.push(() => registry.clear());
  return { registry, registration };
}

async function mounted(contribution: Partial<MessageContentContribution> = {}) {
  const fixture = registryWith(contribution);
  const openView = vi.fn(async () => 'tab' as const);
  const manager = new MessageContentMountManager(fixture.registry, { openView });
  cleanup.push(() => manager.dispose());
  const el = document.createElement('div'); document.body.append(el);
  const extracted = extractMessageContent(formatMessageContentReference(ref)); el.innerHTML = extracted.text;
  const controller = new AbortController();
  await manager.hydrate(el, extracted.markers, context(controller));
  return { ...fixture, manager, el, controller, openView };
}

describe('inline content adversarial lifecycle', () => {
  it.each(['reset', 'dispose', 'abort', 'replacement', 'detach'] as const)('does not dispatch a saved button after %s', async mode => {
    const invoke = vi.fn(async () => ({ status: 'ok' as const }));
    const fixture = await mounted({ invoke });
    const button = fixture.el.querySelector('button')!;
    if (mode === 'reset') fixture.manager.reset();
    if (mode === 'dispose') fixture.manager.dispose();
    if (mode === 'abort') fixture.controller.abort();
    if (mode === 'detach') fixture.el.remove();
    if (mode === 'replacement') {
      fixture.registration.dispose();
      fixture.registry.register({ pluginId: 'example' }, { providerId: ref.providerId, present: () => card, invoke });
    }
    button.click();
    await Promise.resolve(); await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(['reset', 'disposal', 'timeout'] as const)('revokes an in-flight action host after %s', async mode => {
    vi.useFakeTimers();
    let actionHost: MessageContentActionHost | undefined;
    const fixture = await mounted({ invoke: async (_id, _ref, _ctx, host) => {
      actionHost = host;
      return new Promise(() => {});
    } });
    fixture.el.querySelector('button')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(actionHost).toBeDefined();
    if (mode === 'reset') fixture.manager.reset();
    if (mode === 'disposal') fixture.registration.dispose();
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(1001);
    expect(actionHost!.signal.aborted).toBe(true);
    expect(await actionHost!.openView({ type: 'example-preview' })).toBe('unavailable');
    expect(fixture.openView).not.toHaveBeenCalled();
  });

  it('does not invoke an action withdrawn after the card was rendered', async () => {
    const invoke = vi.fn(async () => ({ status: 'ok' as const }));
    let available = true;
    const fixture = await mounted({ present: () => ({ ...card, actions: available ? card.actions : [] }), invoke });
    available = false;
    fixture.el.querySelector('button')!.click();
    await vi.waitFor(() => expect(fixture.el.querySelector('[role="status"]')?.textContent).toContain('unavailable'));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('contains rejected actions and restores the button for retry', async () => {
    const fixture = await mounted({ invoke: async () => { throw new Error('private provider error'); } });
    const button = fixture.el.querySelector('button')!;
    button.click();
    await vi.waitFor(() => expect(fixture.el.querySelector('[role="status"]')).not.toBeNull());
    expect(button.disabled).toBe(false);
    expect(fixture.el.textContent).not.toContain('private provider error');
  });

  it('contains malformed action results with throwing getters', async () => {
    const { registry } = registryWith({ invoke: async () => Object.defineProperty({}, 'status', { get() { throw new Error('provider getter'); } }) as { status: 'ok' } });
    await expect(registry.invoke('open', ref, context(), { openView: async () => 'tab' })).resolves.toMatchObject({ status: 'error' });
  });

  it('cannot dispose a replacement provider through the old registration handle', async () => {
    const { registry, registration } = registryWith();
    registration.dispose();
    registry.register({ pluginId: 'example' }, { providerId: ref.providerId, present: () => ({ kind: 'card', title: 'Replacement' }) });
    registration.dispose();
    expect(await registry.present(ref, context())).toMatchObject({ title: 'Replacement' });
  });

  it('ignores a late presentation after its provider has been replaced', async () => {
    let resolve!: (value: MessageContentPresentation) => void;
    const { registry, registration } = registryWith({ present: () => new Promise(done => { resolve = done; }) });
    const pending = registry.present(ref, context());
    await Promise.resolve();
    registration.dispose();
    registry.register({ pluginId: 'example' }, { providerId: ref.providerId, present: () => ({ kind: 'card', title: 'Current' }) });
    resolve({ kind: 'card', title: 'Stale' });
    expect(await pending).toBeNull();
    expect(await registry.present(ref, context())).toMatchObject({ title: 'Current' });
  });

  it('contains presentation rejection without preventing other providers from rendering', async () => {
    const { registry } = registryWith({ present: async () => { throw new Error('private provider error'); } });
    registry.register({ pluginId: 'example' }, { providerId: 'example.healthy', present: () => card });
    expect(await registry.present(ref, context())).toBeNull();
    expect(await registry.present({ ...ref, providerId: 'example.healthy' }, context())).toMatchObject({ title: 'Ready' });
  });
});

describe('inline content parser boundaries', () => {
  it.each(['-', '1.'])('does not hydrate markers inside %s list fences', prefix => {
    const marker = formatMessageContentReference(ref);
    const indent = ' '.repeat(prefix.length + 1);
    const input = `${prefix} \`\`\`text\n${indent}${marker}\n${indent}\`\`\`\n\n${marker}`;
    const parsed = extractMessageContent(input);
    expect(parsed.markers).toHaveLength(1);
    expect(parsed.text).toContain(`${indent}${marker}`);
  });

  it('preserves nested quoted fence examples while recognizing subsequent prose', () => {
    const marker = formatMessageContentReference(ref);
    const input = `> - \`\`\`\n>   ${marker}\n>   \`\`\`\n\n${marker}`;
    expect(extractMessageContent(input).markers).toHaveLength(1);
  });

  it('does not let a shorter fence or an info-bearing delimiter close a code sample', () => {
    const marker = formatMessageContentReference(ref);
    const parsed = extractMessageContent(`\`\`\`\`text\n\`\`\`\n${marker}\n\`\`\`\`oops\n${marker}\n\`\`\`\`\n${marker}`);
    expect(parsed.markers).toHaveLength(1);
  });

  it('preserves partial marker text within a streaming code block', () => {
    const input = '```text\nagent-con';
    expect(extractMessageContent(input, { streaming: true }).text).toBe(input);
  });

  it('bounds marker mounts while preserving excess source references', () => {
    const marker = formatMessageContentReference(ref);
    const parsed = extractMessageContent(Array(34).fill(marker).join('\n'));
    expect(parsed.markers).toHaveLength(32);
    expect(parsed.text.split(marker)).toHaveLength(3);
  });

  it('round-trips HTML-sensitive JSON without generating markup from the title', () => {
    const input = { ...ref, title: '<img src=x onerror=alert(1)>', data: { escaped: '"}\\\n\u2028<>&' } };
    const parsed = extractMessageContent(formatMessageContentReference(input));
    expect(parsed.markers[0].ref).toEqual(input);
    expect(parsed.text).not.toContain('<img');
  });
});

describe('inline content validation and immutability', () => {
  it.each([
    { kind: 'document', title: 'Bad', html: 'x'.repeat(1_000_001) },
    { kind: 'document', title: 'Bad', html: '', height: NaN },
    { kind: 'image', title: 'Bad', src: 'https://user:pass@example.test/a.png', alt: '' },
    { ...card, actions: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }] },
    { ...card, actions: Array.from({ length: 9 }, (_, id) => ({ id: String(id), label: 'Action' })) },
  ])('rejects malformed or oversized presentation %#', async value => {
    const { registry } = registryWith({ present: () => value as MessageContentPresentation });
    expect(await registry.present(ref, context())).toBeNull();
  });

  it('takes immutable snapshots of nested reference data and provider actions', async () => {
    const data = { rows: [{ title: 'Before' }] };
    const reference = validateMessageContentRef({ ...ref, data })!;
    data.rows[0].title = 'After';
    expect(reference.data).toEqual({ rows: [{ title: 'Before' }] });
    expect(Object.isFrozen((reference.data.rows as readonly object[])[0])).toBe(true);
    const output = { ...card, actions: [{ id: 'open', label: 'Before' }] };
    const { registry } = registryWith({ present: () => output });
    const presentation = await registry.present(ref, context());
    output.actions[0].label = 'After';
    expect(presentation?.actions?.[0].label).toBe('Before');
    expect(Object.isFrozen(presentation?.actions?.[0])).toBe(true);
  });

  it('rejects nested getters without executing them', () => {
    const getter = vi.fn(() => 'secret');
    const data = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
    expect(validateMessageContentRef({ ...ref, data })).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });
});

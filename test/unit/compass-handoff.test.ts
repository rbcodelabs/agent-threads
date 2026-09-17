/**
 * compass-handoff.test.ts
 *
 * Covers the Compass → Agent Threads "Send to Agent" receiver:
 *   1. Payload validation (strict on load-bearing fields, tolerant on sugar).
 *   2. sourceUrl absolutization + scheme rejection.
 *   3. Prompt / title assembly.
 *   4. The duplicate-event debounce.
 *   5. `handleWebViewerEvent` driven through a faithful synthetic
 *      `NormalizedWebViewerEvent` on an Obsidian-shaped event bus, covering all
 *      five required edge cases.
 *   6. Source guard: the listener stays registered in `onloadDesktop()` via
 *      `this.registerEvent`, filtered by source + type.
 *
 * NOT covered here (and NOT verifiable yet): a real click in Compass. The
 * Compass-side sender does not exist, so no test in this repo can observe the
 * true end-to-end path. Everything below drives the same event object Geode
 * re-emits, which is the closest faithful substitute.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  AGENT_HANDOFF_EVENT_TYPE,
  COMPASS_CONNECTOR_ID,
  HandoffDebouncer,
  WEB_VIEWER_EVENT_NAME,
  absolutizeSourceUrl,
  buildHandoffPrompt,
  buildHandoffTitle,
  handleWebViewerEvent,
  handoffKey,
  parseAgentHandoffPayload,
  type AgentHandoffPayload,
  type HandoffHost,
  type NormalizedHandoff,
  type WebViewerBridgeEvent,
} from '../../src/compassHandoff';

// ── Fixtures ───────────────────────────────────────────────────────────────

const GUEST_URL = 'https://compass.rbcodelabs.com/rbcodelabs/compass/discovery/opp_01J9ABC';

/** The shape Compass's shipped `AgentHandoffContext` resolver produces. */
function validPayload(overrides: Partial<Record<keyof AgentHandoffPayload, unknown>> = {}): unknown {
  return {
    entityType: 'solutionPlan',
    entityId: 'sol_plan_01J9ABCXYZ',
    label: 'Approved plan · Compass → Geode agent handoff',
    summary: 'Add a runtime picker to Send to Agent so the user can pick the local plugin.',
    suggestedInstruction: 'Implement the approved plan "Compass → Geode agent handoff".',
    promptBlock: '### Approved plan\n\n1. Add the runtime picker\n2. Post agent.handoff on the bridge',
    sourceUrl: '/rbcodelabs/compass/discovery/opp_01J9ABC?detail=solution:sol_01J9XYZ',
    ...overrides,
  };
}

/** A faithful Geode `NormalizedWebViewerEvent`. */
function bridgeEvent(overrides: Partial<WebViewerBridgeEvent> = {}): WebViewerBridgeEvent {
  return {
    source: COMPASS_CONNECTOR_ID,
    type: AGENT_HANDOFF_EVENT_TYPE,
    payload: validPayload(),
    url: GUEST_URL,
    timestamp: 1_760_000_000_000,
    ...overrides,
  };
}

interface RecordingHost extends HandoffHost {
  prompts: string[];
  titles: string[];
  surfaced: string[];
  notices: string[];
}

function recordingHost(opts: { ready?: boolean; dispatch?: () => Promise<string> } = {}): RecordingHost {
  const prompts: string[] = [];
  const titles: string[] = [];
  const surfaced: string[] = [];
  const notices: string[] = [];
  let seq = 0;
  return {
    prompts,
    titles,
    surfaced,
    notices,
    isReady: () => opts.ready ?? true,
    dispatchThread: async (prompt, titleHint) => {
      prompts.push(prompt);
      titles.push(titleHint);
      if (opts.dispatch) return opts.dispatch();
      return `thread-${++seq}`;
    },
    surfaceThread: async (threadId) => { surfaced.push(threadId); },
    notify: (message) => { notices.push(message); },
  };
}

const normalized: NormalizedHandoff = {
  entityType: 'solutionPlan',
  entityId: 'sol_plan_01J9ABCXYZ',
  suggestedInstruction: 'Implement the approved plan.',
  promptBlock: '### Approved plan\n\nStep one.',
  label: 'Approved plan · Handoff',
  summary: 'One line of summary.',
  sourceUrl: 'https://compass.rbcodelabs.com/x',
};

// ── 1. Payload validation ──────────────────────────────────────────────────

describe('parseAgentHandoffPayload', () => {
  it('accepts the shipped Compass AgentHandoffContext shape', () => {
    const result = parseAgentHandoffPayload(validPayload(), GUEST_URL);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({
      entityType: 'solutionPlan',
      entityId: 'sol_plan_01J9ABCXYZ',
      suggestedInstruction: 'Implement the approved plan "Compass → Geode agent handoff".',
      promptBlock: '### Approved plan\n\n1. Add the runtime picker\n2. Post agent.handoff on the bridge',
      label: 'Approved plan · Compass → Geode agent handoff',
      summary: 'Add a runtime picker to Send to Agent so the user can pick the local plugin.',
      sourceUrl: 'https://compass.rbcodelabs.com/rbcodelabs/compass/discovery/opp_01J9ABC?detail=solution:sol_01J9XYZ',
    });
  });

  it('accepts the decision entity type', () => {
    const result = parseAgentHandoffPayload(validPayload({ entityType: 'decision', entityId: 'dec_1' }), GUEST_URL);
    expect(result.ok).toBe(true);
  });

  for (const field of ['entityType', 'entityId', 'suggestedInstruction', 'promptBlock'] as const) {
    it(`rejects a payload missing the load-bearing field "${field}"`, () => {
      const payload = validPayload() as Record<string, unknown>;
      delete payload[field];
      const result = parseAgentHandoffPayload(payload, GUEST_URL);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toContain(field);
    });

    it(`rejects a non-string "${field}"`, () => {
      const result = parseAgentHandoffPayload(validPayload({ [field]: 42 }), GUEST_URL);
      expect(result.ok).toBe(false);
    });

    it(`rejects a whitespace-only "${field}"`, () => {
      const result = parseAgentHandoffPayload(validPayload({ [field]: '   ' }), GUEST_URL);
      expect(result.ok).toBe(false);
    });
  }

  it('names every missing load-bearing field at once', () => {
    const result = parseAgentHandoffPayload({ label: 'x' }, GUEST_URL);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('entityType');
    expect(result.reason).toContain('entityId');
    expect(result.reason).toContain('suggestedInstruction');
    expect(result.reason).toContain('promptBlock');
  });

  for (const [name, value] of [
    ['null', null],
    ['undefined', undefined],
    ['an array', [validPayload()]],
    ['a string', JSON.stringify(validPayload())],
    ['a number', 7],
  ] as const) {
    it(`rejects ${name}`, () => {
      const result = parseAgentHandoffPayload(value, GUEST_URL);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('payload is not an object');
    });
  }

  it('degrades gracefully when the cosmetic fields are missing', () => {
    const payload = validPayload() as Record<string, unknown>;
    delete payload.label;
    delete payload.summary;
    delete payload.sourceUrl;
    const result = parseAgentHandoffPayload(payload, GUEST_URL);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.label).toBeUndefined();
    expect(result.value.summary).toBeUndefined();
    expect(result.value.sourceUrl).toBeUndefined();
    expect(result.value.suggestedInstruction).toBeTruthy();
  });

  it('drops rather than rejects a wrong-typed cosmetic field', () => {
    const result = parseAgentHandoffPayload(
      validPayload({ label: 99, summary: { nested: true }, sourceUrl: ['/a'] }),
      GUEST_URL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.label).toBeUndefined();
    expect(result.value.summary).toBeUndefined();
    expect(result.value.sourceUrl).toBeUndefined();
  });

  it('trims surrounding whitespace on accepted fields', () => {
    const result = parseAgentHandoffPayload(validPayload({ entityId: '  sol_1  ' }), GUEST_URL);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.entityId).toBe('sol_1');
  });
});

// ── 2. sourceUrl absolutization ────────────────────────────────────────────

describe('absolutizeSourceUrl', () => {
  it('absolutizes a workspace-relative Compass path against the guest origin', () => {
    expect(absolutizeSourceUrl('/rbcodelabs/compass/discovery/opp_1?detail=solution:sol_1', GUEST_URL))
      .toBe('https://compass.rbcodelabs.com/rbcodelabs/compass/discovery/opp_1?detail=solution:sol_1');
  });

  it('accepts an already-absolute https URL unchanged', () => {
    expect(absolutizeSourceUrl('https://compass.rbcodelabs.com/a/b', GUEST_URL))
      .toBe('https://compass.rbcodelabs.com/a/b');
  });

  it('accepts http', () => {
    expect(absolutizeSourceUrl('http://localhost:3000/a', GUEST_URL)).toBe('http://localhost:3000/a');
  });

  for (const hostile of [
    'javascript:alert(document.cookie)',
    'JavaScript:alert(1)',
    'file:///etc/passwd',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
  ]) {
    it(`rejects the non-http(s) scheme in ${hostile.slice(0, 24)}`, () => {
      expect(absolutizeSourceUrl(hostile, GUEST_URL)).toBeUndefined();
    });
  }

  it('rejects a relative path when the guest frame itself is not http(s)', () => {
    expect(absolutizeSourceUrl('/a/b', 'file:///Users/x/index.html')).toBeUndefined();
  });

  it('returns undefined for a missing, blank or unparseable value', () => {
    expect(absolutizeSourceUrl(undefined, GUEST_URL)).toBeUndefined();
    expect(absolutizeSourceUrl(null, GUEST_URL)).toBeUndefined();
    expect(absolutizeSourceUrl('   ', GUEST_URL)).toBeUndefined();
    expect(absolutizeSourceUrl('/a/b', 'not-a-url')).toBeUndefined();
    expect(absolutizeSourceUrl('/a/b', undefined)).toBeUndefined();
  });
});

// ── 3. Prompt + title assembly ─────────────────────────────────────────────

describe('buildHandoffPrompt / buildHandoffTitle', () => {
  it("uses Compass's suggestedInstruction as the spine, verbatim and first", () => {
    const prompt = buildHandoffPrompt(normalized);
    expect(prompt.startsWith('Implement the approved plan.')).toBe(true);
  });

  it('folds in the context block, entity ref and absolutized source URL', () => {
    const prompt = buildHandoffPrompt(normalized);
    expect(prompt).toContain('### Approved plan\n\nStep one.');
    expect(prompt).toContain('Compass entity: solutionPlan `sol_plan_01J9ABCXYZ`');
    expect(prompt).toContain('Source: https://compass.rbcodelabs.com/x');
    expect(prompt).toContain('Approved plan · Handoff');
    expect(prompt).toContain('One line of summary.');
  });

  it('omits the optional lines cleanly when they are absent', () => {
    const prompt = buildHandoffPrompt({
      entityType: 'decision',
      entityId: 'dec_9',
      suggestedInstruction: 'Do the thing.',
      promptBlock: 'Context.',
    });
    expect(prompt).toContain('## Context from Compass');
    expect(prompt).not.toContain('Source:');
    expect(prompt).not.toContain('undefined');
    expect(prompt).toContain('Compass entity: decision `dec_9`');
  });

  it('titles from the Compass label, falling back to the entity type', () => {
    expect(buildHandoffTitle(normalized)).toBe('Approved plan · Handoff');
    expect(buildHandoffTitle({ ...normalized, label: undefined })).toBe('Compass solutionPlan');
  });

  it('keys the handoff on entity identity', () => {
    expect(handoffKey(normalized)).toBe('solutionPlan:sol_plan_01J9ABCXYZ');
  });
});

// ── 4. Debounce ────────────────────────────────────────────────────────────

describe('HandoffDebouncer', () => {
  it('accepts the first event and suppresses a rapid repeat of the same entity', () => {
    let now = 1000;
    const d = new HandoffDebouncer(3000, () => now);
    expect(d.shouldAccept('solutionPlan:a')).toBe(true);
    now = 1050;
    expect(d.shouldAccept('solutionPlan:a')).toBe(false);
  });

  it('lets a different entity through inside the same window', () => {
    let now = 1000;
    const d = new HandoffDebouncer(3000, () => now);
    expect(d.shouldAccept('solutionPlan:a')).toBe(true);
    now = 1050;
    expect(d.shouldAccept('decision:b')).toBe(true);
  });

  it('accepts the same entity again once the window has elapsed', () => {
    let now = 1000;
    const d = new HandoffDebouncer(3000, () => now);
    expect(d.shouldAccept('solutionPlan:a')).toBe(true);
    now = 4000;
    expect(d.shouldAccept('solutionPlan:a')).toBe(true);
  });

  it('prunes expired entries so the map cannot grow unbounded', () => {
    let now = 0;
    const d = new HandoffDebouncer(3000, () => now);
    for (let i = 0; i < 500; i++) { d.shouldAccept(`e:${i}`); now += 10; }
    const internal = (d as unknown as { lastAccepted: Map<string, number> }).lastAccepted;
    expect(internal.size).toBeLessThanOrEqual(301);
  });
});

// ── 5. handleWebViewerEvent — the five edge cases ──────────────────────────

describe('handleWebViewerEvent', () => {
  it('creates exactly one seeded thread and surfaces it for a valid compass handoff', async () => {
    const host = recordingHost();
    const outcome = await handleWebViewerEvent(bridgeEvent(), host, new HandoffDebouncer());

    expect(outcome).toEqual({ kind: 'created', threadId: 'thread-1' });
    expect(host.prompts).toHaveLength(1);
    expect(host.surfaced).toEqual(['thread-1']);
    expect(host.notices).toEqual([]);
    expect(host.titles[0]).toBe('Approved plan · Compass → Geode agent handoff');
    expect(host.prompts[0]).toContain('Implement the approved plan "Compass → Geode agent handoff".');
    expect(host.prompts[0]).toContain('Compass entity: solutionPlan `sol_plan_01J9ABCXYZ`');
    // sourceUrl arrived relative and must be clickable in the seed.
    expect(host.prompts[0]).toContain(
      'Source: https://compass.rbcodelabs.com/rbcodelabs/compass/discovery/opp_01J9ABC?detail=solution:sol_01J9XYZ',
    );
  });

  // Edge case 3 — unrelated events on the same bus.
  for (const [name, ev] of [
    ['a different connector', bridgeEvent({ source: 'some-other-connector' })],
    ['a spoofed-looking empty source', bridgeEvent({ source: '' })],
    ['a different event type on the compass connector', bridgeEvent({ type: 'something.else' })],
    ['a non-object event', 'not-an-event' as unknown as WebViewerBridgeEvent],
    ['null', null as unknown as WebViewerBridgeEvent],
    ['an envelope with no source/type', { payload: validPayload() } as unknown as WebViewerBridgeEvent],
  ] as const) {
    it(`ignores ${name} with zero side effects`, async () => {
      const host = recordingHost();
      const outcome = await handleWebViewerEvent(ev, host, new HandoffDebouncer());
      expect(outcome).toEqual({ kind: 'ignored' });
      expect(host.prompts).toEqual([]);
      expect(host.surfaced).toEqual([]);
      expect(host.notices).toEqual([]);
    });
  }

  // Edge case 5 — decision.approved is explicitly out of scope.
  it('ignores decision.approved on the compass connector (explicitly out of scope)', async () => {
    const host = recordingHost();
    const outcome = await handleWebViewerEvent(
      bridgeEvent({ type: 'decision.approved', payload: { decisionId: 'dec_1' } }),
      host,
      new HandoffDebouncer(),
    );
    expect(outcome).toEqual({ kind: 'ignored' });
    expect(host.prompts).toEqual([]);
    expect(host.notices).toEqual([]);
  });

  // Edge case 1 — malformed payloads.
  for (const [name, payload] of [
    ['null', null],
    ['a non-object', 'nope'],
    ['an array', []],
    ['the provisional (never-shipped) Compass shape', {
      instruction: 'do it', contextLabel: 'Plan', url: '/a', title: 'T',
    }],
    ['a payload with a missing instruction', (() => {
      const p = validPayload() as Record<string, unknown>;
      delete p.suggestedInstruction;
      return p;
    })()],
    ['a payload with wrong-typed load-bearing fields', validPayload({ entityId: 12, promptBlock: null })],
  ] as const) {
    it(`fails visibly with a notice and creates no thread for ${name}`, async () => {
      const host = recordingHost();
      const outcome = await handleWebViewerEvent(bridgeEvent({ payload }), host, new HandoffDebouncer());
      expect(outcome.kind).toBe('malformed');
      expect(host.prompts).toEqual([]);
      expect(host.surfaced).toEqual([]);
      expect(host.notices).toHaveLength(1);
      expect(host.notices[0]).toContain('Compass handoff ignored');
    });
  }

  // Edge case 2 — duplicate / rapid events.
  it('collapses a double-clicked Send to Agent into exactly one thread', async () => {
    const host = recordingHost();
    let now = 5000;
    const debouncer = new HandoffDebouncer(3000, () => now);

    const first = await handleWebViewerEvent(bridgeEvent(), host, debouncer);
    now = 5120; // second click, 120ms later
    const second = await handleWebViewerEvent(bridgeEvent({ timestamp: 1 }), host, debouncer);

    expect(first.kind).toBe('created');
    expect(second).toEqual({ kind: 'duplicate', key: 'solutionPlan:sol_plan_01J9ABCXYZ' });
    expect(host.prompts).toHaveLength(1);
    expect(host.surfaced).toHaveLength(1);
  });

  it('still handles a different entity sent immediately after', async () => {
    const host = recordingHost();
    let now = 5000;
    const debouncer = new HandoffDebouncer(3000, () => now);

    await handleWebViewerEvent(bridgeEvent(), host, debouncer);
    now = 5120;
    const second = await handleWebViewerEvent(
      bridgeEvent({ payload: validPayload({ entityType: 'decision', entityId: 'dec_42' }) }),
      host,
      debouncer,
    );
    expect(second.kind).toBe('created');
    expect(host.prompts).toHaveLength(2);
  });

  it('accepts a deliberate re-send of the same entity after the window', async () => {
    const host = recordingHost();
    let now = 5000;
    const debouncer = new HandoffDebouncer(3000, () => now);
    await handleWebViewerEvent(bridgeEvent(), host, debouncer);
    now = 9000;
    const again = await handleWebViewerEvent(bridgeEvent(), host, debouncer);
    expect(again.kind).toBe('created');
    expect(host.prompts).toHaveLength(2);
  });

  // Edge case 4 — event arrives before thread infrastructure is up.
  it('drops with a notice, and does not throw, when the thread manager is not ready', async () => {
    const host = recordingHost({ ready: false });
    const outcome = await handleWebViewerEvent(bridgeEvent(), host, new HandoffDebouncer());
    expect(outcome).toEqual({ kind: 'not-ready' });
    expect(host.prompts).toEqual([]);
    expect(host.surfaced).toEqual([]);
    expect(host.notices[0]).toContain('still starting up');
  });

  it('does not burn the debounce slot on a not-ready drop, so the invited retry works', async () => {
    let ready = false;
    let now = 1000;
    const prompts: string[] = [];
    const host: HandoffHost = {
      isReady: () => ready,
      dispatchThread: async (prompt) => { prompts.push(prompt); return 'thread-1'; },
      surfaceThread: async () => {},
      notify: () => {},
    };
    const debouncer = new HandoffDebouncer(3000, () => now);

    expect((await handleWebViewerEvent(bridgeEvent(), host, debouncer)).kind).toBe('not-ready');
    ready = true;
    now = 1100; // well inside the debounce window
    expect((await handleWebViewerEvent(bridgeEvent(), host, debouncer)).kind).toBe('created');
    expect(prompts).toHaveLength(1);
  });

  // The handler must never throw — an exception escaping a workspace listener
  // poisons Geode's event bus for every other subscriber.
  it('swallows a dispatch failure into a notice instead of throwing', async () => {
    const host = recordingHost({ dispatch: () => Promise.reject(new Error('manager exploded')) });
    const outcome = await handleWebViewerEvent(bridgeEvent(), host, new HandoffDebouncer());
    expect(outcome).toEqual({ kind: 'failed', reason: 'manager exploded' });
    expect(host.surfaced).toEqual([]);
    expect(host.notices[0]).toContain('manager exploded');
  });

  it('does not throw even when the host itself throws from every callback', async () => {
    const exploding: HandoffHost = {
      isReady: () => { throw new Error('boom-ready'); },
      dispatchThread: () => { throw new Error('boom-dispatch'); },
      surfaceThread: () => { throw new Error('boom-surface'); },
      notify: () => { throw new Error('boom-notify'); },
    };
    await expect(handleWebViewerEvent(bridgeEvent(), exploding, new HandoffDebouncer()))
      .resolves.toMatchObject({ kind: 'failed' });
  });
});

// ── 5b. Driven through a synthetic Obsidian-shaped workspace bus ───────────

/**
 * Minimal stand-in for Obsidian's `Events` + `Component.registerEvent`.
 *
 * This reproduces the *contract* the plugin relies on (subscribe, trigger,
 * offref on unload); it is not Obsidian itself. See the test file header for
 * what remains unverified.
 */
class FakeBus {
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  on(name: string, cb: (...args: unknown[]) => void): { name: string; cb: (...args: unknown[]) => void } {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(cb);
    return { name, cb };
  }
  offref(ref: { name: string; cb: (...args: unknown[]) => void }): void {
    this.handlers.get(ref.name)?.delete(ref.cb);
  }
  trigger(name: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(name) ?? []) cb(...args);
  }
  count(name: string): number {
    return this.handlers.get(name)?.size ?? 0;
  }
}

class FakePlugin {
  private refs: Array<{ name: string; cb: (...args: unknown[]) => void }> = [];
  readonly debouncer = new HandoffDebouncer();
  readonly inflight: Array<Promise<unknown>> = [];

  constructor(private readonly bus: FakeBus, private readonly host: HandoffHost) {}

  load(): void {
    this.registerEvent(this.bus.on(WEB_VIEWER_EVENT_NAME, (ev) => {
      this.inflight.push(handleWebViewerEvent(ev, this.host, this.debouncer));
    }));
  }
  private registerEvent(ref: { name: string; cb: (...args: unknown[]) => void }): void {
    this.refs.push(ref);
  }
  unload(): void {
    for (const ref of this.refs) this.bus.offref(ref);
    this.refs = [];
  }
  settle(): Promise<unknown[]> { return Promise.all(this.inflight); }
}

describe('receiver driven through a synthetic workspace bus', () => {
  it('turns one triggered agent.handoff into one seeded, surfaced thread', async () => {
    const bus = new FakeBus();
    const host = recordingHost();
    const plugin = new FakePlugin(bus, host);
    plugin.load();

    bus.trigger(WEB_VIEWER_EVENT_NAME, bridgeEvent());
    await plugin.settle();

    expect(host.prompts).toHaveLength(1);
    expect(host.surfaced).toEqual(['thread-1']);
  });

  it('leaks no listener across a disable/enable cycle', async () => {
    const bus = new FakeBus();
    const host = recordingHost();

    const first = new FakePlugin(bus, host);
    first.load();
    expect(bus.count(WEB_VIEWER_EVENT_NAME)).toBe(1);

    first.unload();
    expect(bus.count(WEB_VIEWER_EVENT_NAME)).toBe(0);

    // An event arriving while disabled must do nothing at all.
    bus.trigger(WEB_VIEWER_EVENT_NAME, bridgeEvent());
    await first.settle();
    expect(host.prompts).toEqual([]);

    // Re-enable: exactly one listener, and exactly one thread per event.
    const second = new FakePlugin(bus, host);
    second.load();
    expect(bus.count(WEB_VIEWER_EVENT_NAME)).toBe(1);
    bus.trigger(WEB_VIEWER_EVENT_NAME, bridgeEvent());
    await second.settle();
    expect(host.prompts).toHaveLength(1);
  });

  it('a re-enabled plugin is not still debouncing handoffs from the old instance', async () => {
    const bus = new FakeBus();
    const host = recordingHost();

    const first = new FakePlugin(bus, host);
    first.load();
    bus.trigger(WEB_VIEWER_EVENT_NAME, bridgeEvent());
    await first.settle();
    first.unload();

    const second = new FakePlugin(bus, host);
    second.load();
    bus.trigger(WEB_VIEWER_EVENT_NAME, bridgeEvent());
    await second.settle();

    expect(host.prompts).toHaveLength(2);
  });

  it('never lets an exception escape into the bus and break other subscribers', async () => {
    const bus = new FakeBus();
    const exploding: HandoffHost = {
      isReady: () => { throw new Error('boom'); },
      dispatchThread: async () => 'x',
      surfaceThread: async () => {},
      notify: () => {},
    };
    const plugin = new FakePlugin(bus, exploding);
    plugin.load();

    const otherSubscriber = vi.fn();
    bus.on(WEB_VIEWER_EVENT_NAME, otherSubscriber);

    expect(() => bus.trigger(WEB_VIEWER_EVENT_NAME, bridgeEvent())).not.toThrow();
    await plugin.settle();
    expect(otherSubscriber).toHaveBeenCalledTimes(1);
  });
});

// ── 6. Source guard on main.ts wiring ──────────────────────────────────────

describe('main.ts wiring (source guard)', () => {
  const mainSrc = readFileSync(resolve(__dirname, '../../src/main.ts'), 'utf8');

  function bodyOf(methodName: string): string {
    const start = mainSrc.indexOf(`private async ${methodName}(`);
    expect(start, `${methodName} not found in main.ts`).toBeGreaterThan(-1);
    // Each onload* method is followed by the next `private async onload*` or
    // the class's next top-level method; slice to the next one found.
    const rest = mainSrc.slice(start + 1);
    const nextIdx = rest.search(/\n {2}(private |public )?async onload/);
    return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
  }

  it('registers the web-viewer listener inside onloadDesktop, via registerEvent', () => {
    const desktop = bodyOf('onloadDesktop');
    expect(desktop).toContain('WEB_VIEWER_EVENT_NAME');
    expect(desktop).toContain('handleWebViewerEvent');
    // The `on(...)` call must be wrapped in registerEvent so Obsidian tears the
    // subscription down on unload.
    expect(desktop).toMatch(/this\.registerEvent\(\s*\(this\.app\.workspace\.on as/);
  });

  it('does not register it on the mobile path', () => {
    const mobile = bodyOf('onloadMobile');
    // Prove the slice really is the mobile body before asserting an absence.
    expect(mobile).toContain('MOBILE_VIEW_TYPE');
    expect(mobile).not.toContain('WEB_VIEWER_EVENT_NAME');
  });

  it('slices onloadDesktop to a body that excludes the mobile path', () => {
    const desktop = bodyOf('onloadDesktop');
    expect(desktop).toContain('ContextPanelController');
    expect(desktop).not.toContain('MOBILE_VIEW_TYPE');
  });

  it('owns the debouncer on the plugin instance so it dies with the plugin', () => {
    expect(mainSrc).toMatch(/private readonly compassHandoffDebouncer = new HandoffDebouncer\(\)/);
  });

  it('surfaces the created thread rather than leaving it in the background', () => {
    expect(mainSrc).toMatch(/surfaceThread: \(threadId\) => this\.openThreadInChatView\(threadId\)/);
  });
});

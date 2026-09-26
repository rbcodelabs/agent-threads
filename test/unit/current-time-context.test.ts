/**
 * Every turn tells the agent the current local time, IANA time zone and UTC
 * offset in one short line, as its own content item.
 *
 * Live QA: sessions only had Claude Code's session-start date line, so the
 * Chief of Staff pack invented timestamps (T00:10:00+00:00 when it was 16:11
 * -04:00) and ran Bash just to read the time zone. A session can live for
 * days, so the line is added per turn, not once at session start.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';

// Pin a DST-observing zone before anything formats a Date.
const originalTZ = vi.hoisted(() => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  return previous;
});
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const never = new Promise<never>(() => {});
    return {
      [Symbol.asyncIterator]: () => ({ next: () => never }),
      close: () => {}, interrupt: async () => {}, supportedModels: async () => [], supportedAgents: async () => [],
      getContextUsage: async () => null, setPermissionMode: async () => {}, setModel: async () => {},
    };
  },
}));

const { formatCurrentTimeContext, shouldAddCurrentTimeContext } = await import('../../src/currentTimeContext');
const { ThreadSession } = await import('../../src/ThreadSession');
const { CodexSession } = await import('../../src/CodexSession');
const { OpenCodeSession } = await import('../../src/OpenCodeSession');

const FRI = new Date('2026-09-25T16:11:42-04:00');
const FRI_LINE = '[Current local time: 2026-09-25T16:11-04:00 (Friday), time zone America/New_York]';

afterEach(() => { vi.useRealTimers(); });

function at(date: Date) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(date);
}

describe('formatCurrentTimeContext', () => {
  it('gives local date+time with UTC offset, weekday and IANA zone in one line', () => {
    expect(formatCurrentTimeContext(FRI, 'America/New_York')).toBe(FRI_LINE);
    expect(formatCurrentTimeContext(FRI, 'America/New_York')).not.toContain('\n');
  });

  it('tracks the offset across DST', () => {
    expect(formatCurrentTimeContext(new Date('2026-01-15T09:05:00-05:00'), 'America/New_York'))
      .toBe('[Current local time: 2026-01-15T09:05-05:00 (Thursday), time zone America/New_York]');
  });

  it('formats UTC and half-hour offsets', () => {
    const utc = new Date('2026-09-25T12:00:00Z');
    vi.spyOn(utc, 'getTimezoneOffset').mockReturnValue(0);
    expect(formatCurrentTimeContext(utc, 'UTC')).toMatch(/\+00:00 \(/);
    const india = new Date('2026-09-25T12:00:00Z');
    vi.spyOn(india, 'getTimezoneOffset').mockReturnValue(-330);
    expect(formatCurrentTimeContext(india, 'Asia/Kolkata')).toMatch(/\+05:30 \(/);
  });

  it('defaults to now and the resolved IANA zone', () => {
    at(FRI);
    expect(formatCurrentTimeContext()).toBe(FRI_LINE);
  });
});

describe('shouldAddCurrentTimeContext', () => {
  it('skips slash-command turns, which the CLI recognises only as the whole prompt', () => {
    expect(shouldAddCurrentTimeContext('Plan my day')).toBe(true);
    expect(shouldAddCurrentTimeContext('/create-pr --draft')).toBe(false);
    expect(shouldAddCurrentTimeContext('  /compact')).toBe(false);
  });
});

function callbacks(): SessionCallbacks {
  return {
    onToken: () => {}, onToolUse: () => {}, onMessage: () => {}, onRecap: () => {}, onDone: () => {},
    onInterrupted: () => {}, onError: () => {}, onPermissionRequest: async () => true,
    onAskUserQuestion: async () => ({}), onOpenNewTab: async () => ({ threadId: '', title: '' }),
  };
}

describe('Claude (ThreadSession) sends the clock as its own text block, per turn', () => {
  async function started() {
    const session = new ThreadSession('/fake/claude');
    await session.start({ claudePath: '/fake/claude', cwd: '/tmp', permissionMode: 'default', extraEnvRaw: '', callbacks: callbacks() });
    const pushed: Array<{ message: { content: unknown } }> = [];
    vi.spyOn(session as unknown as { pushToChannel: (m: unknown) => void }, 'pushToChannel')
      .mockImplementation((m) => { pushed.push(m as { message: { content: unknown } }); });
    return { session, pushed };
  }

  it('user text stays first and unmodified; the clock is a separate block with the time of that turn', async () => {
    const { session, pushed } = await started();
    at(FRI);
    session.send('What is on today?');
    at(new Date('2026-09-28T08:02:00-04:00'));
    (session as unknown as { _turnInFlight: boolean })._turnInFlight = false;
    session.send('And now?');
    session.close();

    expect(pushed[0]!.message.content).toEqual([
      { type: 'text', text: 'What is on today?' },
      { type: 'text', text: FRI_LINE },
    ]);
    expect(pushed[1]!.message.content).toEqual([
      { type: 'text', text: 'And now?' },
      { type: 'text', text: '[Current local time: 2026-09-28T08:02-04:00 (Monday), time zone America/New_York]' },
    ]);
  });

  it('keeps images between the user text and the clock', async () => {
    const { session, pushed } = await started();
    at(FRI);
    session.send('look', [{ mediaType: 'image/png', base64: 'AAAA' } as never]);
    session.close();
    const content = pushed[0]!.message.content as Array<{ type: string }>;
    expect(content.map(b => b.type)).toEqual(['text', 'image', 'text']);
    expect(content[2]).toEqual({ type: 'text', text: FRI_LINE });
  });

  it('leaves a slash command as a plain string', async () => {
    const { session, pushed } = await started();
    session.send('/create-pr');
    session.close();
    expect(pushed[0]!.message.content).toBe('/create-pr');
  });
});

describe('Codex sends the clock as its own input item', () => {
  function codex() {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.closed = false;
    internal.codexThreadId = 'codex-thread';
    internal.options = { permissionMode: 'default', callbacks: { onError: vi.fn(), onDone: vi.fn() } };
    const request = vi.spyOn(internal, 'request').mockResolvedValue({ turn: { id: 'turn-1' } });
    return { session, request };
  }

  it('adds a text item after the user input', () => {
    const { session, request } = codex();
    at(FRI);
    session.send('What is on today?');
    const [, params] = request.mock.calls.find(([method]) => method === 'turn/start')!;
    expect((params as { input: unknown[] }).input).toEqual([
      { type: 'text', text: 'What is on today?', text_elements: [] },
      { type: 'text', text: FRI_LINE, text_elements: [] },
    ]);
  });

  it('leaves a slash-command turn alone', () => {
    const { session, request } = codex();
    session.send('/status');
    const [, params] = request.mock.calls.find(([method]) => method === 'turn/start')!;
    expect((params as { input: unknown[] }).input).toEqual([{ type: 'text', text: '/status', text_elements: [] }]);
  });
});

describe('OpenCode sends the clock as its own text part', () => {
  it('adds a plain text part after the user parts', async () => {
    const requests: Array<{ path: string; body?: any }> = [];
    const transport = {
      request: vi.fn(async (method: string, path: string, body?: unknown) => {
        requests.push({ path, body });
        if (method === 'POST' && path === '/session') return { status: 200, body: { id: 'ses' } };
        if (path === '/config/providers') return { status: 200, body: { providers: [] } };
        if (path.endsWith('/prompt_async')) return { status: 204, body: undefined };
        return { status: 200, body: true };
      }),
      subscribe: () => {},
      close: vi.fn(),
    };
    const session = new OpenCodeSession('/bin/opencode', async () => transport as never);
    await session.start({ cwd: '/work', permissionMode: 'default', extraEnvRaw: '', callbacks: callbacks() } as never);
    at(FRI);
    session.send('hello');
    const prompt = requests.find(r => r.path === '/session/ses/prompt_async')!;
    expect(prompt.body.parts).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: FRI_LINE },
    ]);
    session.close();
  });
});

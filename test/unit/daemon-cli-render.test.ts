import { describe, expect, it } from 'vitest';
import type { EventFrame, ResyncFrame } from '../../src/protocol';
import { cliLine, frameLine, oneLine, safeText, TextRenderer } from '../../daemon/cmd/render';
import { expectGolden } from '../helpers/golden';

let seq = 0;
const ev = (name: string, args: unknown, extra: object = {}): EventFrame =>
  ({ v: 1, ch: 't:demo', seq: ++seq, ts: 1_700_000_000_000 + seq, type: 'event', name, args, ...extra }) as unknown as EventFrame;

/** A fixed conversation covering every rendered event kind. */
function conversation(): EventFrame[] {
  seq = 0;
  return [
    ev('session.state', { turnInFlight: true, hasPendingPermission: false, hostAttached: false }),
    ev('onToken', ['Let me '], { replay: true }),
    ev('onToken', ['look.\n']),
    ev('onMessage', ['Let me look.\n', []]),
    ev('onToolUse', [{ name: 'Bash', summary: 'ls -la\u001b[31m /srv', toolUseId: 't1' }]),
    ev('onToolResult', ['t1', 'error', 40]),
    ev('permission_request', { requestId: 'r-1', toolName: 'Bash', detail: 'rm -rf build\nand more' }),
    ev('question_request', { requestId: 'r-2', questions: [{ question: 'Which env?', header: 'Env', options: [{ label: 'dev', description: 'safe' }, { label: 'prod', description: '' }], multiSelect: false }] }),
    ev('plan_ready', { requestId: 'r-3', planText: '1. one\n2. two' }),
    ev('elicitation_request', { requestId: 'r-4', request: { message: 'need a value' } }),
    ev('request_resolved', { requestId: 'r-1', by: 'tok1', outcome: 'resolved' }),
    ev('onPermissionDenied', ['Write', 'u1', 'denied by mode']),
    ev('onMessage', ['All done, no streaming for this one.', []]),
    ev('onError', [{ name: 'Error', message: 'boom' }]),
    ev('onInterrupted', ['s1']),
    ev('onDone', ['s1', 0.01234, 3]),
    ev('session.state', { turnInFlight: false, hasPendingPermission: false, hostAttached: false, closed: 'idle' }),
    ev('onUsage', [{ tokens: 1 }]),
  ];
}

describe('TextRenderer', () => {
  it('golden: text transcript', () => {
    let out = '';
    const r = new TextRenderer({ write: (s) => { out += s; } });
    for (const f of conversation()) r.event(f);
    expectGolden('cli/render.text.txt', out);
  });

  it('does not repeat streamed text when the final message arrives', () => {
    let out = '';
    const r = new TextRenderer({ write: (s) => { out += s; } });
    r.event(ev('onToken', ['abc']));
    r.event(ev('onMessage', ['abc', []]));
    expect(out).toBe('abc\n');
  });

  it('renders a resync checkpoint', () => {
    let out = '';
    const r = new TextRenderer({ write: (s) => { out += s; } });
    const frame = {
      v: 1, ch: 't:demo', seq: 9, ts: 1, type: 'resync',
      checkpoint: { seq: 9, ts: 1, inFlightText: 'partial', openRequests: [], state: null, recentMessages: [{ seq: 8, ts: 1, event: { name: 'onMessage', args: ['earlier answer', []] } }] },
    } as unknown as ResyncFrame;
    r.resync(frame);
    expect(out).toBe('[resync] the daemon no longer holds the history before seq 9; showing its checkpoint\nearlier answer\npartial');
  });
});

describe('--json lines', () => {
  it('golden: frames pass through verbatim and CLI records are namespaced', () => {
    const lines = [
      cliLine('attached', { threadId: 'demo', controller: false, lastSeq: 17, lowWater: 0, resync: false, epoch: 'e1' }),
      ...conversation().slice(0, 4).map(frameLine),
      cliLine('command_result', { cmd: 'resolve.permission', requestId: 'r-1', ok: false, error: 'already answered by another client' }),
      cliLine('end', { outcome: 'done', exitCode: 0, lastSeq: 17 }),
    ];
    expectGolden('cli/attach.ndjson', `${lines.join('\n')}\n`);
    for (const l of lines) expect(JSON.parse(l)).toHaveProperty('type');
  });
});

describe('terminal safety', () => {
  it('strips control sequences from agent text and flattens tool summaries', () => {
    expect(safeText('a\u001b[2Jb\tc\nd')).toBe('a[2Jb\tc\nd');
    expect(oneLine('x\u001b]0;title\u0007\ny', 50)).toBe('x ]0;title y');
    expect(oneLine('x'.repeat(300), 20)).toHaveLength(20);
  });
});

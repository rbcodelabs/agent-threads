import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  CALLBACK_DISPOSITION,
  NOT_ON_WIRE,
  OVERRIDES,
  SESSION_OPTION_DISPOSITION,
  toWireError,
  type SessionEvent,
} from '../../src/protocol';

const root = resolve(__dirname, '../..');

/** Member names of an interface or type literal, read from source (types are erased at runtime). */
function interfaceKeys(file: string, name: string): string[] {
  const text = readFileSync(resolve(root, file), 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const keys: string[] = [];
  sf.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      for (const m of node.members) {
        if (ts.isPropertySignature(m) || ts.isMethodSignature(m)) keys.push((m.name as ts.Identifier).text);
      }
    }
  });
  return keys;
}

describe('SessionCallbacks -> wire drift', () => {
  const callbackKeys = interfaceKeys('src/ClaudeSession.ts', 'SessionCallbacks');

  it('finds the callbacks (guards the parser itself)', () => {
    expect(callbackKeys.length).toBeGreaterThan(40);
    expect(callbackKeys).toContain('onToken');
    expect(callbackKeys).toContain('onElicitation');
  });

  it('every SessionCallbacks key is mapped or listed in NOT_ON_WIRE', () => {
    const notOnWire = new Set<string>(NOT_ON_WIRE);
    const mapped = new Set(Object.keys(CALLBACK_DISPOSITION).filter((k) => CALLBACK_DISPOSITION[k as keyof typeof CALLBACK_DISPOSITION] !== 'not_on_wire'));
    const unclassified = callbackKeys.filter((k) => !mapped.has(k) && !notOnWire.has(k));
    expect(unclassified, 'new SessionCallbacks keys need an entry in sessionEvents.ts (CALLBACK_DISPOSITION / NOT_ON_WIRE)').toEqual([]);
  });

  it('has no stale entries for callbacks that no longer exist', () => {
    const known = new Set(callbackKeys);
    expect(Object.keys(CALLBACK_DISPOSITION).filter((k) => !known.has(k))).toEqual([]);
    expect(NOT_ON_WIRE.filter((k) => !known.has(k))).toEqual([]);
  });

  it('keeps NOT_ON_WIRE and the disposition table in agreement', () => {
    const fromTable = Object.entries(CALLBACK_DISPOSITION).filter(([, d]) => d === 'not_on_wire').map(([k]) => k).sort();
    expect([...NOT_ON_WIRE].sort()).toEqual(fromTable);
    expect(NOT_ON_WIRE).toContain('onRawEvent');
  });

  it('turns exactly the blocking / non-serializable callbacks into request pairs', () => {
    const requests = Object.entries(CALLBACK_DISPOSITION).filter(([, d]) => d === 'request').map(([k]) => k).sort();
    expect(requests).toEqual(Object.keys(OVERRIDES).sort());
    expect(requests).toEqual(['onAskUserQuestion', 'onElicitation', 'onOpenNewTab', 'onPermissionRequest', 'onPlanReady']);
  });

  it('gives every request a distinct wire event and resolve command', () => {
    const events = Object.values(OVERRIDES).map((o) => o.event);
    const resolves = Object.values(OVERRIDES).map((o) => o.resolve);
    expect(new Set(events).size).toBe(events.length);
    expect(new Set(resolves).size).toBe(resolves.length);
  });
});

describe('RemoteSessionSpec drift', () => {
  const optionKeys = interfaceKeys('src/HarnessSession.ts', 'HarnessSessionOptions');

  it('classifies every HarnessSessionOptions field', () => {
    expect(optionKeys.sort()).toEqual(Object.keys(SESSION_OPTION_DISPOSITION).sort());
  });

  it('never carries callbacks or secret values', () => {
    const omitted = Object.entries(SESSION_OPTION_DISPOSITION).filter(([, d]) => d === 'omitted').map(([k]) => k).sort();
    expect(omitted).toEqual(['callbacks', 'secretEnv']);
  });
});

describe('SessionEvent typing (checked by tsc)', () => {
  it('derives args from callback parameters and replaces non-serializable ones', () => {
    const events: SessionEvent[] = [
      { name: 'onDone', args: ['sid', 0.5, 3] },
      { name: 'onError', args: [{ name: 'Error', message: 'boom' }] }, // Error -> WireError
      { name: 'permission_request', args: { requestId: 'R', toolName: 'Bash', detail: 'ls' } },
      { name: 'plan_ready', args: { requestId: 'P', planText: '# plan' } },
    ];
    // @ts-expect-error onToken takes a string, not a number
    const wrong: SessionEvent = { name: 'onToken', args: [1] };
    expect(events).toHaveLength(4);
    expect(wrong.name).toBe('onToken');
    expect(toWireError(new TypeError('x'))).toMatchObject({ name: 'TypeError', message: 'x' });
  });
});

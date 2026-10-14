import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_SCRIPT_ENV, createHarnessSession } from '../../src/HarnessFactory';
import { ReplaySession } from '../../src/ReplaySession';
import { ThreadSession } from '../../src/ThreadSession';
import { CodexSession } from '../../src/CodexSession';
import { DEFAULT_SETTINGS, type Thread } from '../../src/types';

const thread = (agentHarness?: Thread['agentHarness']) => ({ id: 't', agentHarness }) as Thread;
const dirs: string[] = [];

function scriptFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  dirs.push(dir);
  const file = path.join(dir, 'script.json');
  fs.writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('createHarnessSession demo gating', () => {
  it('is inert without the env var', () => {
    expect(createHarnessSession(thread(), DEFAULT_SETTINGS, {})).toBeInstanceOf(ThreadSession);
    expect(createHarnessSession(thread('claude'), DEFAULT_SETTINGS, {})).toBeInstanceOf(ThreadSession);
  });

  it('treats an empty env var as unset', () => {
    expect(createHarnessSession(thread(), DEFAULT_SETTINGS, { [DEMO_SCRIPT_ENV]: '' })).toBeInstanceOf(ThreadSession);
  });

  it('returns a ReplaySession for Claude threads when the env var names a script', () => {
    const file = scriptFile(JSON.stringify({ version: 1, turns: [] }));
    expect(createHarnessSession(thread(), DEFAULT_SETTINGS, { [DEMO_SCRIPT_ENV]: file })).toBeInstanceOf(ReplaySession);
    expect(createHarnessSession(thread('claude'), DEFAULT_SETTINGS, { [DEMO_SCRIPT_ENV]: file })).toBeInstanceOf(ReplaySession);
  });

  it('never replaces other harnesses', () => {
    const file = scriptFile(JSON.stringify({ version: 1, turns: [] }));
    expect(createHarnessSession(thread('codex'), DEFAULT_SETTINGS, { [DEMO_SCRIPT_ENV]: file })).toBeInstanceOf(CodexSession);
  });

  it('fails loudly for a missing or invalid script instead of silently going live', () => {
    expect(() => createHarnessSession(thread(), DEFAULT_SETTINGS, { [DEMO_SCRIPT_ENV]: '/nonexistent/script.json' })).toThrow();
    const bad = scriptFile(JSON.stringify({ version: 9, turns: [] }));
    expect(() => createHarnessSession(thread(), DEFAULT_SETTINGS, { [DEMO_SCRIPT_ENV]: bad })).toThrow(/version: must be 1/);
  });
});

/**
 * Chief of Staff first-run onboarding (spec §10).
 *
 * Covers the pure decision module: which first-run path a load takes (new vs
 * upgrading install, setting on/off), whether the skill source is already
 * present, the clone/harness/thread failure fallbacks, and the "Set up Chief of
 * Staff" command's idempotency. No Obsidian App is constructed — every side
 * effect is an injected dependency.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CHIEF_OF_STAFF_REPO_URL,
  CHIEF_OF_STAFF_SETUP_PROMPT,
  CHIEF_OF_STAFF_THREAD_TITLE,
  CHIEF_OF_STAFF_COMMAND_NAME,
  decideFirstRun,
  findChiefOfStaffThreadId,
  hasSkillSourceForRepo,
  isBinaryResolvable,
  setUpChiefOfStaff,
  withChiefOfStaffPointer,
  type ChiefOfStaffDeps,
} from '../../src/chiefOfStaffOnboarding';
import { DEFAULT_SETTINGS, type SkillSource } from '../../src/types';
import { mergePersistedSettings } from '../../src/productIdentity';

function makeDeps(overrides: Partial<ChiefOfStaffDeps> & { threads?: { id: string; title: string }[]; sources?: SkillSource[]; storedId?: string } = {}) {
  const threads = overrides.threads ?? [];
  const sources = overrides.sources ?? [];
  let storedId = overrides.storedId;
  let counter = 0;
  const deps: ChiefOfStaffDeps = {
    getSkillSources: () => sources,
    addGithubSkillSource: vi.fn(async (repoUrl: string) => {
      sources.push({ id: 'gh-x', name: 'Chief of Staff', type: 'github', repoUrl, clonePath: '/tmp/x' });
    }),
    isHarnessReady: () => true,
    listThreads: () => threads,
    getStoredThreadId: () => storedId,
    setStoredThreadId: vi.fn((id: string | undefined) => { storedId = id; }),
    createThread: vi.fn((title: string) => {
      const thread = { id: `t${++counter}`, title };
      threads.push(thread);
      return thread;
    }),
    sendPrompt: vi.fn(),
    openThread: vi.fn(async () => undefined),
    saveSettings: vi.fn(async () => undefined),
    ...overrides,
  };
  return { deps, threads, sources, getStoredId: () => storedId };
}

describe('constants', () => {
  it('points at the public pack repo and invokes cos-setup', () => {
    expect(CHIEF_OF_STAFF_REPO_URL).toBe('https://github.com/rbcodelabs/chief-of-staff');
    expect(CHIEF_OF_STAFF_THREAD_TITLE).toBe('Chief of Staff');
    expect(CHIEF_OF_STAFF_SETUP_PROMPT).toMatch(/cos-setup/);
    expect(CHIEF_OF_STAFF_COMMAND_NAME).toBe('Set up Chief of Staff');
  });
});

describe('settings defaults', () => {
  it('offers Chief of Staff on first run by default and has no home thread yet', () => {
    expect(DEFAULT_SETTINGS.offerChiefOfStaffOnFirstRun).toBe(true);
    expect(DEFAULT_SETTINGS.chiefOfStaffThreadId).toBeUndefined();
  });

  it('keeps a persisted opt-out and home thread id through mergePersistedSettings', () => {
    const merged = mergePersistedSettings(DEFAULT_SETTINGS, { offerChiefOfStaffOnFirstRun: false, chiefOfStaffThreadId: 'abc' });
    expect(merged.offerChiefOfStaffOnFirstRun).toBe(false);
    expect(merged.chiefOfStaffThreadId).toBe('abc');
  });

  it('fills the new default for settings saved before this field existed', () => {
    const merged = mergePersistedSettings(DEFAULT_SETTINGS, { hasSeenWelcome: true });
    expect(merged.offerChiefOfStaffOnFirstRun).toBe(true);
  });
});

describe('decideFirstRun', () => {
  it('does nothing once the welcome has been seen', () => {
    expect(decideFirstRun({ hasSeenWelcome: true, threadCount: 0, offerChiefOfStaff: true })).toBe('none');
  });

  it('silently marks upgrading users (existing threads) as seen', () => {
    expect(decideFirstRun({ hasSeenWelcome: false, threadCount: 3, offerChiefOfStaff: true })).toBe('mark-seen');
    expect(decideFirstRun({ hasSeenWelcome: false, threadCount: 3, offerChiefOfStaff: false })).toBe('mark-seen');
  });

  it('offers Chief of Staff to brand-new installs when the setting is on', () => {
    expect(decideFirstRun({ hasSeenWelcome: false, threadCount: 0, offerChiefOfStaff: true })).toBe('chief-of-staff');
  });

  it('falls back to the static guide when the setting is off', () => {
    expect(decideFirstRun({ hasSeenWelcome: false, threadCount: 0, offerChiefOfStaff: false })).toBe('static-guide');
  });
});

describe('hasSkillSourceForRepo', () => {
  const src = (repoUrl?: string, type: 'github' | 'local' = 'github'): SkillSource => ({ id: 'a', name: 'a', type, repoUrl });

  it('is false with no sources', () => {
    expect(hasSkillSourceForRepo([], CHIEF_OF_STAFF_REPO_URL)).toBe(false);
    expect(hasSkillSourceForRepo(undefined, CHIEF_OF_STAFF_REPO_URL)).toBe(false);
  });

  it('matches regardless of case, .git suffix, trailing slash or protocol', () => {
    expect(hasSkillSourceForRepo([src('https://github.com/rbcodelabs/chief-of-staff')], CHIEF_OF_STAFF_REPO_URL)).toBe(true);
    expect(hasSkillSourceForRepo([src('https://GitHub.com/RBCodeLabs/chief-of-staff.git')], CHIEF_OF_STAFF_REPO_URL)).toBe(true);
    expect(hasSkillSourceForRepo([src('http://github.com/rbcodelabs/chief-of-staff/')], CHIEF_OF_STAFF_REPO_URL)).toBe(true);
  });

  it('ignores other repos and local sources', () => {
    expect(hasSkillSourceForRepo([src('https://github.com/rbcodelabs/other')], CHIEF_OF_STAFF_REPO_URL)).toBe(false);
    expect(hasSkillSourceForRepo([src('https://github.com/rbcodelabs/chief-of-staff', 'local')], CHIEF_OF_STAFF_REPO_URL)).toBe(false);
  });
});

describe('findChiefOfStaffThreadId', () => {
  it('prefers the stored id when that thread still exists', () => {
    expect(findChiefOfStaffThreadId([{ id: 'a', title: 'Chief of Staff' }, { id: 'b', title: 'Renamed' }], 'b')).toBe('b');
  });

  it('falls back to a thread titled Chief of Staff when the stored id is stale', () => {
    expect(findChiefOfStaffThreadId([{ id: 'a', title: 'Chief of Staff' }], 'gone')).toBe('a');
  });

  it('returns undefined when neither exists', () => {
    expect(findChiefOfStaffThreadId([{ id: 'a', title: 'Something else' }], undefined)).toBeUndefined();
  });
});

describe('isBinaryResolvable', () => {
  const exists = (p: string) => p === '/opt/homebrew/bin/claude' || p === '/usr/bin/codex';

  it('checks an absolute path directly', () => {
    expect(isBinaryResolvable('/opt/homebrew/bin/claude', { exists, pathEnv: '' })).toBe(true);
    expect(isBinaryResolvable('/nope/claude', { exists, pathEnv: '/opt/homebrew/bin' })).toBe(false);
  });

  it('searches PATH for a bare command name', () => {
    expect(isBinaryResolvable('codex', { exists, pathEnv: '/usr/local/bin:/usr/bin' })).toBe(true);
    expect(isBinaryResolvable('opencode', { exists, pathEnv: '/usr/local/bin:/usr/bin' })).toBe(false);
  });

  it('is false for an empty value', () => {
    expect(isBinaryResolvable('', { exists, pathEnv: '/usr/bin' })).toBe(false);
  });
});

describe('withChiefOfStaffPointer', () => {
  it('appends one line naming the command, leaving the guide intact', () => {
    const out = withChiefOfStaffPointer('# Guide\n\nBody\n');
    expect(out.startsWith('# Guide\n\nBody\n')).toBe(true);
    expect(out).toContain('"Set up Chief of Staff"');
    expect(out.split('Set up Chief of Staff').length - 1).toBe(1);
  });
});

describe('setUpChiefOfStaff', () => {
  it('adds the source, creates the thread, sends the cos-setup prompt, persists the id and opens it', async () => {
    const { deps, sources, getStoredId } = makeDeps();
    const result = await setUpChiefOfStaff(deps);

    expect(result).toEqual({ status: 'created', threadId: 't1', sourceAdded: true });
    expect(deps.addGithubSkillSource).toHaveBeenCalledWith(CHIEF_OF_STAFF_REPO_URL);
    expect(sources).toHaveLength(1);
    expect(deps.createThread).toHaveBeenCalledWith(CHIEF_OF_STAFF_THREAD_TITLE);
    expect(getStoredId()).toBe('t1');
    expect(deps.saveSettings).toHaveBeenCalled();
    expect(deps.sendPrompt).toHaveBeenCalledWith('t1', CHIEF_OF_STAFF_SETUP_PROMPT);
    expect(deps.openThread).toHaveBeenCalledWith('t1');
  });

  it('skips the clone when the source is already configured', async () => {
    const { deps } = makeDeps({ sources: [{ id: 's', name: 'CoS', type: 'github', repoUrl: 'https://github.com/rbcodelabs/chief-of-staff.git' }] });
    const result = await setUpChiefOfStaff(deps);
    expect(result).toEqual({ status: 'created', threadId: 't1', sourceAdded: false });
    expect(deps.addGithubSkillSource).not.toHaveBeenCalled();
  });

  it('persists the thread id before sending the prompt (a crash mid-turn still finds the home thread)', async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      saveSettings: vi.fn(async () => { order.push('save'); }),
      sendPrompt: vi.fn(() => { order.push('send'); }),
    });
    await setUpChiefOfStaff(deps);
    expect(order.indexOf('save')).toBeLessThan(order.indexOf('send'));
  });

  it('reports clone-failed and creates no thread when the clone fails (e.g. offline)', async () => {
    const { deps, threads } = makeDeps({
      addGithubSkillSource: vi.fn(async () => { throw new Error('Could not resolve host: github.com'); }),
    });
    const result = await setUpChiefOfStaff(deps);
    expect(result).toEqual({ status: 'failed', reason: 'clone-failed', error: 'Could not resolve host: github.com' });
    expect(threads).toHaveLength(0);
    expect(deps.sendPrompt).not.toHaveBeenCalled();
    expect(deps.openThread).not.toHaveBeenCalled();
  });

  it('reports harness-unavailable and creates no thread when the harness is not ready', async () => {
    const { deps, threads } = makeDeps({ isHarnessReady: () => false });
    const result = await setUpChiefOfStaff(deps);
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.reason).toBe('harness-unavailable');
    expect(threads).toHaveLength(0);
  });

  it('reports thread-failed when thread creation throws', async () => {
    const { deps, getStoredId } = makeDeps({ createThread: vi.fn(() => { throw new Error('boom'); }) });
    const result = await setUpChiefOfStaff(deps);
    expect(result).toEqual({ status: 'failed', reason: 'thread-failed', error: 'boom' });
    expect(getStoredId()).toBeUndefined();
    expect(deps.openThread).not.toHaveBeenCalled();
  });

  describe('idempotency (the "Set up Chief of Staff" command)', () => {
    it('running twice creates one thread and focuses it the second time', async () => {
      const { deps, threads } = makeDeps();
      const first = await setUpChiefOfStaff(deps);
      const second = await setUpChiefOfStaff(deps);

      expect(first.status).toBe('created');
      expect(second).toEqual({ status: 'focused-existing', threadId: 't1' });
      expect(threads).toHaveLength(1);
      expect(deps.createThread).toHaveBeenCalledTimes(1);
      expect(deps.sendPrompt).toHaveBeenCalledTimes(1);
      expect(deps.addGithubSkillSource).toHaveBeenCalledTimes(1);
      expect(deps.openThread).toHaveBeenLastCalledWith('t1');
    });

    it('focuses an existing thread titled Chief of Staff and records its id', async () => {
      const { deps, getStoredId } = makeDeps({ threads: [{ id: 'old', title: 'Chief of Staff' }] });
      const result = await setUpChiefOfStaff(deps);
      expect(result).toEqual({ status: 'focused-existing', threadId: 'old' });
      expect(getStoredId()).toBe('old');
      expect(deps.createThread).not.toHaveBeenCalled();
      expect(deps.sendPrompt).not.toHaveBeenCalled();
    });

    it('still focuses the existing thread when re-adding a removed source fails', async () => {
      const { deps } = makeDeps({
        threads: [{ id: 'home', title: 'Renamed by user' }],
        storedId: 'home',
        addGithubSkillSource: vi.fn(async () => { throw new Error('offline'); }),
      });
      const result = await setUpChiefOfStaff(deps);
      expect(result).toEqual({ status: 'focused-existing', threadId: 'home', sourceError: 'offline' });
      expect(deps.openThread).toHaveBeenCalledWith('home');
    });

    it('creates a fresh thread when the stored home thread was deleted', async () => {
      const { deps, getStoredId } = makeDeps({ storedId: 'deleted' });
      const result = await setUpChiefOfStaff(deps);
      expect(result.status).toBe('created');
      expect(getStoredId()).toBe('t1');
    });
  });
});

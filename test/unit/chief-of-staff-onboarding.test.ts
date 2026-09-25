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
  CHIEF_OF_STAFF_REF,
  chooseChiefOfStaffHarness,
  decideFirstRun,
  describeChiefOfStaffFailure,
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
    isGitAvailable: vi.fn(async () => true),
    addGithubSkillSource: vi.fn(async (repoUrl: string, ref: string) => {
      sources.push({ id: 'gh-x', name: 'Chief of Staff', type: 'github', repoUrl, ref, clonePath: '/tmp/x' });
    }),
    resolveHarness: () => 'claude',
    reloadThreadSkills: vi.fn(() => false),
    listThreads: () => threads,
    getStoredThreadId: () => storedId,
    setStoredThreadId: vi.fn((id: string | undefined) => { storedId = id; }),
    createThread: vi.fn((title: string, _harness: string) => {
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
    expect(CHIEF_OF_STAFF_REF).toBe('v0.1.4');
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
  const fresh = { isFreshInstall: true };
  it('does nothing once the welcome has been seen', () => {
    expect(decideFirstRun({ ...fresh, hasSeenWelcome: true, threadCount: 0, offerChiefOfStaff: true })).toBe('none');
  });

  it('silently marks upgrading users (existing threads) as seen', () => {
    expect(decideFirstRun({ hasSeenWelcome: false, threadCount: 3, offerChiefOfStaff: true, isFreshInstall: false })).toBe('mark-seen');
    expect(decideFirstRun({ hasSeenWelcome: false, threadCount: 3, offerChiefOfStaff: false, isFreshInstall: false })).toBe('mark-seen');
  });

  it('offers Chief of Staff to brand-new installs when the setting is on', () => {
    expect(decideFirstRun({ ...fresh, hasSeenWelcome: false, threadCount: 0, offerChiefOfStaff: true })).toBe('chief-of-staff');
  });

  it('falls back to the static guide when the setting is off', () => {
    expect(decideFirstRun({ ...fresh, hasSeenWelcome: false, threadCount: 0, offerChiefOfStaff: false })).toBe('static-guide');
  });

  it('gives a pre-flag user with saved data but no threads the old static guide, not Chief of Staff', () => {
    expect(decideFirstRun({ hasSeenWelcome: false, threadCount: 0, offerChiefOfStaff: true, isFreshInstall: false })).toBe('static-guide');
  });
});

describe('chooseChiefOfStaffHarness', () => {
  const only = (...ok: string[]) => (h: string) => ok.includes(h);
  it('uses the selected harness when it resolves', () => {
    expect(chooseChiefOfStaffHarness('claude', only('claude', 'codex'))).toBe('claude');
    expect(chooseChiefOfStaffHarness('codex', only('claude', 'codex'))).toBe('codex');
  });

  it('never picks OpenCode (its sessions do not receive skill sources), preferring Claude then Codex', () => {
    expect(chooseChiefOfStaffHarness('opencode', only('opencode', 'claude', 'codex'))).toBe('claude');
    expect(chooseChiefOfStaffHarness('opencode', only('opencode', 'codex'))).toBe('codex');
    expect(chooseChiefOfStaffHarness('opencode', only('opencode'))).toBeUndefined();
  });

  it('falls through to another skill-capable harness when the selected one is missing', () => {
    expect(chooseChiefOfStaffHarness('claude', only('codex'))).toBe('codex');
    expect(chooseChiefOfStaffHarness('claude', only())).toBeUndefined();
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

describe('describeChiefOfStaffFailure', () => {
  it('maps network clone errors to a connection hint', () => {
    for (const err of [
      'Cloning into x...\nfatal: unable to access \'https://github.com/rbcodelabs/chief-of-staff.git/\': Could not resolve host: github.com',
      'fatal: unable to access: Failed to connect to github.com port 443: Operation timed out',
      'Command failed: git clone (timed out)',
      'ssl_read: Connection reset by peer',
      'network is unreachable',
    ]) {
      expect(describeChiefOfStaffFailure('clone-failed', err)).toBe('couldn\u2019t download the Chief of Staff skills \u2014 check your internet connection');
    }
  });

  it('maps a missing repo or tag to "not available yet"', () => {
    expect(describeChiefOfStaffFailure('clone-failed', 'warning: Could not find remote branch v0.1.0 to clone.\nfatal: Remote branch v0.1.0 not found in upstream origin'))
      .toBe('the Chief of Staff skills aren\u2019t available to download yet');
    expect(describeChiefOfStaffFailure('clone-failed', 'remote: Repository not found.\nfatal: repository \'https://github.com/x/y.git/\' not found'))
      .toBe('the Chief of Staff skills aren\u2019t available to download yet');
  });

  it('maps a non-filesystem vault', () => {
    expect(describeChiefOfStaffFailure('clone-failed', 'This vault is not on a local filesystem, so skill sources cannot be cloned.'))
      .toBe('this vault isn\u2019t on a local disk, so skills can\u2019t be downloaded');
  });

  it('falls back to a generic download message for other clone errors', () => {
    expect(describeChiefOfStaffFailure('clone-failed', 'fatal: destination path exists')).toBe('couldn\u2019t download the Chief of Staff skills');
  });

  it('maps the other reasons', () => {
    expect(describeChiefOfStaffFailure('git-unavailable', '')).toBe('git isn\u2019t installed');
    expect(describeChiefOfStaffFailure('harness-unavailable', 'x')).toBe('no Claude Code or Codex found');
    expect(describeChiefOfStaffFailure('thread-failed', 'Error: boom\n    at foo (/x/y.js:1:2)')).toBe('couldn\u2019t start the thread');
    expect(describeChiefOfStaffFailure('unexpected', 'TypeError: x')).toBe('something went wrong during setup');
  });

  it('never leaks the raw error, URLs or stack frames', () => {
    const raw = 'fatal: unable to access \'https://github.com/rbcodelabs/chief-of-staff.git/\': Could not resolve host\n    at run (/Users/x/main.js:1:1)';
    for (const reason of ['git-unavailable', 'clone-failed', 'harness-unavailable', 'thread-failed', 'unexpected'] as const) {
      const text = describeChiefOfStaffFailure(reason, raw);
      expect(text).not.toMatch(/https?:|\/Users\/|\bat \w+ \(|fatal/);
    }
  });
});

describe('withChiefOfStaffPointer', () => {
  it('adds the failure reason as a line next to the pointer when given', () => {
    const out = withChiefOfStaffPointer('# Guide\n', 'git isn\u2019t installed');
    expect(out).toContain('Chief of Staff setup couldn\u2019t finish: git isn\u2019t installed.');
    expect(out.indexOf('couldn\u2019t finish')).toBeLessThan(out.indexOf('"Set up Chief of Staff"') + 200);
  });

  it('omits the reason line when none is given', () => {
    expect(withChiefOfStaffPointer('# Guide\n')).not.toContain('couldn\u2019t finish');
  });


  it('appends one line naming the command, leaving the guide intact', () => {
    const out = withChiefOfStaffPointer('# Guide\n\nBody\n');
    expect(out.startsWith('# Guide\n\nBody\n')).toBe(true);
    expect(out).toContain('"Set up Chief of Staff"');
    expect(out.split('Set up Chief of Staff').length - 1).toBe(1);
  });
});

describe('setUpChiefOfStaff', () => {
  it('adds the pinned source, creates the thread on the chosen harness, sends cos-setup, persists the id and opens it', async () => {
    const { deps, sources, getStoredId } = makeDeps();
    const result = await setUpChiefOfStaff(deps);

    expect(result).toEqual({ status: 'created', threadId: 't1', sourceAdded: true, harness: 'claude' });
    expect(deps.isGitAvailable).toHaveBeenCalled();
    expect(deps.addGithubSkillSource).toHaveBeenCalledWith(CHIEF_OF_STAFF_REPO_URL, CHIEF_OF_STAFF_REF);
    expect(sources[0]!.ref).toBe('v0.1.4');
    expect(deps.createThread).toHaveBeenCalledWith(CHIEF_OF_STAFF_THREAD_TITLE, 'claude');
    expect(getStoredId()).toBe('t1');
    expect(deps.saveSettings).toHaveBeenCalled();
    expect(deps.sendPrompt).toHaveBeenCalledWith('t1', CHIEF_OF_STAFF_SETUP_PROMPT);
    expect(deps.openThread).toHaveBeenCalledWith('t1');
  });

  it('skips the git check and the clone when the source is already configured', async () => {
    const { deps } = makeDeps({ sources: [{ id: 's', name: 'CoS', type: 'github', repoUrl: 'https://github.com/rbcodelabs/chief-of-staff.git' }] });
    const result = await setUpChiefOfStaff(deps);
    expect(result).toEqual({ status: 'created', threadId: 't1', sourceAdded: false, harness: 'claude' });
    expect(deps.addGithubSkillSource).not.toHaveBeenCalled();
    expect(deps.isGitAvailable).not.toHaveBeenCalled();
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

  it('reports git-unavailable without attempting a clone when git is missing', async () => {
    const { deps, threads } = makeDeps({ isGitAvailable: vi.fn(async () => false) });
    const result = await setUpChiefOfStaff(deps);
    expect(result.status === 'failed' && result.reason).toBe('git-unavailable');
    expect(deps.addGithubSkillSource).not.toHaveBeenCalled();
    expect(threads).toHaveLength(0);
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

  it('reports harness-unavailable and creates no thread when no skill-capable harness resolves', async () => {
    const { deps, threads } = makeDeps({ resolveHarness: () => undefined });
    const result = await setUpChiefOfStaff(deps);
    expect(result.status === 'failed' && result.reason).toBe('harness-unavailable');
    expect(threads).toHaveLength(0);
  });

  it('creates the thread on the harness the resolver picked (e.g. Claude when OpenCode is selected)', async () => {
    const { deps } = makeDeps({ resolveHarness: () => 'codex' });
    const result = await setUpChiefOfStaff(deps);
    expect(result.status === 'created' && result.harness).toBe('codex');
    expect(deps.createThread).toHaveBeenCalledWith(CHIEF_OF_STAFF_THREAD_TITLE, 'codex');
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
      expect(second).toEqual({ status: 'focused-existing', threadId: 't1', sourceAdded: false, skillsReloadPending: false });
      expect(threads).toHaveLength(1);
      expect(deps.createThread).toHaveBeenCalledTimes(1);
      expect(deps.sendPrompt).toHaveBeenCalledTimes(1);
      expect(deps.addGithubSkillSource).toHaveBeenCalledTimes(1);
      expect(deps.reloadThreadSkills).not.toHaveBeenCalled();
      expect(deps.openThread).toHaveBeenLastCalledWith('t1');
    });

    it('focuses an existing thread titled Chief of Staff and records its id', async () => {
      const { deps, getStoredId } = makeDeps({
        threads: [{ id: 'old', title: 'Chief of Staff' }],
        sources: [{ id: 's', name: 'CoS', type: 'github', repoUrl: CHIEF_OF_STAFF_REPO_URL }],
      });
      const result = await setUpChiefOfStaff(deps);
      expect(result).toEqual({ status: 'focused-existing', threadId: 'old', sourceAdded: false, skillsReloadPending: false });
      expect(getStoredId()).toBe('old');
      expect(deps.createThread).not.toHaveBeenCalled();
      expect(deps.sendPrompt).not.toHaveBeenCalled();
    });

    it('re-adding a removed source reloads the existing thread skills', async () => {
      const { deps } = makeDeps({ threads: [{ id: 'home', title: 'Chief of Staff' }], reloadThreadSkills: vi.fn(() => true) });
      const result = await setUpChiefOfStaff(deps);
      expect(result).toEqual({ status: 'focused-existing', threadId: 'home', sourceAdded: true, skillsReloadPending: true });
      expect(deps.reloadThreadSkills).toHaveBeenCalledWith('home');
    });

    it('still focuses the existing thread when re-adding a removed source fails', async () => {
      const { deps } = makeDeps({
        threads: [{ id: 'home', title: 'Renamed by user' }],
        storedId: 'home',
        addGithubSkillSource: vi.fn(async () => { throw new Error('offline'); }),
      });
      const result = await setUpChiefOfStaff(deps);
      expect(result).toEqual({ status: 'focused-existing', threadId: 'home', sourceAdded: false, skillsReloadPending: false, sourceError: 'offline', sourceFailure: 'clone-failed' });
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

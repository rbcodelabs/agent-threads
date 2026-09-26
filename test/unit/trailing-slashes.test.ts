/**
 * Linear trailing-separator stripping. Replaces `/\/+$/`-style regexes on
 * user-supplied URLs and paths, which CodeQL flags as polynomial ReDoS
 * (js/polynomial-redos): a long run of slashes not at the end makes the regex
 * engine retry from every start position.
 */
import { describe, it, expect } from 'vitest';
import { stripTrailingSlashes, stripTrailingPathSeparators } from '../../src/trailingSlashes';
import { normalizeRepoUrlForId, githubCloneUrl } from '../../src/skillManager';
import { hasSkillSourceForRepo, isBinaryResolvable } from '../../src/chiefOfStaffOnboarding';

describe('stripTrailingSlashes', () => {
  it('matches the old /\\/+$/ replacement', () => {
    for (const input of ['', '/', '///', 'a', 'a/', 'a///', '/a/b//', 'https://github.com/o/r/', 'a\\']) {
      expect(stripTrailingSlashes(input)).toBe(input.replace(/\/+$/, ''));
    }
  });

  it('is linear on a pathological input (a long slash run not at the end)', () => {
    const evil = '/'.repeat(50_000) + 'x';
    const start = performance.now();
    expect(stripTrailingSlashes(evil)).toBe(evil);
    expect(stripTrailingSlashes('/'.repeat(50_000))).toBe('');
    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe('stripTrailingPathSeparators', () => {
  it('matches the old /[\\\\/]+$/ replacement', () => {
    for (const input of ['', 'a', 'a/', 'a\\', 'C:\\bin\\\\', '/usr/bin/\\/', 'x/y']) {
      expect(stripTrailingPathSeparators(input)).toBe(input.replace(/[\\/]+$/, ''));
    }
  });

  it('is linear on a pathological input', () => {
    const evil = '\\/'.repeat(25_000) + 'x';
    const start = performance.now();
    expect(stripTrailingPathSeparators(evil)).toBe(evil);
    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe('call sites stay fast on pathological URLs', () => {
  const evil = 'https://github.com/o/r' + '/'.repeat(50_000) + 'x';

  it('normalizeRepoUrlForId, githubCloneUrl, hasSkillSourceForRepo, isBinaryResolvable', () => {
    const start = performance.now();
    normalizeRepoUrlForId(evil);
    githubCloneUrl(evil);
    hasSkillSourceForRepo([{ id: 'a', name: 'a', type: 'github', repoUrl: evil }], evil);
    isBinaryResolvable('git', { exists: () => false, pathEnv: '/'.repeat(50_000) + 'x' });
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('keeps normalizing behaviour identical', () => {
    expect(normalizeRepoUrlForId('https://GitHub.com/O/R.git///')).toBe('github.com/o/r.git');
    expect(normalizeRepoUrlForId('https://github.com/o/r///')).toBe('github.com/o/r');
    expect(githubCloneUrl('https://github.com/o/r//')).toBe('https://github.com/o/r.git');
  });
});

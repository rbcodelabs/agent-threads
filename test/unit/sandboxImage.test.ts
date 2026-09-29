import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  HARNESS_DOCKERFILE,
  SANDBOX_BASE_IMAGE_REF,
  SANDBOX_CODING_IMAGE,
  SANDBOX_HARNESS_IMAGE,
  SANDBOX_IMAGE_VERSION,
  SANDBOX_IMAGE_VERSION_LABEL,
  SandboxImageAbortedError,
  SandboxImageError,
  ensureSandboxImages,
  getSandboxImageStatus,
  parseImageVersionLabel,
} from '../../src/sandboxImage';
import type { VmCommandResult, VmCommandRunner } from '../../src/sandboxVm';

const root = resolve(__dirname, '../..');
const ok = (stdout = ''): VmCommandResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = 'boom', exitCode = 1): VmCommandResult => ({ exitCode, stdout: '', stderr });

function inspectJson(label?: string): string {
  return JSON.stringify([{ variants: [{ config: { config: { Labels: label === undefined ? null : { [SANDBOX_IMAGE_VERSION_LABEL]: label } } } }] }]);
}

interface FakeState {
  images: Record<string, string | null>; // tag -> version label (null = no label)
  pullResult?: VmCommandResult;
  tagResult?: VmCommandResult;
  buildResult?: VmCommandResult;
  onBuild?: (args: string[]) => void | Promise<void>;
}

function fakeRunner(state: FakeState) {
  const calls: string[][] = [];
  const runner: VmCommandRunner = vi.fn(async (args, opts) => {
    calls.push(args);
    const [a, b] = args;
    if (a === 'image' && b === 'inspect') {
      const tag = args[2];
      if (!(tag in state.images)) return fail('not found');
      const label = state.images[tag];
      return ok(inspectJson(label === null ? undefined : label));
    }
    if (a === 'image' && b === 'pull') {
      opts.onOutput?.('pulling layer');
      return state.pullResult ?? ok();
    }
    if (a === 'image' && b === 'tag') {
      if (state.tagResult) return state.tagResult;
      state.images[args[3]] = null;
      return ok();
    }
    if (a === 'build') {
      await state.onBuild?.(args);
      opts.onOutput?.('step 1');
      const res = state.buildResult ?? ok();
      if (res.exitCode === 0) state.images[args[2]] = SANDBOX_IMAGE_VERSION;
      return res;
    }
    return fail('unexpected');
  });
  return { runner, calls };
}

const stripCalls = (calls: string[][]) => calls.filter((c) => !(c[0] === 'image' && c[1] === 'inspect'));

describe('drift guards', () => {
  it('SANDBOX_IMAGE_VERSION equals sandbox/IMAGE_VERSION', () => {
    expect(readFileSync(resolve(root, 'sandbox/IMAGE_VERSION'), 'utf8').trim()).toBe(SANDBOX_IMAGE_VERSION);
  });
  it('embedded harness Dockerfile equals sandbox/Dockerfile.harness byte-for-byte', () => {
    expect(HARNESS_DOCKERFILE).toBe(readFileSync(resolve(root, 'sandbox/Dockerfile.harness'), 'utf8'));
  });
  it('the harness Dockerfile builds FROM the local coding tag', () => {
    expect(HARNESS_DOCKERFILE).toContain(`FROM ${SANDBOX_CODING_IMAGE}`);
  });
  it('base ref points at ghcr with the image version', () => {
    expect(SANDBOX_BASE_IMAGE_REF).toBe(`ghcr.io/rbcodelabs/claude-threads-sandbox:${SANDBOX_IMAGE_VERSION}`);
  });
  it('the publish workflow exists', () => {
    expect(existsSync(resolve(root, '.github/workflows/publish-sandbox-image.yml'))).toBe(true);
  });
});

describe('parseImageVersionLabel', () => {
  it('reads the label', () => expect(parseImageVersionLabel(inspectJson('3'))).toBe('3'));
  it('returns null for no labels, junk, or empty', () => {
    expect(parseImageVersionLabel(inspectJson())).toBeNull();
    expect(parseImageVersionLabel('not json')).toBeNull();
    expect(parseImageVersionLabel('[]')).toBeNull();
  });
});

describe('getSandboxImageStatus', () => {
  const cases: Array<[string, Record<string, string | null>, { base: string; harness: string }]> = [
    ['nothing', {}, { base: 'missing', harness: 'missing' }],
    ['base only', { [SANDBOX_CODING_IMAGE]: null }, { base: 'ok', harness: 'missing' }],
    ['current harness', { [SANDBOX_CODING_IMAGE]: null, [SANDBOX_HARNESS_IMAGE]: SANDBOX_IMAGE_VERSION }, { base: 'ok', harness: 'ok' }],
    ['stale label', { [SANDBOX_CODING_IMAGE]: null, [SANDBOX_HARNESS_IMAGE]: '0' }, { base: 'ok', harness: 'stale' }],
    ['unlabelled harness (hand-built)', { [SANDBOX_CODING_IMAGE]: null, [SANDBOX_HARNESS_IMAGE]: null }, { base: 'ok', harness: 'stale' }],
    ['harness without base', { [SANDBOX_HARNESS_IMAGE]: SANDBOX_IMAGE_VERSION }, { base: 'missing', harness: 'ok' }],
  ];
  it.each(cases)('%s', async (_n, images, expected) => {
    const { runner } = fakeRunner({ images });
    expect(await getSandboxImageStatus(runner)).toEqual(expected);
  });
  it('probes a custom harness image name', async () => {
    const { runner } = fakeRunner({ images: { custom: SANDBOX_IMAGE_VERSION } });
    expect((await getSandboxImageStatus(runner, 'custom')).harness).toBe('ok');
  });
});

describe('ensureSandboxImages', () => {
  it('pulls, then tags, then builds — in that order', async () => {
    const { runner, calls } = fakeRunner({ images: {} });
    const progress: string[] = [];
    const res = await ensureSandboxImages({ runner, onProgress: (l) => progress.push(l) });
    expect(res).toEqual({ pulledBase: true, builtHarness: true });
    const c = stripCalls(calls);
    expect(c[0]).toEqual(['image', 'pull', '--platform', 'linux/arm64', SANDBOX_BASE_IMAGE_REF]);
    expect(c[1]).toEqual(['image', 'tag', SANDBOX_BASE_IMAGE_REF, SANDBOX_CODING_IMAGE]);
    expect(c[2][0]).toBe('build');
    expect(progress).toContain('pulling layer');
    expect(progress).toContain('step 1');
  });

  it('keeps an existing coding image (no pull, no tag)', async () => {
    const { runner, calls } = fakeRunner({ images: { [SANDBOX_CODING_IMAGE]: null } });
    const res = await ensureSandboxImages({ runner });
    expect(res).toEqual({ pulledBase: false, builtHarness: true });
    expect(calls.some((c) => c[1] === 'pull' || c[1] === 'tag')).toBe(false);
  });

  it('is a no-op when both images are current', async () => {
    const { runner, calls } = fakeRunner({ images: { [SANDBOX_CODING_IMAGE]: null, [SANDBOX_HARNESS_IMAGE]: SANDBOX_IMAGE_VERSION } });
    expect(await ensureSandboxImages({ runner })).toEqual({ pulledBase: false, builtHarness: false });
    expect(stripCalls(calls)).toEqual([]);
  });

  it('rebuilds a stale harness image', async () => {
    const { runner } = fakeRunner({ images: { [SANDBOX_CODING_IMAGE]: null, [SANDBOX_HARNESS_IMAGE]: '0' } });
    expect((await ensureSandboxImages({ runner })).builtHarness).toBe(true);
  });

  it('builds with exact args and the Dockerfile on disk, then removes the temp dir', async () => {
    let seen: { args: string[]; content: string } | undefined;
    const { readFileSync: read } = await import('fs');
    const { runner } = fakeRunner({
      images: { [SANDBOX_CODING_IMAGE]: null },
      onBuild: (args) => { seen = { args, content: read(args[args.indexOf('-f') + 1], 'utf8') }; },
    });
    await ensureSandboxImages({ runner, harnessImage: 'my-harness:9' });
    const args = seen!.args;
    const dockerfile = args[args.indexOf('-f') + 1];
    const dir = args[args.length - 1];
    expect(args).toEqual([
      'build', '--tag', 'my-harness:9',
      '--label', `${SANDBOX_IMAGE_VERSION_LABEL}=${SANDBOX_IMAGE_VERSION}`,
      '--progress', 'plain', '-f', dockerfile, dir,
    ]);
    expect(dockerfile).toBe(`${dir}/Dockerfile`);
    expect(seen!.content).toBe(HARNESS_DOCKERFILE);
    expect(existsSync(dir)).toBe(false);
  });

  it('cleans up the temp dir and names the step when the build fails', async () => {
    let dir = '';
    const { runner } = fakeRunner({
      images: { [SANDBOX_CODING_IMAGE]: null },
      buildResult: fail('line1\nnetwork unreachable'),
      onBuild: (args) => { dir = args[args.length - 1]; },
    });
    const err = await ensureSandboxImages({ runner }).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxImageError);
    expect(err.step).toBe('build');
    expect(err.message).toContain('network unreachable');
    expect(existsSync(dir)).toBe(false);
  });

  it('reports a pull failure with the stderr tail and does not tag or build', async () => {
    const { runner, calls } = fakeRunner({ images: {}, pullResult: fail('denied: unauthorized') });
    const err = await ensureSandboxImages({ runner }).catch((e) => e);
    expect(err.step).toBe('pull');
    expect(err.message).toContain('denied: unauthorized');
    expect(calls.some((c) => c[1] === 'tag' || c[0] === 'build')).toBe(false);
  });

  it('reports a tag failure', async () => {
    const { runner } = fakeRunner({ images: {}, tagResult: fail('no such image') });
    const err = await ensureSandboxImages({ runner }).catch((e) => e);
    expect(err.step).toBe('tag');
  });

  it('gives pull and build generous timeouts, leaving tag at the lifecycle cap', async () => {
    const { runner } = fakeRunner({ images: {} });
    await ensureSandboxImages({ runner });
    const byVerb = (verb: string) => (runner as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0][1] === verb || c[0][0] === verb)![1];
    expect(byVerb('pull').timeoutMs).toBeGreaterThan(120_000);
    expect(byVerb('build').timeoutMs).toBeGreaterThan(120_000);
    expect(byVerb('tag').timeoutMs).toBe(120_000);
  });

  it('aborts before doing any work when already aborted', async () => {
    const { runner, calls } = fakeRunner({ images: {} });
    const ac = new AbortController();
    ac.abort();
    await expect(ensureSandboxImages({ runner, signal: ac.signal })).rejects.toBeInstanceOf(SandboxImageAbortedError);
    expect(calls).toEqual([]);
  });

  it('aborts mid-run: stops before build and cleans up', async () => {
    const ac = new AbortController();
    const state: FakeState = { images: {} };
    const { runner, calls } = fakeRunner(state);
    const wrapped: VmCommandRunner = async (args, opts) => {
      const r = await runner(args, opts);
      if (args[1] === 'pull') ac.abort();
      return r;
    };
    await expect(ensureSandboxImages({ runner: wrapped, signal: ac.signal })).rejects.toBeInstanceOf(SandboxImageAbortedError);
    expect(calls.some((c) => c[0] === 'build' || c[1] === 'tag')).toBe(false);
  });

  it('joins concurrent identical calls into one run', async () => {
    const { runner, calls } = fakeRunner({ images: {} });
    const [a, b] = await Promise.all([ensureSandboxImages({ runner }), ensureSandboxImages({ runner })]);
    expect(a).toBe(b);
    expect(calls.filter((c) => c[1] === 'pull')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'build')).toHaveLength(1);
  });

  it('serialises concurrent calls for different harness images', async () => {
    const state: FakeState = { images: { [SANDBOX_CODING_IMAGE]: null } };
    const { runner, calls } = fakeRunner(state);
    await Promise.all([ensureSandboxImages({ runner, harnessImage: 'a:1' }), ensureSandboxImages({ runner, harnessImage: 'b:1' })]);
    const builds = calls.filter((c) => c[0] === 'build').map((c) => c[2]);
    expect(builds).toEqual(['a:1', 'b:1']);
  });

  it('can run again after a failure', async () => {
    const state: FakeState = { images: {}, pullResult: fail('offline') };
    const { runner } = fakeRunner(state);
    await expect(ensureSandboxImages({ runner })).rejects.toBeInstanceOf(SandboxImageError);
    state.pullResult = undefined;
    expect(await ensureSandboxImages({ runner })).toEqual({ pulledBase: true, builtHarness: true });
  });
});

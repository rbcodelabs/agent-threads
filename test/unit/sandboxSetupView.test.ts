import { describe, it, expect } from 'vitest';
import { buildSandboxSetupView, errorTail, formatSetupProgress } from '../../src/sandboxSetupView';
import type { SandboxSetupStatus } from '../../src/sandboxSetup';

const st = (o: Partial<SandboxSetupStatus>): SandboxSetupStatus => ({
  supported: true, runtime: 'missing', running: false, images: { base: 'unknown', harness: 'unknown' }, ...o,
});

describe('buildSandboxSetupView', () => {
  it('fresh Mac: Not installed / Stopped / Needs setup, button "Set up sandbox"', () => {
    expect(buildSandboxSetupView(st({}))).toEqual({
      runtimeLine: 'Not installed', serviceLine: 'Stopped', imageLine: 'Needs setup', buttonLabel: 'Set up sandbox', ready: false,
    });
  });

  it('managed runtime shows its version', () => {
    const v = buildSandboxSetupView(st({ runtime: 'installed', runtimeSource: 'managed', runtimeVersion: '1.5.0', running: true }));
    expect(v.runtimeLine).toBe('Managed by Agent Threads (v1.5.0)');
  });

  it('system/Homebrew runtime', () => {
    const v = buildSandboxSetupView(st({ runtime: 'installed', runtimeSource: 'system', running: true }));
    expect(v.runtimeLine).toBe('Installed — Homebrew/system');
  });

  it('installed but stopped or missing images: "Finish setup"', () => {
    expect(buildSandboxSetupView(st({ runtime: 'installed', runtimeSource: 'system' })).buttonLabel).toBe('Finish setup');
    expect(buildSandboxSetupView(st({
      runtime: 'installed', runtimeSource: 'system', running: true, images: { base: 'missing', harness: 'missing' },
    })).buttonLabel).toBe('Finish setup');
  });

  it('running with a stale base image: "Update sandbox" / "Update available"', () => {
    const v = buildSandboxSetupView(st({ runtime: 'installed', runtimeSource: 'system', running: true, images: { base: 'stale', harness: 'ok' } }));
    expect(v).toMatchObject({ imageLine: 'Update available', buttonLabel: 'Update sandbox', ready: false });
  });

  it('running with only a stale harness layer: "Update sandbox" / "Update available"', () => {
    const v = buildSandboxSetupView(st({ runtime: 'installed', runtimeSource: 'system', running: true, images: { base: 'ok', harness: 'stale' } }));
    expect(v).toMatchObject({ imageLine: 'Update available', buttonLabel: 'Update sandbox' });
  });

  it('fully ready: image Ready and no button', () => {
    const v = buildSandboxSetupView(st({ runtime: 'installed', runtimeSource: 'managed', running: true, images: { base: 'ok', harness: 'ok' } }));
    expect(v).toMatchObject({ imageLine: 'Ready', serviceLine: 'Running', buttonLabel: null, ready: true });
  });

  it('unsupported: shows the reason and offers no button', () => {
    const v = buildSandboxSetupView(st({ supported: false, reason: 'Sandboxed VMs require macOS 26 or later.' }));
    expect(v.runtimeLine).toBe('Unsupported: Sandboxed VMs require macOS 26 or later.');
    expect(v.buttonLabel).toBeNull();
  });
});

describe('formatSetupProgress', () => {
  it('renders "Step N of M — label…" with percent and detail line', () => {
    expect(formatSetupProgress({ step: 'start', stepNumber: 2, totalSteps: 3, label: 'Starting the runtime' }))
      .toBe('Step 2 of 3 — Starting the runtime…');
    expect(formatSetupProgress({ step: 'runtime', stepNumber: 1, totalSteps: 3, label: 'Installing the container runtime', percent: 37, line: 'Downloading' }))
      .toBe('Step 1 of 3 — Installing the container runtime… (37%)\nDownloading');
  });
});

describe('errorTail', () => {
  it('keeps short messages and trims long ones to the last lines', () => {
    expect(errorTail('a\nb')).toBe('a\nb');
    const long = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const out = errorTail(long, 3);
    expect(out).toBe('…\nl17\nl18\nl19');
  });
});

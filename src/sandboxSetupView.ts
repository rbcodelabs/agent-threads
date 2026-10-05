/**
 * sandboxSetupView.ts — pure text/decision logic for the sandbox-setup UI
 * (Settings row and in-thread card). No DOM, no Obsidian, so it is unit-tested
 * directly and both surfaces say exactly the same thing.
 */

import type { SandboxSetupProgress, SandboxSetupStatus } from './sandboxSetup';
import { SANDBOX_IMAGE_VERSION, formatImageVersion } from './sandboxImage';

export type SandboxSetupButtonLabel = 'Set up sandbox' | 'Finish setup' | 'Update sandbox';

export interface SandboxSetupView {
  runtimeLine: string;
  serviceLine: string;
  imageLine: string;
  /** Installed version and why an update is offered, e.g. "Image v1 → v2 available (missing gh)". Null when there is nothing to add. */
  imageDetailLine: string | null;
  /** Null when there is nothing to offer: unsupported, or already fully ready. */
  buttonLabel: SandboxSetupButtonLabel | null;
  ready: boolean;
}

export function describeRuntime(status: SandboxSetupStatus): string {
  if (!status.supported) return `Unsupported: ${status.reason ?? 'this Mac cannot run sandboxed VMs.'}`;
  if (status.runtime === 'missing') return 'Not installed';
  const version = status.runtimeVersion ? ` (v${status.runtimeVersion})` : '';
  return status.runtimeSource === 'managed'
    ? `Managed by Agent Threads${version}`
    : `Installed — Homebrew/system${version}`;
}

export function describeService(status: SandboxSetupStatus): string {
  return status.running ? 'Running' : 'Stopped';
}

export function describeImage(status: SandboxSetupStatus): 'Ready' | 'Needs setup' | 'Update available' {
  const { base, harness } = status.images;
  if (base === 'ok' && harness === 'ok') return 'Ready';
  if (base === 'stale' || (base === 'ok' && harness === 'stale')) return 'Update available';
  return 'Needs setup';
}

/**
 * Installed image version, and (for a stale image) what changes. Reads the
 * detail the status probe collected; null when the images were not inspected.
 */
export function describeImageDetail(status: SandboxSetupStatus): string | null {
  const detail = status.images.detail;
  if (!detail) return null;
  const parts: string[] = [];
  for (const [key, label] of [['base', 'Image'], ['harness', 'Harness image']] as const) {
    const d = detail[key];
    if (!d) continue;
    const state = status.images[key];
    let text = `${label} ${formatImageVersion(d.version)}`;
    if (state === 'stale') {
      text += d.version === SANDBOX_IMAGE_VERSION ? ' needs a rebuild' : ` → v${SANDBOX_IMAGE_VERSION} available`;
      if (d.missingTools.length > 0) text += ` (missing ${d.missingTools.join(', ')})`;
    }
    parts.push(text);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function buildSandboxSetupView(status: SandboxSetupStatus): SandboxSetupView {
  const imageLine = describeImage(status);
  const ready = status.supported && status.runtime === 'installed' && status.running && imageLine === 'Ready';
  let buttonLabel: SandboxSetupButtonLabel | null = null;
  if (status.supported && !ready) {
    if (status.runtime === 'missing') buttonLabel = 'Set up sandbox';
    else if (status.running && imageLine === 'Update available') buttonLabel = 'Update sandbox';
    else buttonLabel = 'Finish setup';
  }
  return {
    runtimeLine: describeRuntime(status),
    serviceLine: describeService(status),
    imageLine,
    imageDetailLine: describeImageDetail(status),
    buttonLabel,
    ready,
  };
}

/** "Step 2 of 3 — Starting the runtime… (37%)" plus the latest detail line, when any. */
export function formatSetupProgress(p: SandboxSetupProgress): string {
  const pct = p.percent !== undefined ? ` (${p.percent}%)` : '';
  const head = `Step ${p.stepNumber} of ${p.totalSteps} — ${p.label}…${pct}`;
  return p.line ? `${head}\n${p.line}` : head;
}

/** Last few lines of an error message, so a long build log does not flood a settings row. */
export function errorTail(message: string, maxLines = 6): string {
  const lines = message.trim().split('\n');
  return lines.length <= maxLines ? lines.join('\n') : ['…', ...lines.slice(-maxLines)].join('\n');
}

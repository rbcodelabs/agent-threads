/**
 * sandboxSetupPrompt.ts — when to offer the in-thread "Run this thread in a
 * sandbox?" card. Pure so the gating (the part that decides whether we nag) is
 * unit-tested without a ThreadManager.
 */

import { SANDBOX_SETUP_FIXABLE_REASONS, type HarnessVmFallbackReason } from './harnessVmRouting';
import type { HarnessVmMode } from './types';

export interface SandboxOfferInputs {
  mode: HarnessVmMode;
  /** Why this session start fell back to the host; undefined when it was routed or VM routing was not attempted. */
  reason: HarnessVmFallbackReason | undefined;
  /** Persisted "Don't ask again". */
  dismissedForever: boolean;
  /** This thread already got a card in this app session (accepted, "Not now", or ignored). */
  alreadyOffered: boolean;
  /** Setup can actually run here (macOS 26+ on Apple silicon, desktop). */
  setupSupported: boolean;
}

/**
 * Offer only when: mode is `auto`; the fallback is one setup can fix (runtime
 * missing/stopped, image missing — NOT unsupported platform, `never`, or a
 * container start failure); setup can run on this machine; the user hasn't
 * said "don't ask again"; and this thread hasn't been asked this session.
 */
export function shouldOfferSandboxSetup(i: SandboxOfferInputs): boolean {
  if (i.mode !== 'auto') return false;
  if (!i.reason || !SANDBOX_SETUP_FIXABLE_REASONS.includes(i.reason)) return false;
  if (!i.setupSupported || i.dismissedForever || i.alreadyOffered) return false;
  return true;
}

import { describe, it, expect } from 'vitest';
import { shouldOfferSandboxSetup, type SandboxOfferInputs } from '../../src/sandboxSetupPrompt';

const base: SandboxOfferInputs = {
  mode: 'auto', reason: 'runtime-missing', dismissedForever: false, alreadyOffered: false, setupSupported: true,
};

describe('shouldOfferSandboxSetup', () => {
  it.each(['runtime-missing', 'runtime-stopped', 'image-missing'] as const)('offers for %s', (reason) => {
    expect(shouldOfferSandboxSetup({ ...base, reason })).toBe(true);
  });

  it.each(['unsupported', 'never', 'start-failed', undefined] as const)('does not offer for %s', (reason) => {
    expect(shouldOfferSandboxSetup({ ...base, reason })).toBe(false);
  });

  it('only in auto mode', () => {
    expect(shouldOfferSandboxSetup({ ...base, mode: 'always' })).toBe(false);
    expect(shouldOfferSandboxSetup({ ...base, mode: 'never' })).toBe(false);
  });

  it('respects Don\'t ask again, once-per-session, and unsupported machines', () => {
    expect(shouldOfferSandboxSetup({ ...base, dismissedForever: true })).toBe(false);
    expect(shouldOfferSandboxSetup({ ...base, alreadyOffered: true })).toBe(false);
    expect(shouldOfferSandboxSetup({ ...base, setupSupported: false })).toBe(false);
  });
});

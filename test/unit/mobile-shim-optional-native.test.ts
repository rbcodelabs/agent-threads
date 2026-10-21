import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * Regression: the mobile `require` shim stubs every module the host refuses. `ws` probes `bufferutil` /
 * `utf-8-validate` inside try/catch and uses them when present, so a stub made `ws.send()` throw
 * ("bufferutil.mask is not available") on desktop: the daemon hello never left the plugin and the UI said
 * "the daemon rejected the access token".
 */
function loadShim(hostRequire: (id: string) => unknown): (id: string) => unknown {
  const code = readFileSync(join(__dirname, '../../scripts/mobile-node-shims.js'), 'utf8');
  const ctx = vm.createContext({ require: hostRequire, globalThis: undefined, console });
  return vm.runInContext(`${code}\nrequire`, ctx) as (id: string) => unknown;
}

const refusing = (id: string): unknown => { throw new Error(`cannot find ${id}`); };

describe('mobile require shim', () => {
  it('keeps optional native ws accelerators throwing so ws falls back to JS', () => {
    const req = loadShim(refusing);
    expect(() => req('bufferutil')).toThrow();
    expect(() => req('utf-8-validate')).toThrow();
    expect(() => req('node:bufferutil')).toThrow();
  });

  it('still stubs other refused modules so the bundle can load on mobile', () => {
    const req = loadShim(refusing);
    expect(() => req('fs')).not.toThrow();
    expect(typeof req('path')).toBe('object');
  });

  it('passes through modules the host provides', () => {
    const real = { mask: () => 1 };
    const req = loadShim((id) => (id === 'bufferutil' ? real : refusing(id)));
    expect(req('bufferutil')).toBe(real);
  });
});

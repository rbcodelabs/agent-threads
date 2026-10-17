import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { randomHex } from '../../src/remote/randomId';

describe('randomHex', () => {
  it('returns hex of the requested length and does not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomHex(8)));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
  it('ids that name commands, messages and instances never use Math.random', () => {
    for (const f of ['src/remote/DaemonClient.ts', 'src/remote/RemoteHarnessSession.ts', 'daemon/cmd/connection.ts', 'daemon/cmd/follow.ts']) {
      expect(readFileSync(resolve(__dirname, '../..', f), 'utf8'), f).not.toContain('Math.random');
    }
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareStableVersions, readLatestStable } from '../../scripts/codex-harness-version.mjs';
import { assertSmokeTurn } from '../../scripts/codex-candidate-smoke.mjs';

test('reports only stable upstream versions newer than the exact pin', () => {
  assert.equal(compareStableVersions('0.170.0', '0.169.20'), 1);
  assert.equal(compareStableVersions('0.170.0', '0.170.0'), 0);
  assert.equal(compareStableVersions('0.170.0', '0.171.0'), -1);
  for (const invalid of ['latest', 'v0.170.0', '0.170.0-beta.1', '0.170.0-linux-arm64', '00.170.0']) {
    assert.throws(() => compareStableVersions(invalid, '0.169.20'), /exact stable version/);
  }
});

test('validates the npm latest response before proposing a bump', async () => {
  const response = (version) => async () => Response.json({ name: '@openai/codex', version });
  assert.equal(await readLatestStable(response('0.170.0')), '0.170.0');
  await assert.rejects(readLatestStable(response('0.171.0-alpha.1')), /exact stable version/);
  await assert.rejects(readLatestStable(async () => new Response('', { status: 503 })), /503/);
});

test('requires streamed fixture text and a native Codex session ID before accepting a turn', () => {
  const makeFrame = (name, ...args) => ({ type: 'event', name, args });
  const done = makeFrame('onDone', 'test-session');
  const frames = [makeFrame('onToken', 'candidate '), makeFrame('onToken', 'works'), done];
  assert.equal(assertSmokeTurn(frames, 'candidate works'), 'test-session');
  assert.throws(() => assertSmokeTurn([done], 'candidate works'), /stream/);
  assert.throws(() => assertSmokeTurn([makeFrame('onError', 'fixture failed')], 'candidate works'), /fixture failed/);
  assert.throws(() => assertSmokeTurn([makeFrame('onToken', 'candidate works'), makeFrame('onDone', '')], 'candidate works'), /native/);
});

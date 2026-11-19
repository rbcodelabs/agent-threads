import assert from 'node:assert/strict';
import { test } from 'node:test';

let maintenance;
let smoke;
try {
  maintenance = await import('../../scripts/codex-harness-version.mjs');
  smoke = await import('../../scripts/codex-candidate-smoke.mjs');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

test('reports only stable upstream versions newer than the exact pin', () => {
  assert.ok(maintenance?.compareStableVersions, 'stable release comparison is missing');
  const { compareStableVersions } = maintenance;
  assert.equal(compareStableVersions('0.170.0', '0.169.20'), 1);
  assert.equal(compareStableVersions('0.170.0', '0.170.0'), 0);
  assert.equal(compareStableVersions('0.170.0', '0.171.0'), -1);
  for (const invalid of ['latest', 'v0.170.0', '0.170.0-beta.1', '0.170.0-linux-arm64', '00.170.0']) {
    assert.throws(() => compareStableVersions(invalid, '0.169.20'), /exact stable version/);
  }
});

test('validates the npm latest response before proposing a bump', async () => {
  assert.ok(maintenance?.readLatestStable, 'registry version detection is missing');
  const response = (version) => async () => Response.json({ name: '@openai/codex', version });
  assert.equal(await maintenance.readLatestStable(response('0.170.0')), '0.170.0');
  await assert.rejects(maintenance.readLatestStable(response('0.171.0-alpha.1')), /exact stable version/);
  await assert.rejects(maintenance.readLatestStable(async () => new Response('', { status: 503 })), /503/);
});

test('requires streamed fixture text and a native Codex session ID before accepting a turn', () => {
  assert.ok(smoke?.assertSmokeTurn, 'real session smoke assertions are missing');
  const makeFrame = (name, ...args) => ({ type: 'event', name, args });
  const done = makeFrame('onDone', 'test-session');
  const frames = [makeFrame('onToken', 'candidate '), makeFrame('onToken', 'works'), done];
  assert.equal(smoke.assertSmokeTurn(frames, 'candidate works'), 'test-session');
  assert.throws(() => smoke.assertSmokeTurn([done], 'candidate works'), /stream/);
  assert.throws(() => smoke.assertSmokeTurn([makeFrame('onError', 'fixture failed')], 'candidate works'), /fixture failed/);
  assert.throws(() => smoke.assertSmokeTurn([makeFrame('onToken', 'candidate works'), makeFrame('onDone', '')], 'candidate works'), /native/);
});

import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readCandidates, validateAntigravityArtifact } from '../../scripts/managed-harness-versions.mjs';

const pins = JSON.parse(await readFile(new URL('../../sandbox/harness-versions.json', import.meta.url), 'utf8'));
const { version, artifacts } = pins.antigravity;

function releaseRequest(armVersion = version) {
  return async (url) => {
    if (url.endsWith('/stable')) return new Response(pins.claude + '\n');
    const arch = url.endsWith('/linux_arm64.json') ? 'arm64' : 'amd64';
    return Response.json({ version: arch === 'arm64' ? armVersion : version, ...artifacts[arch] });
  };
}

test('accepts reviewed artifacts for both Linux architectures', async () => {
  assert.deepEqual(await readCandidates(releaseRequest()), pins);
});

test('rejects release metadata that disagrees across architectures', async () => {
  await assert.rejects(readCandidates(releaseRequest('0.0.1')), /disagree/);
});

test('rejects wrong architecture, untrusted URL and missing checksum', () => {
  assert.throws(() => validateAntigravityArtifact('arm64', { version, ...artifacts.amd64 }), /invalid/i);
  assert.throws(() => validateAntigravityArtifact('amd64', { version, ...artifacts.amd64, url: 'https://example.test/agy' }), /invalid/i);
  assert.throws(() => validateAntigravityArtifact('amd64', { version, url: artifacts.amd64.url }), /invalid/i);
});

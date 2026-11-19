#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { compareStableVersions } from './codex-harness-version.mjs';

const pinFile = new URL('../sandbox/harness-versions.json', import.meta.url);
const claudeStable = 'https://downloads.claude.ai/claude-code-releases/stable';
const googleManifests = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests';
const architectures = ['amd64', 'arm64'];

async function fetchRelease(request, url) {
  const response = await request(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Release metadata returned HTTP ${response.status} for ${url}.`);
  return response;
}

export function validateAntigravityArtifact(arch, { version, url, sha512 }) {
  compareStableVersions(version, version);
  const escaped = version.replace(/\./g, '[.]');
  const platform = arch === 'amd64' ? 'linux-x64/cli_linux_x64' : 'linux-arm/cli_linux_arm64';
  const path = new RegExp(`^${escaped}-[0-9]+/${platform}[.]tar[.]gz$`);
  const prefix = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/';
  if (typeof url !== 'string' || !url.startsWith(prefix) || !path.test(url.slice(prefix.length))
    || typeof sha512 !== 'string' || !/^[a-f0-9]{128}$/.test(sha512)) {
    throw new Error(`Invalid Antigravity release artifact for Linux ${arch}.`);
  }
  return { url, sha512 };
}

export async function readCandidates(request = fetch) {
  const [claudeResponse, ...releases] = await Promise.all([
    fetchRelease(request, claudeStable),
    ...architectures.map(async (arch) => (await fetchRelease(request, `${googleManifests}/linux_${arch}.json`)).json()),
  ]);
  const claude = (await claudeResponse.text()).trim();
  compareStableVersions(claude, claude);
  const version = releases[0].version;
  if (releases.some((release) => release.version !== version)) {
    throw new Error('Antigravity release manifests disagree across architectures.');
  }
  const artifacts = Object.fromEntries(architectures.map((arch, i) => [arch, validateAntigravityArtifact(arch, releases[i])]));
  return { claude, antigravity: { version, artifacts } };
}

async function main(args) {
  if (args.length > 1 || (args.length && args[0] !== '--write')) {
    throw new Error('Usage: node scripts/managed-harness-versions.mjs [--write]');
  }
  const current = JSON.parse(await readFile(pinFile, 'utf8'));
  const candidate = await readCandidates();
  const next = { ...current };
  for (const arch of architectures) {
    validateAntigravityArtifact(arch, { version: current.antigravity.version, ...current.antigravity.artifacts[arch] });
  }
  if (compareStableVersions(candidate.claude, current.claude) > 0) next.claude = candidate.claude;
  if (compareStableVersions(candidate.antigravity.version, current.antigravity.version) > 0) next.antigravity = candidate.antigravity;
  console.log(`Claude: ${current.claude} pinned, ${candidate.claude} stable`);
  console.log(`Antigravity: ${current.antigravity.version} pinned, ${candidate.antigravity.version} offered for both Linux architectures`);
  if (args[0] === '--write' && JSON.stringify(next) !== JSON.stringify(current)) {
    await writeFile(pinFile, `${JSON.stringify(next, null, 2)}\n`);
    console.log('Updated sandbox/harness-versions.json for review.');
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

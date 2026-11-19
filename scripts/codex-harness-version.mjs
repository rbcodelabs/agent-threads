#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const pinFile = new URL('../sandbox/codex-version.json', import.meta.url);
const latestUrl = 'https://registry.npmjs.org/@openai%2fcodex/latest';
const stableVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function versionParts(version) {
  const match = typeof version === 'string' && stableVersion.exec(version);
  if (!match) throw new Error('Expected an exact stable version (major.minor.patch).');
  return match.slice(1).map(BigInt);
}

export function compareStableVersions(candidate, pin) {
  const pinnedParts = versionParts(pin);
  for (const [index, part] of versionParts(candidate).entries()) {
    if (part > pinnedParts[index]) return 1;
    if (part < pinnedParts[index]) return -1;
  }
  return 0;
}

export async function readLatestStable(request = fetch) {
  const response = await request(latestUrl, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}.`);
  const { name, version } = await response.json();
  if (name !== '@openai/codex') throw new Error('npm registry response was for a different package.');
  versionParts(version);
  return version;
}

async function main(args) {
  const [option] = args;
  if (args.length > 1 || (option && option !== '--print-pin' && option !== '--write')) {
    throw new Error('Usage: node scripts/codex-harness-version.mjs [--print-pin | --write]');
  }
  const { version: pin } = JSON.parse(await readFile(pinFile, 'utf8'));
  versionParts(pin);
  if (option === '--print-pin') {
    console.log(pin);
    return;
  }
  const candidate = await readLatestStable();
  const comparison = compareStableVersions(candidate, pin);
  if (comparison > 0) {
    console.log(`Stable Codex update available: ${pin} -> ${candidate}`);
    if (option === '--write') {
      await writeFile(pinFile, `${JSON.stringify({ version: candidate }, null, 2)}\n`);
      console.log('Updated sandbox/codex-version.json for review.');
    }
  } else if (comparison < 0) {
    console.log(`Codex pin ${pin} is ahead of the npm latest tag (${candidate}).`);
  } else {
    console.log(`Codex pin ${pin} matches the npm latest tag.`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

// Opt-in live integration probe: node scripts/smoke-sandbox-vm.mjs [image]
// Requires a running Apple container service. Uses only a synthetic temp workspace.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), 'agent-threads-vm-smoke-'));
const workspace = join(scratch, 'workspace');
const { mkdir } = await import('node:fs/promises');
await mkdir(workspace);
await writeFile(join(scratch, 'outside.txt'), 'synthetic host-only sentinel');
await symlink(join(scratch, 'outside.txt'), join(workspace, 'outside-link'));
await writeFile(join(workspace, 'input.txt'), 'fixture');
const bundle = join(scratch, 'manager.cjs');
await build({ entryPoints: [join(root, 'src/sandboxVm.ts')], outfile: bundle,
  platform: 'node', format: 'cjs', bundle: true });
const { SandboxVmManager, containerNameForThread, DEFAULT_VM_IMAGE } = createRequire(import.meta.url)(bundle);
const image = process.argv[2] || DEFAULT_VM_IMAGE;
const identity = `smoke-${process.pid}-${Date.now()}`;
const manager = new SandboxVmManager({ containerName: () => containerNameForThread(identity) });
const checks = [];
let active = false;
async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function run(command, timeoutSeconds = 30) {
  const result = await manager.execCommand({ command, timeoutSeconds });
  assert.equal(result.success, true, JSON.stringify(result));
  return result;
}
async function enter(network) {
  const result = await manager.enter({ image, mountPath: workspace, network });
  assert.equal(result.success, true, JSON.stringify(result));
  active = true;
}
async function exit() {
  const result = await manager.exit();
  assert.equal(result.success, true, JSON.stringify(result));
  active = false;
}
try {
  await enter('default');
  await check('Linux guest, non-root toolchain and mounted workspace', async () => {
    const result = await run('test "$(uname -s)" = Linux && test "$(id -u)" != 0 && test "$PWD" = /work && test "$(cat input.txt)" = fixture && node --version && npm --version && git --version && command -v timeout');
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    console.log(result.stdout.trim());
  });
  await check('Host paths and symlink escape inaccessible', async () => {
    const result = await run('test ! -e /Users && test ! -e outside-link');
    assert.equal(result.exitCode, 0, JSON.stringify(result));
  });
  await check('Guest writes persist through explicit workspace mount', async () => {
    assert.equal((await run('printf guest-write > result.txt && touch /tmp/guest-marker')).exitCode, 0);
    assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'guest-write');
  });
  await check('Default internet access by DNS and raw IP', async () => {
    const result = await run('curl -fsS --max-time 10 https://registry.npmjs.org/-/ping >/dev/null && curl -fsS --max-time 10 http://1.1.1.1 >/dev/null');
    assert.equal(result.exitCode, 0, JSON.stringify(result));
  });
  await check('Guest timeout stops late writes', async () => {
    const result = await run('sleep 4; touch /work/late-write', 1);
    assert.notEqual(result.exitCode, 0, JSON.stringify(result));
    const after = await run('sleep 5; test ! -e /work/late-write');
    assert.equal(after.exitCode, 0, JSON.stringify(after));
  });
  await exit();
  await enter('none');
  await check('New guest resets guest-only state, preserves workspace', async () => {
    assert.equal((await run('test ! -e /tmp/guest-marker && test "$(cat result.txt)" = guest-write')).exitCode, 0);
  });
  for (const network of ['none', 'internal']) {
    if (network === 'internal') { await exit(); await enter(network); }
    await check(`${network} blocks DNS and raw-IP internet access`, async () => {
      // Verify curl exists first: a missing probe binary must never count as isolation.
      assert.equal((await run('command -v curl')).exitCode, 0);
      for (const url of ['https://registry.npmjs.org/-/ping', 'http://1.1.1.1']) {
        const result = await run(`curl -fsS --max-time 4 '${url}' >/dev/null`);
        assert.ok([6, 7, 28].includes(result.exitCode), JSON.stringify(result));
        console.log(`${network} ${url}: curl exit ${result.exitCode}`);
      }
    });
  }
  await exit();
  await check('Exec after cleanup reports no VM', async () => {
    const result = await manager.execCommand({ command: 'true', timeoutSeconds: 5 });
    assert.equal(result.success, false);
    assert.match(result.error, /No sandbox VM/);
  });
  console.log(JSON.stringify({ result: 'PASS', checks: checks.length, image }));
} finally {
  if (active) {
    const result = await manager.exit({ force: true });
    if (!result.success) throw new Error(`VM cleanup failed; scratch preserved at ${scratch}: ${result.error}`);
  }
  await rm(scratch, { recursive: true, force: true });
}

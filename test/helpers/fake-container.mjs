#!/usr/bin/env node
// A fake `container` CLI for the local-daemon tests. State lives in a JSON file named by
// FAKE_CONTAINER_STATE so state survives across the one-process-per-call runner, exactly like the real CLI.
//
// Failure injection: FAKE_CONTAINER_FAIL is a comma list of
//   pull:denied | pull:404 | pull:network | build | run:port-in-use | run:name | exec:token | volume
// and the state file can carry flags (state.unhealthy, state.eaccess) set by a test.
import { readFileSync, writeFileSync, existsSync, readFileSync as read } from 'node:fs';

const file = process.env.FAKE_CONTAINER_STATE;
if (!file) { console.error('FAKE_CONTAINER_STATE is required'); process.exit(99); }
const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { images: {}, volumes: {}, containers: {}, tokens: [], calls: [] });
const save = (s) => writeFileSync(file, JSON.stringify(s));
const fails = new Set((process.env.FAKE_CONTAINER_FAIL ?? '').split(',').filter(Boolean));

const args = process.argv.slice(2);
const state = load();
state.calls.push(args.filter((a) => a !== '-c').map((a) => (a.length > 200 ? `${a.slice(0, 60)}...` : a)));
const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);
const done = (code = 0) => { save(state); process.exit(code); };
const stdin = () => { try { return read(0, 'utf8'); } catch { return ''; } };

function flag(name, list = args) {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
}
function flagAll(name, list = args) {
  const v = [];
  list.forEach((a, i) => { if (a === name) v.push(list[i + 1]); });
  return v;
}

const [a, b] = args;

if (a === 'image' && b === 'inspect') {
  const ref = args[2];
  if (!state.images[ref]) { err(`image ${ref} not found`); done(1); }
  out(JSON.stringify([{ id: `sha256:${ref}`, variants: [] }]));
  done(0);
}

if (a === 'image' && b === 'pull') {
  const ref = args[args.length - 1];
  if (fails.has('pull:denied')) { err(`Error: pull access denied for ${ref}: unauthorized`); done(1); }
  if (fails.has('pull:404')) { err(`Error: manifest unknown: ${ref} not found`); done(1); }
  if (fails.has('pull:network')) { err('Error: dial tcp: could not resolve host ghcr.io'); done(1); }
  out('pulling layer 50%');
  state.images[ref] = { published: true };
  done(0);
}

if (a === 'image' && b === 'rm') {
  delete state.images[args[2]];
  done(0);
}

if (a === 'build') {
  if (fails.has('build')) { err('curl: (6) Could not resolve host: claude.ai'); done(1); }
  const buildArgs = Object.fromEntries(flagAll('--build-arg').map((a) => { const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)]; }));
  const base = buildArgs.BASE_IMAGE;
  const dockerfileText = readFileSync(flag('-f'), 'utf8');
  // The CLIs the built image carries: Claude if its layer is in the Dockerfile, Codex/OpenCode if the build arg is 1.
  const harnesses = [
    ...(dockerfileText.includes('claude.ai/install.sh') ? ['claude'] : []),
    ...(buildArgs.INSTALL_CODEX === '1' && dockerfileText.includes('with-harnesses') ? ['codex'] : []),
    ...(buildArgs.INSTALL_OPENCODE === '1' && dockerfileText.includes('with-harnesses') ? ['opencode'] : []),
  ];
  if (!state.images[base]) { err(`base image ${base} not found`); done(1); }
  const dockerfile = readFileSync(flag('-f'), 'utf8');
  if (!dockerfile.includes('FROM ${BASE_IMAGE}')) { err('Dockerfile does not use BASE_IMAGE'); done(1); }
  state.images[flag('--tag')] = { built: true, label: flag('--label'), harnesses, buildArgs };
  out('build done');
  done(0);
}

if (a === 'volume') {
  const name = args[2];
  if (b === 'create') {
    if (fails.has('volume')) { err('volume create failed'); done(1); }
    if (state.volumes[name]) { err(`volume ${name} already exists`); done(1); }
    state.volumes[name] = { owner: 0 };
    done(0);
  }
  if (b === 'inspect') { if (state.volumes[name]) { out('[{}]'); done(0); } err('not found'); done(1); }
  if (b === 'delete' || b === 'rm') { delete state.volumes[name]; done(0); }
}

if (a === 'run') {
  const image = args.find((x, i) => i > 0 && state.images[x]);
  const detach = args.includes('--detach') || args.includes('-d');
  if (!detach) {
    // one-shot: verify or prepare
    const script = args[args.indexOf('-c') + 1] ?? '';
    if (script.includes('LOCAL_DAEMON_IMAGE_OK')) {
      const missing = ['claude', 'codex', 'opencode'].filter((h) => script.includes(`command -v ${h} `) && !(state.images[image]?.harnesses ?? ['claude']).includes(h));
      if (missing.length) { err(`${missing[0]}: not found`); done(1); }
      if (state.images[image]?.built) { out('/opt/claude/.local/bin/claude\n/usr/local/bin/agent-threads\n/usr/bin/git\nLOCAL_DAEMON_IMAGE_OK'); done(0); }
      err('claude: not found'); done(1);
    }
    const vols = flagAll('--volume').map((v) => v.split(':')[0]);
    for (const v of vols) if (!state.volumes[v]) { err(`volume ${v} not found`); done(1); }
    const dataVol = vols.find((v) => v.endsWith('-data'));
    if (args.includes('-u') && flag('-u') !== '0') { err('prepare needs root'); done(1); }
    if (script.includes('cat >')) {
      const credential = stdin().trim();
      if (!credential) { err('credential was not received on stdin'); done(3); }
      state.volumes[dataVol].credential = credential;
    }
    for (const v of vols) state.volumes[v].owner = 10001;
    done(0);
  }
  const name = flag('--name');
  if (fails.has('run:name') || state.containers[name]) { err(`container ${name} already exists`); done(1); }
  const publish = flag('-p') ?? '';
  const hostPort = Number(publish.split(':')[1]);
  if (fails.has('run:port-in-use') || state.portsTaken?.includes(hostPort)
    || Object.values(state.containers).some((c) => c.state === 'running' && c.hostPort === hostPort)) {
    err(`Error: address already in use: 127.0.0.1:${hostPort}`); done(1);
  }
  const volumes = flagAll('--volume');
  for (const v of volumes) {
    const src = v.split(':')[0];
    if (!src.startsWith('/') && !state.volumes[src]) { err(`volume ${src} not found`); done(1); }
  }
  const labels = Object.fromEntries(flagAll('--label').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  state.containers[name] = {
    state: 'running', labels, publish, hostPort, volumes, image,
    env: flagAll('--env'), memory: flag('--memory'), cpus: flag('--cpus'), cmd: args.slice(args.indexOf(image) + 1),
  };
  out(name);
  done(0);
}

if (a === 'inspect') {
  const c = state.containers[args[1]];
  if (!c) { err('not found'); done(1); }
  out(JSON.stringify([{ status: c.state, configuration: { id: args[1], labels: c.labels } }]));
  done(0);
}

if (a === 'start') {
  const c = state.containers[args[1]];
  if (!c) { err('not found'); done(1); }
  if (Object.values(state.containers).some((o) => o !== c && o.state === 'running' && o.hostPort === c.hostPort) || state.portsTaken?.includes(c.hostPort)) {
    err(`Error: address already in use: 127.0.0.1:${c.hostPort}`); done(1);
  }
  c.state = 'running';
  done(0);
}
if (a === 'stop' || a === 'kill') {
  const c = state.containers[args[1]];
  if (!c) { err('not found'); done(1); }
  // stop:wedged / kill:wedged = the VM ignores it until the host helper process is ended (state.helperKilled)
  if (fails.has(`${a}:wedged`) && !state.helperKilled) { err('timed out'); done(1); }
  c.state = 'stopped';
  done(0);
}
if (a === 'rm') {
  delete state.containers[args[args.length - 1]];
  done(0);
}
if (a === 'logs') {
  const c = state.containers[args[1]];
  out(state.eaccess ? 'Error: EACCES: permission denied, mkdir /var/lib/agent-threads/journal' : 'daemon listening');
  done(c ? 0 : 1);
}

if (a === 'exec') {
  const rest = args.slice(1);
  const ui = rest.indexOf('--user');
  const afterUser = ui >= 0 ? rest.slice(ui + 2) : rest;
  const name = afterUser[0];
  const c = state.containers[name];
  if (!c || c.state !== 'running') { err(`container ${name} is not running`); done(1); }
  const cmd = afterUser.slice(1);
  if (cmd[0] === 'sh' && cmd[1] === '-c' && String(cmd[2]).includes('codex.auth')) {
    // The harness probe: CLIs from the image the container runs, logins from the data volume (state.volumes[v].auth).
    const dataVol = c.volumes.map((v) => v.split(':')[0]).find((v) => v.endsWith('-data'));
    const have = state.images[c.image]?.harnesses ?? ['claude'];
    if (fails.has('exec:probe')) { err('probe failed'); done(1); }
    for (const h of ['claude', 'codex', 'opencode']) out(`${h}.cli=${have.includes(h) ? 1 : 0}`);
    for (const h of ['codex', 'opencode']) out(`${h}.auth=${state.volumes[dataVol]?.auth?.[h] ? 1 : 0}`);
    done(0);
  }
  if (cmd[0] === 'test' && cmd[1] === '-s') {
    const dataVol = c.volumes.map((v) => v.split(':')[0]).find((v) => v.endsWith('-data'));
    done(state.volumes[dataVol]?.credential ? 0 : 1);
  }
  if (cmd[0] === 'agent-threads' && cmd[1] === 'token') {
    if (fails.has('exec:token')) { err('token store unavailable'); done(1); }
    const sub = cmd[2];
    const dataVol = c.volumes.map((v) => v.split(':')[0]).find((v) => v.endsWith('-data'));
    const vol = state.volumes[dataVol];
    vol.tokens = vol.tokens ?? [];
    if (sub === 'create') {
      const id = `tok${vol.tokens.length + 1}`;
      const token = `secret-${id}-${Math.random().toString(16).slice(2)}`;
      vol.tokens.push({ id, name: flag('--name', cmd), token, revokedAt: null });
      out(JSON.stringify({ id, name: flag('--name', cmd), scope: flag('--scope', cmd), token }));
      done(0);
    }
    if (sub === 'list') {
      for (const t of vol.tokens) out(JSON.stringify({ id: t.id, name: t.name, scope: 'control', createdAt: 1, lastUsedAt: null, revokedAt: t.revokedAt }));
      done(0);
    }
    if (sub === 'revoke') {
      const t = vol.tokens.find((x) => x.id === cmd[3] || x.name === cmd[3]);
      if (!t) { err('no active token'); done(1); }
      t.revokedAt = 2;
      out(`revoked ${cmd[3]}`);
      done(0);
    }
  }
  err(`unsupported exec: ${cmd.join(' ')}`);
  done(2);
}

err(`fake container: unsupported command: ${args.join(' ')}`);
done(98);

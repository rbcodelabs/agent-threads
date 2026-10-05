/**
 * vmPortForward.ts — make a server the agent started INSIDE the sandbox
 * container reachable from the HOST-side browser tools.
 *
 * ## The problem
 *
 * A VM-routed thread runs `vm_exec` commands (and, under ADR-0015, the whole
 * harness) in a Linux container. The browser tools (`browser_navigate`,
 * `obsidian_open_url` / `host_open_url`) run on the host. So when the agent
 * starts `python3 -m http.server` in the container and opens
 * `http://127.0.0.1:8000/`, the host resolves 127.0.0.1 to the Mac itself and
 * the connection is refused.
 *
 * ## Why a relay rather than the container's IP or `--publish`
 *
 * Measured against the real `container` 1.5.0 runtime:
 *
 *   - The container has a host-reachable IP (192.168.64.x), but a server bound
 *     to 127.0.0.1 INSIDE the guest is not reachable through it; only 0.0.0.0
 *     binds are. Most dev servers default to loopback, so rewriting to the
 *     container IP alone fixes the minority case.
 *   - `container run --publish` exists, but ports are fixed at creation (there
 *     is no `update`), the agent picks ports later, and a published port also
 *     reaches the guest's eth0 address — so a 127.0.0.1-bound guest server is
 *     still unreachable.
 *   - `container exec -i <name> node -e <relay>` connects to the guest's own
 *     loopback and works for BOTH bind styles, costs ~60 ms per connection, and
 *     needs only Node, which both sandbox images ship.
 *
 * So: a host listener on an ephemeral 127.0.0.1 port; each accepted connection
 * spawns one guest relay whose stdio is piped to the socket. The browser URL is
 * rewritten to that host port. Nothing is exposed beyond host loopback.
 *
 * Node's `net` is required lazily: this plugin also loads on mobile where
 * Node builtins are absent. Importing this module is always safe.
 */

/** A spawned guest relay: byte pipes plus lifecycle, matching the subset of ChildProcess we use. */
export interface RelayProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  kill(): void;
  onExit(cb: (code: number | null) => void): void;
}

export type GuestProbeResult = 'open' | 'closed' | 'error';

/** Thrown for failures the agent can act on. `message` says what is wrong; `hint` says what to do. */
export class VmLoopbackError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = 'VmLoopbackError';
    this.hint = hint;
  }
}

export type VmUrlResolution =
  | { kind: 'passthrough' }
  | { kind: 'forwarded'; url: string; requestedUrl: string; hostPort: number; guestPort: number; note: string };

// ── URL handling ─────────────────────────────────────────────────────────────

export interface ParsedLoopbackUrl {
  url: URL;
  port: number;
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  return /^127(\.\d{1,3}){3}$/.test(h);
}

/** The URL and effective port when `input` is an http(s) URL addressing the local machine; otherwise null. */
export function parseLoopbackHttpUrl(input: string): ParsedLoopbackUrl | null {
  let url: URL;
  try {
    url = new URL((input ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isLoopbackHostname(url.hostname)) return null;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return { url, port };
}

/** Same URL with host 127.0.0.1 and the forwarded host port. Credentials are dropped. */
export function rewriteToHostPort(parsed: ParsedLoopbackUrl, hostPort: number): string {
  const u = new URL(parsed.url.toString());
  u.hostname = '127.0.0.1';
  u.port = String(hostPort);
  u.username = '';
  u.password = '';
  return u.toString();
}

// ── Guest relay ──────────────────────────────────────────────────────────────

/**
 * Runs inside the guest under `node -e`. Connects to the guest's loopback
 * (IPv4 first, then IPv6, since `localhost` servers on Node 18+ can bind
 * ::1 only) and pipes stdio. Exit 3 = connection refused; with `probe` it only
 * checks that a connection can be made.
 */
export const GUEST_RELAY_SCRIPT = [
  "const net=require('net');",
  'const port=Number(process.argv[1]);const probe=process.argv[2]==="probe";',
  "const hosts=['127.0.0.1','::1'];let i=0;",
  'function go(){',
  'const s=net.connect({port,host:hosts[i++]});let up=false;',
  "s.once('connect',()=>{up=true;if(probe){process.exit(0);}process.stdin.pipe(s);s.pipe(process.stdout);});",
  "s.on('error',()=>{if(!up&&i<hosts.length){go();return;}process.exit(3);});",
  // `close` also follows a failed attempt; only a connection that was up may end the process.
  "s.on('close',()=>{if(up)process.exit(0);});",
  "process.stdin.on('end',()=>s.end());",
  '}',
  'go();',
].join('');

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
}

/** argv for `container <args>`: run the relay (or, with `probe`, a connect-only check) in the guest. */
export function buildGuestRelayArgs(containerName: string, port: number, opts: { probe?: boolean } = {}): string[] {
  assertPort(port);
  return [
    'exec', '--interactive', containerName,
    'node', '-e', GUEST_RELAY_SCRIPT, String(port),
    ...(opts.probe ? ['probe'] : []),
  ];
}

/** Exit codes the relay script uses, for interpreting a probe. */
export function interpretProbeExit(exitCode: number): GuestProbeResult {
  if (exitCode === 0) return 'open';
  if (exitCode === 3) return 'closed';
  return 'error';
}

// ── Host probe ───────────────────────────────────────────────────────────────

/** True when something accepts a TCP connection on host 127.0.0.1:port (500 ms budget). */
export function probeHostLoopbackPort(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let net: typeof import('net');
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      net = require('net') as typeof import('net');
    } catch {
      resolve(false);
      return;
    }
    if (!net?.connect) { resolve(false); return; }
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// ── Forwarder ────────────────────────────────────────────────────────────────

export interface VmPortForwarderDeps {
  containerName: () => string;
  /** Is something accepting connections on this port inside the guest? */
  probeGuestPort: (port: number) => Promise<GuestProbeResult>;
  /** Is something accepting connections on this port on the host? */
  probeHostPort: (port: number) => Promise<boolean>;
  /** Starts a guest relay to `port`. One per accepted connection. */
  spawnRelay: (containerName: string, port: number) => RelayProcess;
}

interface Listener {
  server: import('net').Server;
  hostPort: number;
  sockets: Set<import('net').Socket>;
}

const NOT_LISTENING_HINT =
  'Start the server first and keep it running: vm_exec returns when its command ends, so run it in the background ' +
  '(e.g. `nohup python3 -m http.server 8000 >/tmp/server.log 2>&1 &`), then confirm with `curl -s localhost:8000` inside vm_exec.';

/**
 * Per-thread forwarder. One host listener per guest port, created on demand and
 * reused; `close()` tears everything down (called when the VM is removed).
 */
export class VmPortForwarder {
  private readonly deps: VmPortForwarderDeps;
  private readonly listeners = new Map<number, Listener>();
  private readonly pending = new Map<number, Promise<Listener>>();

  constructor(deps: VmPortForwarderDeps) {
    this.deps = deps;
  }

  /**
   * Decide what a host-side tool should open for `url`.
   *
   * - Not a loopback URL: `passthrough`, with no side effects.
   * - Something listens in the guest on that port: forward it, return the
   *   rewritten URL.
   * - Guest port closed but the host itself has a server there: `passthrough`
   *   (the agent meant the host's server).
   * - Neither: throw {@link VmLoopbackError} instead of letting the browser
   *   fail with an opaque ERR_CONNECTION_REFUSED.
   */
  async resolve(url: string): Promise<VmUrlResolution> {
    const parsed = parseLoopbackHttpUrl(url);
    if (!parsed) return { kind: 'passthrough' };
    const { port } = parsed;

    const guest = await this.deps.probeGuestPort(port);
    if (guest === 'error') {
      throw new VmLoopbackError(
        `Could not check whether anything is listening on port ${port} inside the sandbox VM.`,
        'The sandbox image needs `node` for host-to-sandbox port forwarding (both bundled images have it). Use the VM\'s IP address with a server bound to 0.0.0.0 as a fallback.',
      );
    }
    if (guest === 'closed') {
      if (await this.deps.probeHostPort(port)) return { kind: 'passthrough' };
      throw new VmLoopbackError(
        `Nothing is listening on port ${port} inside the sandbox VM (and nothing on the host either), so ${url} cannot be opened.`,
        NOT_LISTENING_HINT,
      );
    }

    const listener = await this.ensureListener(port);
    return {
      kind: 'forwarded',
      url: rewriteToHostPort(parsed, listener.hostPort),
      requestedUrl: url,
      hostPort: listener.hostPort,
      guestPort: port,
      note:
        `Port ${port} is inside the sandbox VM, so it is forwarded to http://127.0.0.1:${listener.hostPort}/ on this Mac (loopback only). ` +
        'Absolute links in the page that name the original port will not resolve; use relative links.',
    };
  }

  /** Bound address of every open listener (for tests and diagnostics). */
  listeningAddresses(): Array<{ address: string; port: number; guestPort: number }> {
    return [...this.listeners.entries()].map(([guestPort, l]) => {
      const a = l.server.address() as import('net').AddressInfo;
      return { address: a.address, port: a.port, guestPort };
    });
  }

  close(): void {
    for (const l of this.listeners.values()) {
      for (const s of l.sockets) s.destroy();
      l.server.close();
    }
    this.listeners.clear();
    this.pending.clear();
  }

  private ensureListener(guestPort: number): Promise<Listener> {
    const existing = this.listeners.get(guestPort);
    if (existing) return Promise.resolve(existing);
    const inflight = this.pending.get(guestPort);
    if (inflight) return inflight;
    const created = this.createListener(guestPort).finally(() => this.pending.delete(guestPort));
    this.pending.set(guestPort, created);
    return created;
  }

  private createListener(guestPort: number): Promise<Listener> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const net = require('net') as typeof import('net');
    return new Promise((resolve, reject) => {
      const sockets = new Set<import('net').Socket>();
      const server = net.createServer((client) => this.pipeConnection(client, guestPort, sockets));
      server.once('error', reject);
      // Loopback only, ephemeral port: never reachable from the LAN.
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        server.on('error', () => undefined);
        const listener: Listener = { server, hostPort: (server.address() as import('net').AddressInfo).port, sockets };
        this.listeners.set(guestPort, listener);
        resolve(listener);
      });
    });
  }

  private pipeConnection(client: import('net').Socket, guestPort: number, sockets: Set<import('net').Socket>): void {
    sockets.add(client);
    let relay: RelayProcess;
    try {
      relay = this.deps.spawnRelay(this.deps.containerName(), guestPort);
    } catch {
      client.destroy();
      sockets.delete(client);
      return;
    }
    client.on('error', () => undefined);
    relay.stdin.on?.('error', () => undefined);
    client.pipe(relay.stdin);
    relay.stdout.pipe(client);
    client.on('close', () => { sockets.delete(client); relay.kill(); });
    // Graceful end (not destroy) so bytes the relay already wrote still flush.
    relay.onExit(() => client.end());
  }
}

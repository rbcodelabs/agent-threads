/**
 * A small, generic Agent Client Protocol (ACP) client over a child process's stdio.
 *
 * ACP is NDJSON JSON-RPC 2.0: one JSON object per line in each direction. The client sends requests and
 * notifications, correlates responses by id, and answers requests the AGENT initiates (permission prompts, and
 * optionally `fs/*` and `terminal/*`). Nothing here is specific to one agent; `AntigravitySession` is the first
 * consumer (`agy acp`).
 *
 * Core module: no Obsidian or DOM imports. Node's `child_process` is required lazily inside the default launcher,
 * so importing this file stays inert on mobile, and tests inject a launcher instead of spawning a process.
 */

/** The wire to one agent process. Tests substitute a fake; production spawns a child process. */
export interface AcpChannel {
  /** Write one already-serialized message; the channel appends the newline. */
  write(line: string): void;
  /** Chunks from the agent's stdout (any split: a chunk may hold several lines or half of one). */
  onData(handler: (chunk: string) => void): void;
  /** The agent's stderr, for diagnostics only. */
  onStderr(handler: (chunk: string) => void): void;
  /** Fires once when the process exits or fails to start (`error` is set for a spawn failure). */
  onExit(handler: (info: { code: number | null; signal: string | null; error?: Error }) => void): void;
  kill(): void;
}

export interface AcpLaunchOptions {
  binaryPath: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}

export type AcpLauncher = (options: AcpLaunchOptions) => AcpChannel;

export interface AcpClientOptions extends AcpLaunchOptions {
  launcher?: AcpLauncher;
  /** How long the handshake (and session setup, when callers reuse it) may take. Cold starts of a real agent exceed 20s. */
  startTimeoutMs?: number;
  /** Appended to a "binary not found" failure so the user knows what to install. */
  installHint?: string;
  /** Shown in error messages, e.g. `Antigravity`. */
  label?: string;
}

/** A JSON-RPC error answer from the agent. */
export class AcpRpcError extends Error {
  constructor(message: string, readonly code: number, readonly data?: unknown) {
    super(message);
    this.name = 'AcpRpcError';
  }
}

export const ACP_DEFAULT_START_TIMEOUT_MS = 60_000;
const STDERR_TAIL_BYTES = 4096;
const KILL_ESCALATION_MS = 3000;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout>; method: string };
type RequestHandler = (params: any, id: string | number) => unknown | Promise<unknown>;
type NotificationHandler = (params: any) => void;

/** The default launcher: spawn the binary with piped stdio (desktop only). */
export const spawnAcpChannel: AcpLauncher = (options) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawn } = require('child_process') as typeof import('child_process');
  const child = spawn(options.binaryPath, options.args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let exitHandler: ((info: { code: number | null; signal: string | null; error?: Error }) => void) | undefined;
  let exited = false;
  const finish = (info: { code: number | null; signal: string | null; error?: Error }) => {
    if (exited) return;
    exited = true;
    exitHandler?.(info);
  };
  child.on('error', (error) => finish({ code: null, signal: null, error }));
  child.on('exit', (code, signal) => finish({ code, signal }));
  // A write to a dead pipe must surface through onExit, not as an unhandled 'error' event.
  child.stdin.on('error', () => undefined);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return {
    write: (line) => { if (!exited && child.stdin.writable) child.stdin.write(`${line}\n`); },
    onData: (handler) => { child.stdout.on('data', handler); },
    onStderr: (handler) => { child.stderr.on('data', handler); },
    onExit: (handler) => { exitHandler = handler; if (exited) handler({ code: null, signal: null }); },
    kill: () => {
      if (exited) return;
      child.kill('SIGTERM');
      // Never leave an orphaned agent behind if SIGTERM is ignored.
      const escalate = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, KILL_ESCALATION_MS);
      (escalate as { unref?: () => void }).unref?.();
    },
  };
};

export class AcpClient {
  private channel: AcpChannel | null = null;
  private nextId = 1;
  private buffer = '';
  private stderrTail = '';
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private closeHandler: ((error?: Error) => void) | null = null;
  private protocolErrorHandler: ((line: string, error: Error) => void) | null = null;
  private lastClose: { error?: Error } | null = null;

  constructor(private readonly options: AcpClientOptions) {}

  get label(): string { return this.options.label ?? 'ACP agent'; }
  get startTimeoutMs(): number { return this.options.startTimeoutMs ?? ACP_DEFAULT_START_TIMEOUT_MS; }
  get isClosed(): boolean { return this.closed; }

  /** Register a handler for agent-initiated requests. The return value (or a thrown error) becomes the reply. */
  onRequest(method: string, handler: RequestHandler): void { this.requestHandlers.set(method, handler); }

  /** Register a handler for agent notifications such as `session/update`. */
  onNotification(method: string, handler: NotificationHandler): void { this.notificationHandlers.set(method, handler); }

  /** Called exactly once when the agent process ends or fails (also after `close()`, without an error). */
  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
    if (this.lastClose) handler(this.lastClose.error);
  }

  /** Lines that were not valid JSON-RPC; surfaced for the raw log, never fatal. */
  onProtocolError(handler: (line: string, error: Error) => void): void { this.protocolErrorHandler = handler; }

  /** Spawn the agent. Spawn failures arrive asynchronously through `onClose` and fail pending requests. */
  spawn(): void {
    if (this.channel) throw new Error(`${this.label} is already running`);
    const launcher = this.options.launcher ?? spawnAcpChannel;
    this.closed = false;
    this.lastClose = null;
    this.buffer = '';
    this.stderrTail = '';
    const channel = launcher({ binaryPath: this.options.binaryPath, args: this.options.args, cwd: this.options.cwd, env: this.options.env });
    this.channel = channel;
    channel.onData((chunk) => this.receive(chunk));
    channel.onStderr((chunk) => { this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES); });
    channel.onExit((info) => this.handleExit(info));
  }

  /** Send a request and wait for its result. `timeoutMs` rejects (and abandons) the request; 0 disables the timer. */
  request<T = any>(method: string, params?: unknown, timeoutMs = 0): Promise<T> {
    if (!this.channel || this.closed) return Promise.reject(new Error(`${this.label} is not running`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (value: unknown) => void, reject, method };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${this.label} did not answer ${method} within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`}.${this.stderrHint()}`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.channel || this.closed) return;
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** Kill the child and reject everything still waiting. Safe to call repeatedly. */
  close(): void {
    if (this.closed && !this.channel) return;
    this.closed = true;
    const channel = this.channel;
    this.channel = null;
    this.failPending(new Error(`${this.label} was closed`));
    channel?.kill();
    this.lastClose = {};
    this.closeHandler?.();
  }

  private send(message: Record<string, unknown>): void {
    this.channel?.write(JSON.stringify(message));
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim()) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.protocolErrorHandler?.(line, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!message || typeof message !== 'object') return;
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method === 'string') {
      if (hasId) void this.answerRequest(message);
      else {
        try { this.notificationHandlers.get(message.method)?.(message.params); } catch (error) {
          this.protocolErrorHandler?.(line, error instanceof Error ? error : new Error(String(error)));
        }
      }
      return;
    }
    if (!hasId) return;
    const entry = this.pending.get(Number(message.id));
    if (!entry) return;
    this.pending.delete(Number(message.id));
    if (entry.timer) clearTimeout(entry.timer);
    if (message.error) entry.reject(new AcpRpcError(String(message.error.message ?? 'ACP error'), Number(message.error.code ?? -32000), message.error.data));
    else entry.resolve(message.result);
  }

  private async answerRequest(message: { id: string | number; method: string; params?: unknown }): Promise<void> {
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      return;
    }
    try {
      const result = await handler(message.params, message.id);
      this.send({ jsonrpc: '2.0', id: message.id, result: result ?? null });
    } catch (error) {
      this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private handleExit(info: { code: number | null; signal: string | null; error?: Error }): void {
    if (this.closed) return;
    this.closed = true;
    this.channel = null;
    let failure: Error;
    if (info.error) {
      const missing = (info.error as NodeJS.ErrnoException).code === 'ENOENT';
      failure = new Error(missing
        ? `Could not start ${this.label}: "${this.options.binaryPath}" was not found.${this.options.installHint ? ` ${this.options.installHint}` : ''}`
        : `Could not start ${this.label}: ${info.error.message}`);
    } else {
      failure = new Error(`${this.label} exited unexpectedly (${info.signal ? `signal ${info.signal}` : `code ${info.code}`}).${this.stderrHint()}`);
    }
    this.failPending(failure);
    this.lastClose = { error: failure };
    this.closeHandler?.(failure);
  }

  private stderrHint(): string {
    const tail = this.stderrTail.trim();
    return tail ? ` ${this.label} said: ${tail.slice(-500)}` : '';
  }

  private failPending(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}

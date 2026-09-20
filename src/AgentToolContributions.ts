/**
 * Host-owned registry of contributed agent tools (ADR-0008).
 *
 * This is the coupling ADR-0008 singled out as materially harder than the
 * rest: agent tools are bound per thread inside the MCP server factory, so
 * contributing one means changing how sessions are constructed, not adding a
 * method. The inversion here is the whole point — a peer supplies a
 * *thread-agnostic* `invoke`, and the host binds it per thread and injects the
 * calling thread id at invoke time. A peer never sees, receives or constructs
 * the factory.
 *
 * Three properties matter more than convenience:
 *
 * 1. **No shadowing.** A name that collides with a built-in host tool, a core
 *    agent tool (`Read`, `Bash`, …) or another peer's tool is rejected with a
 *    structured result. Last-writer-wins would let any peer silently take over
 *    `Bash` for every thread on both harnesses.
 * 2. **Schemas cross the boundary as JSON Schema.** The SDK's `tool()` wants a
 *    `ZodRawShape`, which would force every peer to import and match the
 *    host's exact zod instance. Peers declare JSON Schema instead and the host
 *    converts, so contributing a tool needs no shared runtime dependency.
 * 3. **Faults are isolated and bounded.** A contributed tool that throws or
 *    hangs becomes a structured tool error for that one call. It must not take
 *    down the session, the other tools, or the thread.
 */

import { z } from 'zod';
import type { PeerIdentity } from './ArtifactContributions';
import type { StorageAllocationResult, ThreadPermissionSnapshot } from './types';

/** A tool result, in the same shape the built-in MCP handlers already return. */
export interface AgentToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly isError?: boolean;
}

/**
 * Per-invocation capabilities, already bound to the calling thread.
 *
 * Both operations are also reachable on the public namespaces
 * (`threads.permissions`, `artifacts.allocateStorage`) for code paths that are
 * not a tool invocation. This object is the thread-bound convenience form,
 * exactly as `ArtifactActionHost.updateArtifact` is the artifact-bound form of
 * `artifacts.update`.
 */
export interface AgentToolHost {
  /** Effective permission mode and pending-plan state for the calling thread. */
  permissions(): Promise<ThreadPermissionSnapshot | null>;
  /** Creates and returns the host-owned storage root for `artifactId`. */
  allocateStorage(artifactId: string): Promise<StorageAllocationResult>;
}

export interface AgentToolContribution {
  /** Agent-visible tool name, e.g. `EnterDesignMode`. */
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's arguments; must be an object schema. */
  readonly inputSchema: unknown;
  readonly alwaysLoad?: boolean;
  /** Defaults to `true`: a contributed tool is a mutation until proven otherwise. */
  readonly requiresApproval?: boolean;
  invoke(threadId: string, args: Record<string, unknown>, host: AgentToolHost): Promise<AgentToolResult>;
}

export type AgentToolRegistrationResult =
  | { readonly success: true; readonly status: 'registered'; readonly name: string; readonly dispose: () => void }
  | { readonly success: false; readonly status: 'invalid' | 'conflict' | 'unavailable'; readonly name: string; readonly message: string; readonly dispose: () => void };

/**
 * One contributed tool, already bound to a thread — the shape the MCP server
 * factory consumes. `invoke` takes only args, because the thread id is baked
 * in by the host at bind time.
 */
export interface BoundAgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, z.ZodTypeAny>;
  readonly alwaysLoad: boolean;
  readonly requiresApproval: boolean;
  invoke(args: Record<string, unknown>): Promise<AgentToolResult>;
}

/** A registration, flattened into what the MCP server factory needs to bind. */
export interface RegisteredAgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, z.ZodTypeAny>;
  readonly alwaysLoad: boolean;
  readonly requiresApproval: boolean;
  readonly owner: PeerIdentity;
}

/** Contributed tool calls are bounded so one peer cannot stall a thread's turn. */
export const DEFAULT_AGENT_TOOL_TIMEOUT_MS = 60_000;

const MAX_PLUGIN_ID_LENGTH = 128;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 4_096;
const MAX_SCHEMA_PROPERTIES = 64;

/** Tool names must be a single identifier-ish token, like every built-in. */
export const AGENT_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Core agent tool names owned by the harness rather than by this plugin.
 *
 * They never appear in our MCP catalogs, so the built-in name check cannot see
 * them — but they are exactly the names worth hijacking. Reserved explicitly.
 */
export const RESERVED_AGENT_TOOL_NAMES: readonly string[] = Object.freeze([
  'Agent', 'AskUserQuestion', 'Bash', 'BashOutput', 'Edit', 'ExitPlanMode', 'Glob',
  'Grep', 'KillShell', 'ListMcpResources', 'NotebookEdit', 'Read', 'ReadMcpResource',
  'Skill', 'SlashCommand', 'Task', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write',
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textResult(text: string, isError = false): AgentToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** A JSON Schema node, as loosely as an untrusted peer may supply one. */
type JsonSchemaNode = {
  type?: unknown;
  description?: unknown;
  properties?: unknown;
  required?: unknown;
  items?: unknown;
  enum?: unknown;
  minLength?: unknown;
  minimum?: unknown;
  maximum?: unknown;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Converts one JSON Schema node to a zod type.
 *
 * Deliberately conservative: anything it does not recognise becomes
 * `z.unknown()` rather than an error, so an unusual-but-valid peer schema
 * degrades to "accepted, unvalidated" instead of refusing to register. The
 * host still validates nothing it depends on — the tool's own `invoke` is
 * responsible for its arguments, exactly as the built-in handlers are (they
 * re-check their inputs because native harnesses bypass MCP schema parsing).
 */
function zodForNode(node: unknown, depth: number): z.ZodTypeAny {
  if (!isPlainObject(node) || depth > 8) return z.unknown();
  const schema = node as JsonSchemaNode;
  const describe = (built: z.ZodTypeAny): z.ZodTypeAny =>
    typeof schema.description === 'string' && schema.description ? built.describe(schema.description) : built;

  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(value => typeof value === 'string')) {
    return describe(z.enum(schema.enum as [string, ...string[]]));
  }
  const type = typeof schema.type === 'string' ? schema.type : undefined;
  if (type === 'string') {
    let built = z.string();
    if (typeof schema.minLength === 'number' && schema.minLength > 0) built = built.min(schema.minLength);
    return describe(built);
  }
  if (type === 'number' || type === 'integer') {
    let built = type === 'integer' ? z.number().int() : z.number();
    if (typeof schema.minimum === 'number') built = built.min(schema.minimum);
    if (typeof schema.maximum === 'number') built = built.max(schema.maximum);
    return describe(built);
  }
  if (type === 'boolean') return describe(z.boolean());
  if (type === 'array') return describe(z.array(zodForNode(schema.items, depth + 1)));
  if (type === 'object') {
    const shape = objectShape(schema, depth + 1);
    return describe(shape ? z.object(shape) : z.record(z.string(), z.unknown()));
  }
  return describe(z.unknown());
}

/** The `properties`/`required` pair of an object schema, as a zod raw shape. */
function objectShape(schema: JsonSchemaNode, depth: number): Record<string, z.ZodTypeAny> | null {
  if (!isPlainObject(schema.properties)) return null;
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === 'string') : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, node] of Object.entries(schema.properties)) {
    const built = zodForNode(node, depth);
    shape[name] = required.has(name) ? built : built.optional();
  }
  return shape;
}

/** True for an already-built zod raw shape, e.g. `{ brief: z.string() }`. */
function isZodRawShape(value: unknown): value is Record<string, z.ZodTypeAny> {
  if (!isPlainObject(value)) return false;
  const values = Object.values(value);
  return values.length > 0 && values.every(entry => !!entry && typeof (entry as z.ZodTypeAny).safeParse === 'function');
}

/**
 * Converts a contribution's declared schema into the `ZodRawShape` the SDK's
 * `tool()` requires. Returns `null` when it is not a usable object schema.
 *
 * Two accepted forms, deliberately:
 *
 * - **JSON Schema** — what a peer uses. Requiring a `ZodRawShape` across the
 *   plugin boundary would force every peer to import and match the host's
 *   exact zod instance, which is not a contract anyone can rely on.
 * - **A zod raw shape** — what host built-ins use, so a tool moved onto this
 *   contract keeps its exact validation. That matters: `z.string().trim()`
 *   and `z.string()` emit *identical* JSON Schema, so a JSON Schema round
 *   trip silently drops trimming. Anything expressible only in zod would be
 *   lost on the way through.
 */
export function zodShapeFromJsonSchema(inputSchema: unknown): Record<string, z.ZodTypeAny> | null {
  if (isZodRawShape(inputSchema)) return { ...inputSchema };
  if (!isPlainObject(inputSchema)) return null;
  const schema = inputSchema as JsonSchemaNode;
  if (schema.type !== undefined && schema.type !== 'object') return null;
  // An object schema with no properties is a legitimate no-argument tool.
  if (schema.properties === undefined) return {};
  const shape = objectShape(schema, 1);
  if (!shape) return null;
  if (Object.keys(shape).length > MAX_SCHEMA_PROPERTIES) return null;
  return shape;
}

interface RegistryEntry {
  readonly owner: PeerIdentity;
  readonly contribution: AgentToolContribution;
  readonly resolved: RegisteredAgentTool;
}

/** A host that can do nothing, for bindings made outside a thread session. */
const UNAVAILABLE_HOST: AgentToolHost = Object.freeze({
  permissions: async () => null,
  allocateStorage: async (artifactId: string) => ({
    success: false as const, status: 'unavailable' as const, artifactId,
    message: 'Artifact storage is not available in this host context.',
  }),
});

/**
 * Runs `invoke` with fault isolation and a hard time bound.
 *
 * Shared by the registry and by standalone bindings so there is exactly one
 * definition of "a contributed tool cannot break the session": a throw, a
 * malformed result, or a hang all become an ordinary tool error for that one
 * call.
 */
async function isolatedInvoke(
  name: string,
  ownerId: string,
  timeoutMs: number,
  run: () => Promise<AgentToolResult>,
): Promise<AgentToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<AgentToolResult>(resolve => {
      timer = setTimeout(() => resolve(textResult(`Error: "${name}" timed out after ${timeoutMs}ms.`, true)), timeoutMs);
    });
    // `Promise.resolve().then(...)` so a contribution that throws
    // synchronously is caught here rather than escaping to the caller.
    const result = await Promise.race([Promise.resolve().then(run), timeout]);
    if (!result || !Array.isArray(result.content)) {
      return textResult(`Error: "${name}" returned an invalid tool result.`, true);
    }
    return result;
  } catch (error) {
    console.error(`[ClaudeThreads] Agent tool "${name}" (${ownerId}) failed:`, error);
    return textResult(`Error: ${errorMessage(error)}`, true);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Binds one contribution to a thread, producing the args-only tool the MCP
 * server factory installs. This is where the host injects the calling thread
 * id — a peer's `invoke` is thread-agnostic and never chooses its target.
 *
 * Exported so the factory's compatibility adapter builds bindings the same
 * way, rather than reimplementing isolation.
 */
export function bindAgentTool(
  contribution: AgentToolContribution,
  threadId: string,
  host: AgentToolHost = UNAVAILABLE_HOST,
  options: { readonly ownerId?: string; readonly invokeTimeoutMs?: number } = {},
): BoundAgentTool | null {
  const inputSchema = zodShapeFromJsonSchema(contribution.inputSchema);
  if (!inputSchema || typeof contribution.invoke !== 'function') return null;
  const timeoutMs = options.invokeTimeoutMs ?? DEFAULT_AGENT_TOOL_TIMEOUT_MS;
  const ownerId = options.ownerId ?? contribution.name;
  return Object.freeze({
    name: contribution.name,
    description: contribution.description,
    inputSchema,
    alwaysLoad: contribution.alwaysLoad !== false,
    requiresApproval: contribution.requiresApproval !== false,
    invoke: (args: Record<string, unknown>) =>
      isolatedInvoke(contribution.name, ownerId, timeoutMs, () => contribution.invoke(threadId, args, host)),
  });
}

export interface AgentToolRegistryOptions {
  /**
   * Names already taken by host built-ins. Read lazily so the registry cannot
   * capture a stale set — the built-in catalog varies with host capability
   * (Web Viewer, agent browser) and is built per thread.
   */
  readonly reservedNames?: () => Iterable<string>;
  readonly invokeTimeoutMs?: number;
}

/**
 * Host-owned registry of contributed agent tools. Registration returns a
 * structured result rather than throwing, collisions fail loudly, and every
 * contributed callback is isolated and time-bounded.
 */
export class AgentToolRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly reservedNames: () => Iterable<string>;
  private readonly invokeTimeoutMs: number;

  constructor(options: AgentToolRegistryOptions = {}) {
    this.reservedNames = options.reservedNames ?? (() => []);
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? DEFAULT_AGENT_TOOL_TIMEOUT_MS;
  }

  register(owner: PeerIdentity, contribution: AgentToolContribution): AgentToolRegistrationResult {
    const name = typeof contribution?.name === 'string' ? contribution.name.trim() : '';
    const invalid = (message: string): AgentToolRegistrationResult =>
      Object.freeze({ success: false as const, status: 'invalid' as const, name, message, dispose: () => {} });
    const conflict = (message: string): AgentToolRegistrationResult =>
      Object.freeze({ success: false as const, status: 'conflict' as const, name, message, dispose: () => {} });

    const pluginId = typeof owner?.pluginId === 'string' ? owner.pluginId.trim() : '';
    if (!pluginId || pluginId.length > MAX_PLUGIN_ID_LENGTH) {
      return invalid('owner.pluginId must be a non-empty string.');
    }
    if (!name || name.length > MAX_TOOL_NAME_LENGTH || !AGENT_TOOL_NAME_PATTERN.test(name)) {
      return invalid(`name must match ${AGENT_TOOL_NAME_PATTERN} and be 1-${MAX_TOOL_NAME_LENGTH} characters.`);
    }
    const description = typeof contribution.description === 'string' ? contribution.description.trim() : '';
    if (!description || description.length > MAX_DESCRIPTION_LENGTH) {
      return invalid(`description must contain 1-${MAX_DESCRIPTION_LENGTH} characters.`);
    }
    if (typeof contribution.invoke !== 'function') {
      return invalid('contribution must implement invoke().');
    }
    const inputSchema = zodShapeFromJsonSchema(contribution.inputSchema);
    if (!inputSchema) {
      return invalid('inputSchema must be a JSON Schema object with at most 64 top-level properties.');
    }

    // Collisions are checked against three namespaces, all of which a peer
    // could otherwise hijack for every thread on both harnesses.
    if (RESERVED_AGENT_TOOL_NAMES.includes(name)) {
      return conflict(`"${name}" is a core agent tool and cannot be replaced.`);
    }
    for (const reserved of this.reservedNames()) {
      if (reserved === name) return conflict(`"${name}" is a built-in Agent Threads tool and cannot be replaced.`);
    }
    const existing = this.entries.get(name);
    if (existing) {
      return conflict(`"${name}" is already contributed by "${existing.owner.pluginId}".`);
    }

    const entry: RegistryEntry = {
      owner: Object.freeze({ ...owner, pluginId }),
      contribution,
      resolved: Object.freeze({
        name, description, inputSchema,
        alwaysLoad: contribution.alwaysLoad !== false,
        // A contributed tool is a mutation unless the contributor says
        // otherwise, so it inherits the harness approval prompt by default.
        requiresApproval: contribution.requiresApproval !== false,
        owner: Object.freeze({ ...owner, pluginId }),
      }),
    };
    this.entries.set(name, entry);
    let disposed = false;
    return Object.freeze({
      success: true as const, status: 'registered' as const, name,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        // Only retract our own registration — a later re-registration by
        // someone else must survive a stale dispose.
        if (this.entries.get(name) === entry) this.entries.delete(name);
      },
    });
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Everything the MCP server factory needs to bind, in registration order. */
  list(): readonly RegisteredAgentTool[] {
    return Object.freeze([...this.entries.values()].map(entry => entry.resolved));
  }

  /** Drops every registration. Called when the public API stops. */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Binds every registered contribution to one thread.
   *
   * Called by the MCP server factory each time it builds a session's servers,
   * so a tool registered *before* construction is present and one registered
   * after is not — see `list()`'s snapshot semantics. Sessions are not
   * retrofitted, because a live agent turn's tool catalog is already fixed.
   */
  bindAll(threadId: string, host: AgentToolHost): readonly BoundAgentTool[] {
    const bound: BoundAgentTool[] = [];
    for (const entry of this.entries.values()) {
      const binding = bindAgentTool(entry.contribution, threadId, host, {
        ownerId: entry.owner.pluginId,
        invokeTimeoutMs: this.invokeTimeoutMs,
      });
      // A contribution that no longer binds (its schema went bad) is skipped
      // rather than failing the whole session's tool catalog.
      if (binding) bound.push(binding);
    }
    return Object.freeze(bound);
  }

  /**
   * Runs a contributed tool for one thread. Never throws and never hangs: a
   * faulty peer degrades to an error result for this single call, leaving the
   * session and every other tool untouched.
   */
  async invoke(
    name: string,
    threadId: string,
    args: Record<string, unknown>,
    host: AgentToolHost,
  ): Promise<AgentToolResult> {
    const entry = this.entries.get(name);
    if (!entry) return textResult(`Error: no agent tool is registered for "${name}".`, true);
    return isolatedInvoke(name, entry.owner.pluginId, this.invokeTimeoutMs, () =>
      entry.contribution.invoke(threadId, args, host));
  }
}

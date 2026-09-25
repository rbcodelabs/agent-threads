# ADR-0013: Add OpenCode as a third harness through its local HTTP server

**Date:** 2026-09-25
**Status:** Proposed

## Context

Threads can run on Claude (Agent SDK) or Codex (app-server). Both tie model choice to one vendor. Users want to run a thread on other providers — OpenAI API models billed to their own key, OpenRouter, local models — without losing the thread, its tools, or harness switching (ADR-0012). The harness contract was made provider-neutral first (`HarnessPermissionMode`, `HarnessMcpServerConfig`, `HarnessContextUsage`) so a third adapter does not have to implement Claude SDK shapes.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **OpenCode adapter** (`opencode serve` HTTP + SSE) | MIT; 75+ providers; durable sessions with resume; streaming parts, permission and question events, abort, MCP config, `plan` agent; documented server API | Extra binary; per-session process; API still moves quickly; no native host-tool injection |
| ACP adapter (Agent Client Protocol over stdio) | One adapter could drive several agents (OpenCode, Gemini CLI, …) | Least-common-denominator surface; no model catalog/context usage; would still need per-agent quirks; a second protocol stack to maintain |
| Own in-process harness (direct provider SDK + our tool loop) | No extra binary; full control | Re-implements an agent (tools, edits, shell, compaction, retries) — large ongoing cost and a worse agent |

## Decision

Add `OpenCodeSession implements HarnessSession`, selected when `thread.agentHarness === 'opencode'`. Each session launches `opencode serve --hostname=127.0.0.1 --port=0` from the configurable `opencodeBinaryPath` with per-session config in `OPENCODE_CONFIG_CONTENT`, subscribes to `/event`, and uses `POST /session`, `/session/:id/prompt_async`, `/session/:id/abort`, `/permission/:id/reply` and `/question/:id/reply`. Payloads are structural (no vendored SDK types), verified live against `opencode-ai@1.18.32`.

- **Permissions** are applied live by the adapter: config sets every non-read-only action to `ask`, and `resolveOpenCodePermission(mode, permission)` answers each `permission.asked` with allow, deny, or a prompt through the existing permission card. Plan mode uses OpenCode's read-only `plan` agent.
- **Host tools** are served to OpenCode through a per-session loopback MCP endpoint (random capability token, JSON responses) that applies the same `resolveDynamicToolApproval` rules as Codex.
- **Models** use OpenCode's `provider/model` IDs; the catalog comes from `/config/providers`.
- **Resume** uses the OpenCode session ID; if it no longer exists, canonical history is replayed once, as for Codex.

## Consequences

- Any provider OpenCode supports can drive a thread; usage is **billed to the user's provider API key**, not a subscription.
- Requires installing the **`opencode` binary**; one `opencode serve` process per active OpenCode thread.
- **Desktop only.** Node modules are required lazily and the adapter is only reachable from the desktop ThreadManager, so mobile never launches OpenCode.
- Harness switching to/from OpenCode uses ADR-0012 generation fencing unchanged; native session and model reset on switch.
- Gaps vs Claude/Codex: no plan-approval card (the plan agent answers in prose), no MCP elicitation, OpenCode child sessions (`task` tool) are followed for permissions/questions but not shown as agent runs, no account quota data. Unsupported optional contract methods (native agent controls) are absent.

## Risks

OpenCode's server API changes quickly (it also ships an experimental `/api/*` surface). The adapter pins the verified version in `OPENCODE_VERIFIED_VERSION` and parses defensively; unknown events are ignored.

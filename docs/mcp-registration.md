# Agent MCP registration

`mcp_register_server` lets an agent propose a global external MCP configuration. Claude and Codex use the same handler. The host asks for confirmation independently of harness tool approvals, so auto/bypass modes still show the dialog.

Example input (HTTP):

```json
{
  "name": "example-tools",
  "type": "http",
  "url": "https://mcp.example.com/tools",
  "headers": { "Authorization": "Bearer ${EXAMPLE_TOKEN}" }
}
```

For stdio, use `type: "stdio"`, `command`, optional `args` and `env`. For SSE use `type: "sse"`, `url` and optional `headers`. Do not mix transport fields. Names contain letters, digits, hyphens or underscores; `claude_threads`, `obsidian`, `__proto__`, `constructor` and `prototype` are reserved regardless of case.

The dialog displays the proposed configuration with unresolved placeholders and explains that it applies globally. Future initialized sessions may run the command or connect to the endpoint. Registration performs neither action. Existing adapters keep their original tool configuration. Cancel, dismissal, unavailable UI and scheduled requests make no changes. Scheduled requests return immediately rather than waiting behind an interactive dialog.

Results contain `success`, `status`, and `message`. Success statuses are `registered` and `unchanged`; they also include `requiredVariables` (placeholder names only). Other statuses are `conflict`, `invalid`, `cancelled`, `unavailable`, and `failed`. Identical retries do not save or prompt again. A different configuration with the same name is a conflict; edit existing servers in Settings → MCP.

Credentials must use `${NAME}` placeholders; obtain their values through `request_secret`. Common credential names in environment variables, headers, URL query parameters and CLI flags are checked. This check is not general secret detection: arbitrary literals, command strings and argument values must also remain nonsecret. HTTP/SSE URLs require HTTP(S) and cannot embed username/password credentials. No resolved secret or configuration is returned by registration. A required variable absent from a future session's environment causes the existing resolver to skip that server and show a warning; Project-scoped secret availability still applies.

Registration serializes agent requests and rechecks name collisions after approval. Success is returned only after settings persistence completes. A failed save removes only the entry written by that transaction, preserving unrelated or newer settings edits.

## OAuth-gated servers (`type: "oauth"`)

For a remote MCP server that requires OAuth 2.1 + PKCE (Vercel's, for example), use `type: "oauth"` instead of `"http"`. The plugin brokers the entire flow — discovery, Dynamic Client Registration, consent, token custody, refresh, and revocation — so neither Claude nor Codex needs any OAuth-specific code. Both harnesses see the server as a plain authenticated HTTP endpoint via a local per-server proxy.

```json
{
  "name": "vercel",
  "type": "oauth",
  "url": "https://mcp.vercel.com/",
  "scopes": "openid profile email",
  "tools": { "deny": ["buy_pro", "buy_credits", "buy_addon", "buy_domain"] }
}
```

Fields specific to `oauth` (mutually exclusive with the stdio/http/sse fields above):

| Field | Required | Meaning |
|---|---|---|
| `url` | yes | The upstream MCP server's root URL. Must be `https://`. |
| `scopes` | no | Space-separated scopes requested at authorization. Omit to use the authorization server's default scope. |
| `tools.allow` | no | If set, only these tool names are exposed through the proxy. Mutually exclusive with `tools.deny`. |
| `tools.deny` | no | Tool names hidden from `tools/list` and blocked (with an MCP `-32601` error) on `tools/call`. Mutually exclusive with `tools.allow`. |
| `clientId` | no | Skip Dynamic Client Registration by supplying a known public client_id. |
| `authorizationServerUrl` | no | Skip protected-resource discovery by pointing directly at the authorization server. |
| `redirectPort` | no | Pin the local OAuth callback server to a fixed port instead of an ephemeral one. Required by providers (e.g. Slack, port 3118) that register a fixed redirect URI rather than relying on RFC 8252 §7.3's "any port" loopback allowance. |

Registering an `oauth` server is asynchronous and interactive — it is not a one-shot confirm-and-save like the other transports. On success the flow:

1. Discovers the authorization server (RFC 9728 protected-resource metadata → RFC 8414 AS metadata).
2. Registers a client via RFC 7591 Dynamic Client Registration, unless `clientId` is supplied.
3. Opens the consent screen in the host's Web Viewer and waits for you to complete sign-in, up to 5 minutes.
4. Exchanges the authorization code (PKCE, S256) for tokens, starts the local proxy, and saves the server so newly initialized threads on both harnesses can use it.

Denying consent, closing the tab, or letting the 5-minute window lapse leaves no partial state behind — nothing is saved, and no proxy is left running. The same interactive-host requirement as other registrations applies: scheduled threads cannot drive this flow and get an `unavailable` result instead of a stalled dialog.

By default, the local callback server binds an ephemeral port and, when DCR is required, registers a portless loopback redirect URI (`http://127.0.0.1/callback`) — most authorization servers accept this per RFC 8252 §7.3. A provider that instead requires an exact redirect_uri match (Slack's MCP server, for example, which expects port 3118 — the same port Claude Code/Claude Desktop use for their own Slack integration) needs `redirectPort` set explicitly; the plugin then registers and authorizes against that exact fixed port. If the port is already in use by something else, registration fails with an error naming the port.

Access and refresh tokens live only in the OS keychain — never in `data.json`, never returned to the calling thread. The token is refreshed proactively ahead of expiry and, as a fallback, transparently on the next request if the upstream rejects it. If the authorization server revokes or fails to renew the refresh token, the server's status becomes "Needs re-authorization" and the calling thread's request fails as if the server were a normal, unreachable endpoint.

Settings → **MCP → OAuth MCP servers** lists every registered `oauth` server with a live status (connected + expiry countdown, expiring soon, needs re-authorization, or not configured) and a **Disconnect** button, which revokes the tokens with the authorization server, clears the keychain, and stops the proxy.

You can connect one from the UI as well as from an agent: **Add MCP server → OAuth** collects the same fields, validates them against the `mcpRegistrationSchema` above, and calls the same `OAuthMcpRegistry.registerServer()` the tool path uses — so the two entry points cannot drift. The OAuth option is offered only when adding, not when editing: a connected server's credentials live in the keychain and changing its configuration means Disconnect plus a fresh consent round-trip, not an in-place field edit.

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
| `clientSecret` | no | For a confidential client only, and only as a `${NAME}` placeholder naming a secret already saved with `request_secret` — a literal is rejected. See [Confidential clients](#confidential-clients). |
| `authorizationServerUrl` | no | Skip protected-resource discovery by pointing directly at the authorization server. |
| `redirectUri` | no | Exact loopback URI to use for the OAuth callback, e.g. `http://localhost:3118/callback`. Required by providers (Slack) that register one exact redirect URI rather than relying on RFC 8252 §7.3's "any port" loopback allowance. Must be `http://` on a loopback host (`127.0.0.1`, `localhost` or `[::1]`) with an explicit port, and carry no credentials, query string or fragment. Rejected outright for `grantType: "client_credentials"`, which opens no browser. |
| `grantType` | no | Which OAuth grant to use. Omit for the default `authorization_code` (interactive PKCE plus a consent screen). `client_credentials` is the machine-to-machine grant and requires both `clientId` and `clientSecret`. See [Machine-to-machine clients](#machine-to-machine-clients). |
| `audience` | no | Value of the `audience` parameter on the token request, naming the API the token is minted for (e.g. an Auth0 API identifier such as `bankrate-api`). **Not a secret** — pass the literal value, not a `${NAME}` placeholder. Omit unless the provider requires it. Sent alongside RFC 8707's `resource` when the MCP server advertises one; providers ignore the parameter they don't implement. |

Registering an `oauth` server with the default grant is asynchronous and interactive — it is not a one-shot confirm-and-save like the other transports. On success the flow:

1. Discovers the authorization server (RFC 9728 protected-resource metadata → RFC 8414 AS metadata).
2. Registers a client via RFC 7591 Dynamic Client Registration, unless `clientId` is supplied. The registration asks for `token_endpoint_auth_method: "none"` (a public client), but if the authorization server issues a `client_secret` anyway — RFC 7591 §3.2.1 permits it — that secret is kept and used rather than dropped.
3. Opens the consent screen in the host's Web Viewer and waits for you to complete sign-in, up to 5 minutes.
4. Exchanges the authorization code (PKCE, S256) for tokens, starts the local proxy, and saves the server so newly initialized threads on both harnesses can use it.

Denying consent, closing the tab, or letting the 5-minute window lapse leaves no partial state behind — nothing is saved, and no proxy is left running. The same interactive-host requirement as other registrations applies: scheduled threads cannot drive this flow and get an `unavailable` result instead of a stalled dialog.

### Confidential clients

Most MCP authorization servers treat the plugin as a **public client**: PKCE (S256) proves possession of the authorization request, and there is no client secret at all. That remains the default, and nothing below changes it.

A few providers issue a `client_secret` and then require it on every token-endpoint call. Supply one in either of two places:

- **Settings → MCP → Add MCP server → OAuth → Advanced → "Client secret"** — a masked field. What you type goes straight into the OS keychain.
- **`mcp_register_server`**, as a `${NAME}` placeholder naming a secret you already saved with `request_secret`:

  ```json
  {
    "name": "acme",
    "type": "oauth",
    "url": "https://mcp.acme.test/mcp",
    "clientId": "acme-confidential-client",
    "clientSecret": "${ACME_CLIENT_SECRET}"
  }
  ```

  **A literal secret is rejected** with an `invalid` result, and so is a `${NAME}` whose secret is not in the keychain (the reply names the variable and points at `request_secret`). The reason is not style: a tool call's arguments are recorded verbatim in the thread transcript and the raw JSONL log, so a literal typed there would be persisted in plain text in the vault. The placeholder keeps the value in the keychain and the log free of it.

Wherever it came from, the secret is stored under `OAUTH_MCP_{NAME}_CLIENT_SECRET` in the OS keychain. `data.json` records only a `hasClientSecret: true` flag — never the value — and the secret is sent only to the token and revocation endpoints (RFC 6749 §2.3.1, RFC 7009 §2.1), never on the authorization request, which travels through the browser's address bar and history. Which authentication form is used, `client_secret_basic` or `client_secret_post`, is negotiated from the authorization server's `token_endpoint_auth_methods_supported`. **Disconnect** wipes the secret along with the tokens.

If the keychain entry disappears while the server stays registered — a keychain reset, a vault moved between machines — the server comes back as "Needs re-authorization" with an explanation rather than silently degrading to a public client and failing later with the authorization server's opaque `invalid_client`.

### Machine-to-machine clients

Some authorization servers will not register a loopback redirect URI at all, so the interactive grant above is not merely inconvenient there — it is impossible. Set `grantType: "client_credentials"` for those, and for any MCP server that represents a service rather than a signed-in user.

```json
{
  "name": "acme-products",
  "type": "oauth",
  "url": "https://products-mcp.acme.test/mcp",
  "grantType": "client_credentials",
  "clientId": "acme-m2m-client",
  "clientSecret": "${ACME_CLIENT_SECRET}",
  "audience": "acme-api",
  "authorizationServerUrl": "https://auth.acme.test/"
}
```

What changes, relative to the default grant:

- **No browser, no consent screen, no 5-minute window.** The plugin POSTs to the token endpoint once and is done. Registration is still refused from a scheduled thread, though, with the same `unavailable` result as the interactive grant: the consent screen is what puts a human in the loop for an `oauth` registration, and a grant that has no consent screen needs that check more, not less.
- **`clientId` and `clientSecret` are both required.** Dynamic Client Registration needs the browser leg, so there is nothing to register on the fly; and a machine-to-machine client cannot be public, so a missing secret is rejected before any network round trip. The secret follows exactly the same custody rules as above: a `${NAME}` placeholder on the tool path, the masked Settings field otherwise, `OAUTH_MCP_{NAME}_CLIENT_SECRET` in the keychain either way.
- **`redirectUri` is rejected**, since nothing ever redirects anywhere.
- **No refresh token is kept**, even if the authorization server returns one — RFC 6749 §4.4.3 says it SHOULD NOT issue one, and re-minting from the secret is strictly better than refreshing: it needs no extra state and cannot be invalidated separately. Expiry is therefore recoverable without a human, which is why the status row reads **"Connected · renews in …"** rather than "expires in", and why a failure reads **"Needs new credentials"** rather than "Needs re-authorization" — there is no authorization to redo, only a client ID, secret or audience to correct.
- **Discovery must succeed.** With no browser to fall back on, a provider that publishes no authorization-server metadata fails immediately with a message naming the URL that came up empty, rather than guessing `<origin>/token` and surfacing a 404 or a WAF 403. Point `authorizationServerUrl` at the issuer — the host serving `/.well-known/openid-configuration` or `/.well-known/oauth-authorization-server`.

`audience` exists because Auth0 (and several others) mint an opaque token usable only at their own userinfo endpoint unless you name the API you want a token for. It is nonsecret configuration — it identifies an API and carries no authority on its own — so pass the literal value, not a placeholder. An Auth0 tenant given a wrong or absent secret answers `access_denied` / `Unauthorized` rather than the `invalid_client` the RFC suggests, so treat either as "check the credentials".

In Settings the grant is a dropdown: **Add MCP server → OAuth → Grant type → "Client credentials (machine-to-machine, no sign-in)"**. Choosing it hides Redirect URI, opens **Advanced**, and relabels Client ID and Client secret as required, since the two optional overrides of the interactive flow are the whole of the credentials here.

### Providers that require an exact redirect URI

By default, the local callback server binds an ephemeral port on `127.0.0.1` and, when DCR is required, registers a portless loopback redirect URI (`http://127.0.0.1/callback`) — most authorization servers accept this per RFC 8252 §7.3 ("the authorization server MUST allow any port to be specified at the time of the request" for loopback redirect URIs).

Some providers don't follow that allowance and validate `redirect_uri` by exact string match. Slack's MCP server is one: its [published configuration](https://raw.githubusercontent.com/slackapi/slack-mcp-plugin/main/.mcp.json) registers `http://localhost:3118/callback`, and anything else is rejected with `redirect_uri did not match any configured URIs`. Note the host is **`localhost`, not `127.0.0.1`** — under exact string matching those are different URIs, so pinning the port alone is not enough.

Set `redirectUri` to the provider's exact registered value:

```json
{
  "name": "slack",
  "type": "oauth",
  "url": "https://mcp.slack.com/mcp",
  "clientId": "1601185624273.8899143856786",
  "redirectUri": "http://localhost:3118/callback"
}
```

The plugin then uses that string verbatim as the `redirect_uri` in both the DCR registration and the authorization request, and binds the local callback server to the host, port and path it names — including the address family, which matters because `localhost` commonly resolves to `::1` before `127.0.0.1` on macOS. If the port is already in use (3118 in particular is also used by Claude Code and Claude Desktop for their own Slack integration), registration fails with an error naming the host and port.

Access and refresh tokens live only in the OS keychain — never in `data.json`, never returned to the calling thread. The token is refreshed proactively ahead of expiry and, as a fallback, transparently on the next request if the upstream rejects it. If the authorization server revokes or fails to renew the refresh token, the server's status becomes "Needs re-authorization" and the calling thread's request fails as if the server were a normal, unreachable endpoint.

Settings → **MCP → OAuth MCP servers** lists every registered `oauth` server with a live status and a **Disconnect** button, which revokes the tokens with the authorization server, clears the keychain, and stops the proxy. For the interactive grant the status is connected + expiry countdown, expiring soon, needs re-authorization, or not configured. A `client_credentials` server instead reads "Connected · renews in …" and, on failure, "Needs new credentials" — it holds no refresh token by design, so treating that absence as breakage would flag a perfectly healthy server.

You can connect one from the UI as well as from an agent: **Add MCP server → OAuth** collects the same fields, validates them against the `mcpRegistrationSchema` above, and calls the same `OAuthMcpRegistry.registerServer()` the tool path uses — so the two entry points cannot drift. The OAuth option is offered only when adding, not when editing: a connected server's credentials live in the keychain and changing its configuration means Disconnect plus a fresh consent round-trip, not an in-place field edit.

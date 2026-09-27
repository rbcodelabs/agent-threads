# Google Docs MCP connectivity pilot

This standalone probe tests whether the Google Docs Sync connection can read one
explicit document through Google's hosted MCP server. It does not install an MCP
server in Claude Threads or change the plugin's runtime integrations.

The initial experiment reached OAuth refresh, MCP initialization, and tool
discovery. The document read was blocked by Developer Preview enrollment, even
though it returned HTTP 200: its MCP result had `isError: true`. A successful MCP
document read remains to be validated on the corporate work machine. An ordinary
Docs API read succeeded as a control; that does not establish MCP access.

## Prepare the corporate connection

1. Use a corporate Workspace account to request access through the
   [Workspace Developer Preview Program](https://developers.google.com/workspace/preview).
   Confirm the Google Cloud project used by the OAuth client is enrolled. Enabling
   an API alone does not grant preview access.
2. In that project, enable Google Docs API (`docs.googleapis.com`) and Google Docs
   MCP API (`docsmcp.googleapis.com`). Follow Google's current
   [MCP setup guide](https://developers.google.com/workspace/guides/configure-mcp-servers)
   for consent-screen, scopes, and administrator requirements.
3. Deploy the current `obsidian-gdocs-auth` service with the corporate project's
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `NEXT_PUBLIC_BASE_URL` (for
   example, `https://google-auth.example.com`). Keep the client secret server-side.
   Register the exact OAuth redirect URI
   `https://google-auth.example.com/api/auth/callback` in Google Cloud. The custom
   domain itself does not confer preview eligibility.
4. In Google Docs Sync, disconnect the previous account **before** changing
   **Auth proxy URL**, set the new HTTPS host, and reconnect with the corporate
   account. Current plugin/auth releases support the host-aware Geode callback;
   use plugin v0.6.1 or newer and the corresponding current auth service.
5. Choose a non-sensitive Google document the connected account can read. Copy
   its ID from `https://docs.google.com/document/d/DOCUMENT_ID/edit`.

## Run on the work machine

Check out this PR's branch and use Node.js 22 or newer. The script has no package
dependencies, so dependency installation is unnecessary for the live probe.

```sh
node scripts/probe-google-docs-mcp.mjs \
  --settings-file "/path/to/vault/.geode/plugins/obsidian-gdocs-sync/data.json" \
  --auth-proxy-url "https://google-auth.example.com" \
  --document-id "DOCUMENT_ID"
```

For Obsidian, use `.obsidian/plugins/obsidian-gdocs-sync/data.json` instead.
The file must contain the plugin's existing `authProxyUrl` and `tokens`
(`accessToken`, `refreshToken`, `expiresAt` in milliseconds). Do not copy this file
into the repository, paste tokens into commands, or attach settings to a PR.
The explicit proxy URL must match the saved HTTPS origin; redirects, HTTP,
credentials embedded in URLs, and URL paths/query strings are rejected.

The probe uses a valid cached access token or refreshes it through
`/api/auth/refresh`. Refreshed credentials stay in memory; the settings file is
never changed. It sends MCP `initialize`, `notifications/initialized`,
`tools/list`, and one `tools/call` for `read_doc`. It never calls `update_doc` or
searches Drive. Each HTTP request has a 30-second timeout. The initial pilot
supports Google's JSON responses and protocol `2025-03-26`, not general MCP
servers, streaming responses, or session negotiation.

Success exits with code 0 and ends with:

```text
read_doc: PASS (response received; document content omitted)
```

Failures exit with code 1 and identify the phase plus a fixed category:

| Category | Next check |
| --- | --- |
| `developer-preview` | Confirm enrollment approval for the OAuth client's Cloud project. |
| `api-disabled` | Enable the Docs and Docs MCP services in that project. |
| `authentication` / `missing-credentials` | Reconnect Google Docs Sync to the intended corporate proxy/account. |
| `permission-or-scope` | Check document access, OAuth scopes, and Workspace administrator policy. |
| `auth-proxy-mismatch` / `invalid-auth-proxy` | Verify the explicit URL and saved proxy configuration. |
| `timeout` / `network-error` | Check corporate networking and proxy availability; redirects are deliberately rejected. |
| `invalid-response` / `unsupported-protocol` / `upstream-error` | Recheck Google's preview contract; the probe does not print raw upstream responses. |

Only phase status is printed, including on failure. Tokens, document content, and
arbitrary server error messages are omitted. This applies to this script; it does
not change logging in the existing Docs Sync plugin or auth service.

## Record validation

Record the checked-out commit, Node version, phase output, and exit code in the
draft PR. Do not include tokens, document contents, settings, or private account
and project identifiers. Check that `read_doc: PASS` occurred: initialization and
tool discovery alone do not validate access. Runtime integration remains deferred
until this read succeeds with the intended corporate connection.

Local mocked regression tests run with:

```sh
pnpm exec vitest run test/unit/google-docs-mcp-probe.test.ts
```

/**
 * Quick-fill presets for the "Add MCP server → OAuth" form. Pure data: the
 * modal (SettingsTab) decides how to render and apply them.
 *
 * Every entry was checked against the provider's own documentation (see the
 * `source` field). A preset only prefills the form; the user still clicks
 * Connect, and the entry goes through the same `mcpRegistrationSchema`
 * validation as a hand-typed one.
 *
 * Providers that do not support Dynamic Client Registration set
 * `requiresClientId`: we never ship a client ID (it would belong to someone
 * else's app), so the form opens Advanced and tells the user to supply their
 * own. `redirectUri` is prefilled for those because the provider matches the
 * callback URI exactly and the user must register this same string in their app.
 */
export interface OAuthMcpPreset {
  /** Stable identifier; unique across presets. */
  id: string;
  /** Chip label shown in the modal. */
  label: string;
  /** Prefilled server name; unique across presets. Matches the schema's name rules. */
  name: string;
  url: string;
  scopes?: string;
  /** Exact loopback callback to register with the provider. */
  redirectUri?: string;
  /** Only for providers with a single well-known public client ID. Never invent one. */
  clientId?: string;
  /** The provider has no Dynamic Client Registration: the user must bring a client ID. */
  requiresClientId?: boolean;
  /** The provider also issues a client secret that the user must enter (masked field). */
  requiresClientSecret?: boolean;
  /** Shown under the chips when the preset is selected. */
  notes?: string;
  /** Where to create the OAuth app, for presets with `requiresClientId`. */
  setupUrl?: string;
  /** Official documentation the endpoint and quirks were verified against. */
  source: string;
}

export const OAUTH_MCP_PRESETS: readonly OAuthMcpPreset[] = [
  {
    id: 'atlassian',
    label: 'Atlassian (Jira / Confluence)',
    name: 'atlassian',
    url: 'https://mcp.atlassian.com/v2/mcp',
    notes: 'Atlassian\'s v1 /v1/sse endpoint is being folded into v2; use the Streamable HTTP v2 endpoint.',
    source: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
  },
  {
    id: 'slack',
    label: 'Slack',
    name: 'slack',
    url: 'https://mcp.slack.com/mcp',
    redirectUri: 'http://localhost:3118/callback',
    requiresClientId: true,
    requiresClientSecret: true,
    setupUrl: 'https://api.slack.com/apps',
    notes:
      'Slack does not support Dynamic Client Registration. Create a Slack app with MCP enabled, add ' +
      'http://localhost:3118/callback as a redirect URL, then paste its Client ID and Client secret under Advanced.',
    source: 'https://docs.slack.dev/ai/slack-mcp-server/',
  },
  {
    id: 'v0',
    label: 'v0',
    name: 'v0',
    url: 'https://v0.app/api/mcp',
    notes: 'Signs in with your v0 account; no API key is needed. If connecting fails on client registration, supply a Client ID under Advanced.',
    source: 'https://v0.app/docs/api/v1/adapters/mcp-server',
  },
  {
    id: 'linear',
    label: 'Linear',
    name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    notes: 'Use https://mcp.linear.app/readonly for a read-only connection.',
    source: 'https://linear.app/docs/mcp',
  },
  {
    id: 'notion',
    label: 'Notion',
    name: 'notion',
    url: 'https://mcp.notion.com/mcp',
    source: 'https://developers.notion.com/docs/get-started-with-mcp',
  },
  {
    id: 'vercel',
    label: 'Vercel',
    name: 'vercel',
    url: 'https://mcp.vercel.com',
    notes: 'Vercel only accepts MCP clients it has reviewed and approved, so sign-in can be refused for this client.',
    source: 'https://vercel.com/docs/agent-resources/vercel-mcp',
  },
  {
    id: 'sentry',
    label: 'Sentry',
    name: 'sentry',
    url: 'https://mcp.sentry.dev/mcp',
    notes: 'Append /<organization>/<project> to the URL to scope the tools to one project.',
    source: 'https://mcp.sentry.dev/',
  },
  {
    id: 'asana',
    label: 'Asana',
    name: 'asana',
    url: 'https://mcp.asana.com/v2/mcp',
    redirectUri: 'http://localhost:3118/callback',
    requiresClientId: true,
    requiresClientSecret: true,
    setupUrl: 'https://app.asana.com/0/my-apps',
    notes:
      'Asana\'s V2 MCP server does not support Dynamic Client Registration. Create an app in the Asana developer ' +
      'console, add http://localhost:3118/callback as its redirect URL, then paste its Client ID and Client secret under Advanced.',
    source: 'https://developers.asana.com/docs/integrating-with-asanas-mcp-server',
  },
];

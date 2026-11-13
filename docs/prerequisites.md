# Prerequisites and harness setup

Part of the [Agent Threads README](../README.md).

## Prerequisites

- Obsidian v1.0.0+ or a compatible Geode desktop host
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
  - The plugin auto-detects `claude` at `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, or `~/.local/bin/claude`
  - AWS Bedrock / SSO users: set `AWS_PROFILE` and `AWS_REGION` in the plugin's Extra Environment Variables setting
    - When the provider is Amazon Bedrock and your AWS credentials are missing or your SSO session has expired, the thread shows a **Sign in to AWS** card (instead of plain error text). It signs in natively with the AWS SSO device flow — the AWS CLI is not required — for the profile from `AWS_PROFILE` (Extra Environment Variables, then the app environment, then the profile named in the error): your browser opens the approval page (the link and device code are also shown as a fallback), the token is saved to `~/.aws/sso/cache` like the AWS CLI does, credentials are verified, and your message is resent. Only SSO profiles are supported. Expired SSO sessions are not retried silently, since restarting the CLI cannot fix them. **Settings → Account / provider → AWS credentials** (Bedrock only) has **Check** and **Sign in** buttons to verify credentials ahead of time.
  - Threads use the CLI's own sign-in (the macOS keychain entry written by `claude auth login`). If a thread hits "OAuth session expired" — usually because several CLI processes raced to refresh the same token — the plugin restarts that thread's CLI process and resends the message once, automatically. If that also fails, the thread shows a **Sign in to Claude** card: it runs `claude auth login` (desktop only), confirms with `claude auth status`, and resends the message. **Retry** resends without signing in. Scheduled and peer-plugin runs retry once and then fail with "Claude sign-in expired — run `claude auth login`".
- Or [OpenAI Codex CLI](https://developers.openai.com/codex/cli/) installed and authenticated
  - Select **OpenAI Codex** in Settings → Agent → Agent harness. The plugin launches Codex's local app-server, so its threads retain Codex session history, streaming output, tool visibility, interruption, and approval prompts.
- Or [OpenCode](https://opencode.ai) installed (desktop only), with at least one provider configured in OpenCode (for example `OPENAI_API_KEY` in your environment or Extra Environment Variables, or `opencode auth login`)
  - Select **OpenCode** in Settings → Agent → Agent harness. Each OpenCode thread runs its own local `opencode serve`, so any provider OpenCode supports can drive a thread. Both the 1.x and 2.x OpenCode servers are supported (verified against 1.18.32 and 2.0.32); the plugin detects which one is installed. On 2.x, OpenCode's todo list is not surfaced in the thread because the 2.x server does not emit todo events. Usage is billed by that provider to your API key.


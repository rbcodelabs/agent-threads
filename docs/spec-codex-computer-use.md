# Spec: Codex computer-use control

**Approval:** The user approved exposing the proposed default-off harness control in the implementation conversation (2026-09-23).

**Approach:** Add a persisted “Codex computer use” toggle beside the Codex binary setting in Agent harness settings, defaulting off for new and existing installations. Pass this choice to both app-server thread creation and resumption.

**Files affected:** Settings types, SettingsTab, ThreadManager, HarnessSession, CodexSession, focused session tests, settings screenshots, and README.

**Key decisions:** Off adds Codex computer-use policy and disables the bundled computer-use plugins. On inherits local Codex configuration without granting access denied there or installing capabilities. Changes apply to newly initialized/reinitialized sessions; existing running or warm sessions retain their original configuration until restarted. This is a control for Codex computer-use capabilities, not a general machine-access security boundary.

**Visual reference:** Existing Agent harness settings and its standard toggle control; no new screen, layout, or unresolved interaction.

**Riskiest assumption:** The installed Codex app-server honors the supplied configuration overrides. Validate supported config shape against the local app-server and official documentation before finishing transport implementation.

**Known entry points:** Off also disables the legacy `node_repl`, `cua_repl`, and `computer-use` MCP servers, preserving unrelated mirrored servers. Disabling the shared REPL can remove its browser capabilities; host browser tools remain available.

**Out of scope:** Per-app allowlists, browser settings, arbitrary external automation tools, live-session interruption, global Codex config modification.

**Done when:** The choice persists, defaults off, reaches start and resume without dropping unrelated MCP configuration, and enabling restores inheritance. Focused tests, full unit suite, types, build, and settings UI verification pass.

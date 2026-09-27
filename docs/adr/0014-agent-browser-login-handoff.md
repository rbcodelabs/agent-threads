# ADR-0014: Agent Browser login-handoff UI

**Date:** 2026-09-26
**Status:** Proposed

## Context

Geode's `docs/adr/0022-agent-browser-popup-bridge.md` (PR
[rbcodelabs/geode#288](https://github.com/rbcodelabs/geode/pull/288), merged
at `7db4fae`) extended its Web Viewer popup/opener bridge (ADR-0021 there) to
the `persist:agent-browser` partition this plugin owns. On any `<webview>`
attached to that partition, Geode now:

- Denies every real `window.open()` and instead emits `agent-browser-window-open`
  (`{ url, guestId, disposition }`, mirroring `GuestWindowOpenRequest`) over
  `window.geode.onAgentBrowserWindowOpen` — and, once a guest is paired,
  `agent-browser-window-close` / `agent-browser-window-focus` over plain
  `ipcRenderer.on(...)` (the host renderer runs with `nodeIntegration: true` /
  `contextIsolation: false`, so no preload wrapper is required for those two).
- Pairs any guest on `persist:agent-browser` that attaches *after* the request
  and starts navigating to that same URL within a 30s TTL, via a second,
  independent `WebViewerPopupRegistry` instance scoped to this partition only
  (`agentBrowserPopups`, never `webViewerGuests`/`webViewerPopups` — no shared
  state, no cross-pairing is possible by construction).
- Installs `agent-browser-bridge-preload.ts` in that paired guest — the popup/
  opener shim only, deliberately **not** `window.__geode.postEvent` — so
  `window.opener.postMessage(token, origin)` (the OAuth popup handshake) works
  from inside it.
- Forces a host-side `webPreferences` floor on every `persist:agent-browser`
  attachment via `will-attach-webview` (`contextIsolation`, `sandbox`,
  `nodeIntegration=false`, …) — the enforcement `AgentBrowserGuest.ts`'s own
  "Gap G3" comment asked for, independent of whatever the tag itself requests.

Geode's ADR is explicit that all of this is inert without one Threads-side
change (`allowpopups` on the tag, §4) and one Threads-side consumer (this
ADR). Nothing before this repo's own `GUEST_WEBPREFERENCES`/`start()` currently
sets `allowpopups`, so today a guest's `window.open()` is rejected by
Chromium's `<webview>` popup blocking before `setWindowOpenHandler` even
runs — none of Geode's primitives can fire.

### Two structural constraints this design must respect

1. **The guest is never parented into a workspace leaf.**
   `AgentBrowserPreviewView.ts`'s file header states this as the load-bearing
   reason it renders periodic `capturePage()` frames into an `<img>` rather
   than hosting the live `<webview>`: Obsidian's tab-group code clears its
   host element on every tab switch (`contentHostEl.innerHTML = ""`, and
   Geode's own workspace does the same to *its* leaves), which destroys any
   `<webview>` parented into it. `agentBrowserHost.ts` keeps every guest in one
   container appended straight to `document.body`, outside the workspace
   entirely, specifically so a tab switch can never destroy one. ADR-0022 §5
   independently confirms this from Geode's side: "Agent Browser guests are
   never detached... a tab switch elsewhere in Geode can never destroy one" —
   and calls this a simplification Agent Browser guests get for free
   *precisely because they are never reparented*. Any design that reparents a
   guest into a leaf for the duration of a login reintroduces the exact
   fragility this architecture exists to avoid, at the worst possible moment:
   a user checking a second monitor's mail client for an MFA code, or simply
   clicking back to their notes mid-login, would destroy the page they are
   authenticating on.
2. **One guest per thread, funneled through one admission gate.**
   `AgentBrowserPool.guests` is a `Map<threadId, AgentBrowserGuest>`, and its
   own file header states the design's load-bearing choice: "funnelling
   creation through a single `admit()`... nothing counted them, nothing
   reclaimed them, nothing refused to start one more." A login handoff needs a
   second, simultaneously-live `<webview>` per thread (see below) — it must
   not become a second, uncounted creation path that quietly reintroduces the
   leak class `AgentBrowserPool` exists to prevent.

### Why a login needs a *second* guest, not the opener guest itself

Per ADR-0022 §2/§3, pairing happens when some guest on `persist:agent-browser`
*attaches after* the pending request and makes its *first real-origin
navigation* to the denied URL — and the registry's own rule (inherited from
ADR-0021) excludes the opener guest as a candidate for its own pairing. The
opener guest — the one the agent is driving, whose `window.open()` was denied
— can therefore never be the guest that receives the `window.opener` shim.
Something else has to attach and navigate to that URL. Geode's ADR says this
plainly: "Threads' eventual login-handoff UI is then just: listen for
`agent-browser-window-open`, decide whether/how to show the user a guest at
that URL." Deciding how to show that guest, without breaking either
constraint above, is what this ADR is for.

## Decision

### 1. Activate the bridge

In `AgentBrowserGuest.start()`, add:

```ts
el.setAttribute('allowpopups', '');
```

next to the existing `partition`/`webpreferences`/`src` attribute calls,
matching how Geode's own `web-view.ts:210` sets it for the Web Viewer's tag —
a plain HTML attribute, not part of `GUEST_WEBPREFERENCES`. This does **not**
relax what a guest page can do: every `window.open()` is still denied by
Geode's `setWindowOpenHandler` exactly as before (native result: `null`,
unchanged). What changes is that the denial is no longer swallowed
before it reaches that handler, so Geode's IPC event fires and the primitives
below become reachable. `GUEST_WEBPREFERENCES`'s doc comment and the Gap G3
note are updated to describe this precisely, so a future reader does not read
"popups: still blocked" as still literally true.

### 2. Take control = synthetic input forwarding to a dedicated login guest, never the opener

Rejecting reparenting-the-opener (constraint 1) leaves one place to put a
live, human-drivable surface: a **second, short-lived guest**, hosted in the
exact same off-screen container as every other guest, that the plugin creates
only in response to an accepted `agent-browser-window-open` and points at the
denied URL. Because it is never parented into a leaf either, it inherits the
same tab-switch immunity the opener has — the property this whole design is
protecting.

"Take control" is then: forward synthetic input from the preview pane's
`<img>` onto *that* login guest's `WebContents` via `sendInputEvent`, while
the opener guest is left completely alone and remains exactly as
agent-drivable as it always was. This is Option (a) from the brief. It keeps
the off-screen, capture-and-display architecture intact by construction —
there is no reparenting, no leaf, nothing for a tab switch to destroy — at the
cost of an approximate, non-real-time remote-control feel (see Limitations).

Concretely:

- **Click → focus + click.** A pointer event on the preview `<img>` is mapped
  from image-space to guest-viewport-space by the ratio of the `<img>`'s
  rendered box to the login guest's actual viewport (`facts().viewport`), then
  sent as a `mouseDown`/`mouseUp` pair via `sendInputEvent`. This also focuses
  whatever form field is under the click, which is what makes the next bullet
  work.
- **Type → keyboard events.** While the handoff panel holds focus, `keydown`/
  `keyup` on it are translated to Electron `KeyboardInputEvent`s and forwarded
  the same way. Scope is deliberately narrow — printable characters via
  `event.key`, plus Enter/Backspace/Tab/Escape/Delete/arrows and Shift/Ctrl/
  Alt/Meta modifiers — because the target is a login form, not general page
  interaction (per the brief: "for the login page only").
- **No hover/drag/wheel/right-click.** Out of scope for the same reason: a
  credentials-and-MFA form does not need them, and each one adds a class of
  coordinate/timing edge case for a surface that exists for a few seconds at a
  time.
- These are genuinely **synthetic** input events in Electron's technical
  sense — `sendInputEvent` is always a programmatic injection, never real OS
  input — but every one of them is triggered by, and only by, a human
  action taken this turn on this pane, forwarded to the one guest the human
  is actively looking at. No path here lets the agent (the LLM/tool-call
  loop) originate an input event; `browser_click`/`browser_type` continue to
  operate only on the primary guest via the unchanged `ThreadBrowser`/MCP
  surface, and never touch the login guest at all.

### 3. Pool: a second role, same admission gate

Extend `AgentBrowserPool` with a parallel, per-thread map for the login role
— `loginGuests: Map<threadId, AgentBrowserGuest>`, at most one per thread —
and:

- `acquireLoginGuest(threadId, url): Promise<AgentBrowserGuest>` routes
  through the exact same `admit()` gate as `acquire()` (crash cooldown, create
  rate limit, max-guest cap, FD-pressure probe), with the cap check counting
  `this.guests.size + this.loginGuests.size` together. A login guest is rare,
  human-paced, and short-lived, so in practice it is essentially never
  refused — but when the pool genuinely is at its ceiling, refusing it and
  telling the user to close a session first is the same fail-safe posture
  every other admission path already takes, not a special case to bypass.
- Creation, the reaper `tick()`, the crash breaker, `destroyAll()`, and
  `destroy()` all iterate both maps. `peek()`/`acquire()` (used by the MCP
  tools and `ThreadBrowser`) are **untouched** — they only ever see
  `guests`, so `browser_status`/`browser_close`/etc. keep describing the
  primary guest exactly as documented today. The login guest has no MCP
  surface at all; it is UI-only.
- The login guest is constructed with the thread's own `urlPolicy`, applied to
  its initial navigation via the same `evaluateUrl()` every other navigation
  uses. This is a second, independent check beyond whatever Geode's own
  scheme/host rules already reject: if a hostile page tries to dress up a
  disallowed URL as a "sign in" popup, the plugin still refuses to open it as
  a login guest and tells the user why, rather than trusting the denial
  reason implied by the event.
- The login guest boots on `BOOTSTRAP_URL` (`about:blank`) exactly like a
  primary guest, then is navigated to the denied URL — `about:blank`'s opaque
  origin is what lets Geode's registry skip the boot navigation without
  spending the one real-origin attempt pairing depends on (ADR-0021 §"pairing
  happens at... navigation start").

### 4. Surfacing and returning control

- `AgentBrowserPreviewView` (or a small owned sub-component) subscribes to
  `window.geode.onAgentBrowserWindowOpen`, feature-detected — this plugin also
  runs on plain Obsidian, where `window.geode` does not exist and the whole
  feature is simply unavailable, matching how `fdGate`/`WakeLockService`
  already treat `window.geode` as optional. On a matching event (guestId
  resolves to some thread's primary guest via `getWebContentsId()`), the pane
  shows a "This page wants you to sign in — Take control?" affordance scoped
  to that thread, with a 30s countdown mirroring Geode's own pairing TTL (a
  stale affordance the user clicks after the window has expired should say so
  and offer to retry, not silently fail).
- Clicking it calls `pool.acquireLoginGuest(threadId, url)`, switches the
  preview pane's capture target to the login guest at a faster cadence (a
  fixed ~250ms tick while the handoff is active, vs. the existing 1s/5s
  active/idle cadence — a deliberate trade of guest capture budget for
  responsiveness during a short, bounded window), and starts translating
  pane input events per §2.
- "Return control" — an explicit button, **or** the login guest's own
  `window.close()` relayed as `agent-browser-window-close`, **or** an idle/
  hard-TTL timeout reusing the pool's existing reaper — stops input
  forwarding, calls `pool` to retire the login guest (`destroyForThread`-style,
  new reason `'login-complete'` added to `GuestEndReason`), switches the
  preview pane back to the primary guest, and does nothing else. The opener
  guest was never touched, so the agent's next `browser_snapshot`/
  `browser_navigate` simply sees whatever the identity provider's
  `window.opener.postMessage()` (already wired by Geode's shim) left on that
  page — the same as any other DOM mutation the agent already knows how to
  read. No new MCP tool, no "login complete" signal the agent has to poll for.
- `agent-browser-window-focus` (a page calling `window.opener.focus()`) reveals
  the preview pane/leaf if it is not already open, matching what "focus" means
  for a pane that has no real window to raise.

### 5. What stays exactly as it is

- **MCP tool surface is unchanged.** No new `browser_*` tool. The agent has no
  way to request, drive, or query a login handoff; it is entirely a human
  affordance layered on top of a page state the agent already observes
  before and after.
- **Partition isolation is unchanged and unaffected.** `persist:agent-browser`
  and `persist:webviewer` are separated by Geode's own two independent
  `WebViewerPopupRegistry` instances (ADR-0022 §3) and were never touched by
  anything in this ADR — this plugin introduces no new partition, no shared
  preload, and no code path that could address a Web Viewer guest.
- **One shared `persist:agent-browser` cookie jar across threads** — an
  existing, documented limitation (`AgentBrowserPool.ts`'s partition comment;
  ADR-0022's Limitations) — is unchanged by this feature and not solved here.

## Options considered

| Option | Pros | Cons |
| --- | --- | --- |
| **(a) Synthetic input forwarding to a dedicated login guest** (chosen) | Keeps the off-screen, never-parented architecture fully intact — no new tab-switch fragility; opener guest is never touched, so agent automation and human login cannot race on the same `WebContents`; reuses the pool's existing admission/reaper/crash-breaker machinery | Approximate, non-real-time feel (fixed capture cadence, no live cursor/hover feedback); keyboard mapping is best-effort, not a full DOM-level IME; a second guest per thread, counted against the shared cap |
| (b) Temporarily reparent/reveal the real guest for the handoff, reverse afterward | Genuine native input, no coordinate/key-mapping layer to get wrong | Directly reintroduces the exact failure `AgentBrowserPreviewView`'s architecture and ADR-0022 §5 both call out: any tab switch during the reparented window destroys the `WebContents` mid-login; reversing "cleanly" requires re-creating the guest's off-screen parenting without losing page state, which is the same class of bug ADR-0021 spent most of its own history fixing (its "prerequisite, now met" section) for a mechanism this plugin does not need to depend on |
| Do nothing; leave `window.open()` blocked | No work | The Agent Browser can never complete an OAuth-style login; every site requiring one is permanently unusable by the agent |
| Build the login UI as a Geode-owned surface | N/A — not this repo's decision | Explicitly rejected by ADR-0022 §2 itself: Geode does not own Agent Browser guests or their UI, and building one would duplicate work this repo is scoped to do |

## Consequences

- One new tag attribute (`allowpopups`) activates a bridge that was otherwise
  fully inert; nothing else changes about what a guest page can do that it
  could not already attempt (and fail at) before.
- `AgentBrowserPool` gains a second, parallel per-thread guest role. Existing
  `peek()`/`acquire()` callers (MCP tools, `ThreadBrowser`) are unaffected.
- `AgentBrowserPreviewView` gains a small amount of state (pending
  window-open request, active handoff, faster capture cadence while one is
  live) but its core capture-and-display loop is unchanged.
- No new MCP tool, no new permission prompt, no change to what the agent can
  observe or do on its own.

## Limitations

- **Not real-time.** A ~250ms capture/repaint cadence during handoff is
  enough to fill in a login form but will feel laggy for anything requiring
  precise, continuous mouse tracking (drag, hover menus) — which is out of
  scope by design (§2).
- **Keyboard mapping is best-effort.** Printable characters, common control
  keys, and basic modifiers are covered; IME/composition input and some
  non-US-layout symbol keys are not. Acceptable for the login/MFA forms this
  exists for; a real gap for anything more exotic.
- **One login guest at a time per thread.** A page that itself opens a nested
  popup from inside the login guest (e.g., "Sign in with Google" nested
  inside another IdP) is not supported — the design assumes one hop from
  opener to login guest.
- **Login guest counts against the shared per-pool cap and FD gate.** Under
  genuine resource pressure, a login handoff can be refused exactly like any
  other guest creation, with the same user-facing message.
- **TTL race.** If the user does not click "Take control" within Geode's 30s
  pairing window, the pending request expires on Geode's side before the
  login guest ever attaches, and pairing simply fails — the guest loads the
  URL but never gets a `window.opener`. The affordance's own countdown exists
  to make this visible rather than a silent, confusing failure.
- Every limitation ADR-0022 itself inherits from ADR-0021 (no same-origin
  `opener` access, no transferables, no subframe coverage, one-way `close()`)
  applies unchanged here, since this plugin builds on top of that shim rather
  than replacing any part of it.

## Risks

- **Coordinate/key-mapping bugs** could make "take control" feel broken
  (clicks landing in the wrong place, keys not registering) without being a
  security issue — mitigated by keeping the mapping logic in a small, pure,
  directly unit-tested module (`agentBrowserInput.ts`) separate from the
  Electron glue, matching this codebase's existing separation
  (`agentBrowserPolicy.ts`, `agentBrowserScript.ts`).
- **A confused user leaves a login guest running** after abandoning the flow.
  Mitigated by the existing idle-reap/hard-TTL sweep in `AgentBrowserPool`
  applying to the login role exactly as it does to primary guests, so an
  abandoned handoff is reclaimed on the same schedule rather than needing new
  timeout logic.

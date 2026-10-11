#!/usr/bin/env node
/**
 * Generates demo/demo.config.json. The config is written as code only so the
 * long selectors are named once; the JSON it emits is what the engine reads, and
 * it is committed. Edit narration/cues here, then run `node demo/build-config.mts`.
 *
 * Narration is the locked script from the storyboard, word for word. Do not edit it
 * here without updating the storyboard note.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const CH = '.workspace-leaf-content[data-type="claude-threads:chat"]';
const DISPATCH = ".ct-agents-dispatch-input";
const NEW_THREAD = '[aria-label="New thread"]';

type A = Record<string, unknown>;
const pause = (ms: number): A => ({ type: "pause", ms });
const click = (selector: string, cue?: string, extra: A = {}): A => ({ type: "click", selector, ...(cue ? { cue } : {}), ...extra });
const hover = (selector: string, cue?: string, extra: A = {}): A => ({ type: "hover", selector, ...(cue ? { cue } : {}), ...extra });
const type = (text: string, delayMs: number, cue?: string): A => ({ type: "type", text, delayMs, ...(cue ? { cue } : {}) });
const press = (key: string, cue?: string, label?: string): A => ({ type: "press", key, ...(label ? { label } : {}), ...(cue ? { cue } : {}) });
const waitFor = (selector: string, timeoutMs = 15000, extra: A = {}): A => ({ type: "waitFor", selector, timeoutMs, ...extra });

const config = {
  title: "Getting started with Geode Threads",
  target: {
    type: "electron",
    // Geode itself is the app under recording; the plugin rides in the fixture vault.
    // This path is on the recording host (see environment.record.setup and demo/README.md).
    app: "/home/rick/geode-gate",
    env: {
      GEODE_HEADLESS: "0",
      GEODE_SCREENSHOT_MODE: "1",
      CLAUDE_THREADS_DEMO_SCRIPT: "{{fixture}}/.geode/plugins/claude-threads/demo-script.json",
    },
    readySelector: ".ct-agents-row",
    readyTimeoutMs: 45000,
    fixture: { source: "demo/fixture-vault" },
    userDataFiles: { "geode.json": { recentVaults: ["{{fixture}}"], lastVault: "{{fixture}}" } },
  },
  environment: {
    record: {
      runner: "ssh",
      host: "dev-builder",
      remoteDir: "~/product-demo-work",
      shellInit: 'export PATH="$HOME/.local/share/fnm:$PATH"; eval "$(fnm env)"',
      // The engine launches the Electron found in the synced project's node_modules; point it at the
      // one the Geode checkout on this host already has, and fail early if that checkout is missing.
      setup: [
        'test -f "$HOME/geode-gate/dist/main.js" || { echo "no built Geode at $HOME/geode-gate (see demo/README.md)" >&2; exit 1; }',
        'mkdir -p node_modules && ln -sfn "$HOME/geode-gate/node_modules/electron" node_modules/electron',
      ],
      syncExclude: ["docs", "screenshots", "test", "src", "relay", "api", "sandbox", "dist", ".worktrees"],
    },
  },
  capture: { width: 1280, height: 800, fps: 30 },
  output: { width: 1920, height: 1080, fps: 30 },
  look: {
    windowWidth: 1440,
    cornerRadius: 14,
    dock: true,
    menuBar: { appName: "Geode", items: ["File", "Edit", "View", "Go", "Window", "Help"], clock: "Sun Oct 11  9:41 AM" },
    appIcon: "demo/assets/geode-icon.png",
  },
  voice: { modelId: "eleven_multilingual_v2", stability: 0.5, similarityBoost: 0.75, style: 0 },
  timing: { leadMs: 400, tailMs: 700, maxSlowdown: 1.3 },
  scenes: [
    {
      id: "intro",
      narration:
        "Meet Agent Threads, Claude Code running right inside your Geode vault. I'll show you how to start a conversation, run several at once, and stay in control of everything they do.",
      actions: [
        waitFor(".ct-agents-row"),
        pause(1200),
        hover(`${CH} .ct-messages`, "Claude Code running right inside your Geode vault"),
        hover(`${CH} .ct-input`, "start a conversation"),
        hover(".ct-agents-list", "run several at once"),
        pause(2500),
      ],
    },
    {
      id: "first-thread",
      narration:
        "Starting is simple. Open a new thread, type what you want, and press Enter. Each thread is its own Claude Code session, with its own working directory and its own history.",
      actions: [
        click(NEW_THREAD, "Open a new thread"),
        click('.menu-item:has-text("Fieldnotes Launch")'),
        click(`${CH} .ct-input`),
        type("Pull together the decisions from this week's sync", 28, "type what you want"),
        press("Enter", "press Enter"),
        pause(4000),
      ],
    },
    {
      id: "streaming",
      narration:
        "Replies stream in as Markdown. You can see exactly what Claude is doing, because every file it reads or edits shows up as a tool call, grouped so a long run never takes over the screen.",
      actions: [
        hover(`${CH} .ct-tool-pill`, "shows up as a tool call", { optional: true }),
        waitFor(`${CH} .ct-tool-group-header`, 20000, { optional: true }),
        click(`${CH} .ct-tool-group-header`, "grouped so a long run", { optional: true }),
        pause(5000),
      ],
    },
    {
      id: "permissions",
      narration:
        "Before Claude changes anything, it asks. You can deny, allow once, or always allow, right there in the conversation. You stay in control.",
      actions: [
        click(`${CH} .ct-input`),
        type("Yes, add it to the Weekly Sync note", 35),
        press("Enter"),
        waitFor(`${CH} .ct-permission-allow`, 15000),
        hover(`${CH} .ct-permission-deny`, "deny"),
        hover(`${CH} .ct-permission-allow`, "allow once"),
        hover(`${CH} .ct-permission-always`, "always allow"),
        click(`${CH} .ct-permission-allow`, "You stay in control"),
        pause(4500),
      ],
    },
    {
      id: "wikilinks",
      narration:
        "Links in a reply are real links. Click a wikilink and the note opens beside the conversation, so you can read what Claude wrote without losing your place.",
      actions: [
        waitFor(`${CH} .ct-messages a.internal-link`, 15000),
        click(`${CH} .ct-messages a.internal-link`, "Click a wikilink"),
        waitFor('.workspace-leaf-content[data-type="markdown"] .cm-content', 10000),
        hover('.workspace-leaf-content[data-type="markdown"] .cm-content', "read what Claude wrote"),
        pause(4500),
      ],
    },
    {
      id: "mentions",
      narration:
        "To give Claude context, type the at sign and pick a note. Type a slash, and you can browse every command and skill available to the session.",
      actions: [
        click(`${CH} .ct-input`),
        type("Compare this with ", 40),
        type("@Ro", 130, "type the at sign"),
        pause(900),
        press("Enter", "pick a note"),
        pause(600),
        press("ControlOrMeta+a"),
        press("Backspace"),
        type("/", 100, "Type a slash"),
        pause(900),
        press("ArrowDown", "browse every command and skill"),
        pause(350),
        press("ArrowDown"),
        pause(350),
        press("ArrowDown"),
        pause(350),
        press("ArrowDown"),
        pause(3500),
      ],
    },
    {
      id: "parallel",
      narration:
        "The real power is running more than one thread. Start another, and another. The Agents List shows every thread, what it's working on, and whether it needs you.",
      actions: [
        press("Escape"),
        press("ControlOrMeta+a"),
        press("Backspace"),
        click(DISPATCH),
        click(".ct-dispatch-project"),
        click('.menu-item:has-text("Fieldnotes Launch")'),
        click(DISPATCH, "Start another"),
        type("Draft the release notes for the November launch", 12),
        press("Enter"),
        click(DISPATCH, "and another"),
        type("Check the launch plan for risks", 12),
        press("Enter"),
        click(DISPATCH, "every thread"),
        type("Tidy up the onboarding ideas note", 12),
        press("Enter"),
        hover(".ct-agents-row-running", "what it's working on"),
        hover(".ct-agents-row-permission", "whether it needs you"),
        pause(4500),
      ],
    },
    {
      id: "board",
      narration:
        "Prefer a bigger picture? Open the Agent Board to see threads as cards, from idle to running to waiting to done.",
      actions: [
        click('.workspace-tab-header[aria-label="Weekly Sync"] .workspace-tab-header-inner-close-button', undefined, { optional: true }),
        click('.side-dock-ribbon-action[aria-label="Agent Board"]', "Open the Agent Board"),
        waitFor(".ct-kanban-card", 10000),
        hover('.ct-kanban-col:has-text("New") .ct-kanban-card', "idle"),
        hover(".ct-kanban-card-running", "running"),
        hover(".ct-kanban-col-permission .ct-kanban-card", "waiting"),
        hover('.ct-kanban-col:has-text("Done") .ct-kanban-card', "done"),
        pause(4500),
      ],
    },
    {
      id: "subagents",
      narration:
        "When Claude hands work to sub-agents, a small pill in the composer counts them. Click it to see the whole tree, and open any agent to follow what it's doing.",
      actions: [
        click(".ct-kanban-card-running"),
        waitFor(`${CH} .ct-agent-pill:not(.ct-hidden)`, 10000),
        hover(`${CH} .ct-agent-pill`, "a small pill in the composer"),
        click(`${CH} .ct-agent-pill`, "Click it"),
        click(".ct-agent-row-button", "open any agent"),
        pause(5000),
      ],
    },
    {
      id: "projects",
      narration:
        "Projects keep related threads together, with shared context added to every message, so each new conversation starts already knowing what you're building.",
      actions: [
        click('[aria-label="Group agents"]', "Projects keep related threads together"),
        click('.menu-item:has-text("Project")'),
        hover('.ct-agents-project:has-text("Fieldnotes Launch")', "shared context"),
        hover('.ct-agents-project:has-text("Research")', "already knowing"),
        pause(3500),
        click(NEW_THREAD),
        click('.menu-item:has-text("New chat")'),
        pause(600),
      ],
    },
    {
      id: "schedule",
      narration:
        "You can also pin a goal, or have a prompt re-run on a schedule, and watch the task list tick along in the footer.",
      actions: [
        click(`${CH} .ct-input`),
        type("/goal Ship offline capture by November 10", 18, "pin a goal"),
        press("Enter"),
        type("/loop 10m check the launch checklist", 18, "re-run on a schedule"),
        press("Enter"),
        waitFor(`${CH} .ct-tasklist-pill:not(.ct-hidden)`, 15000),
        click(`${CH} .ct-tasklist-pill`, "task list"),
        pause(6000),
      ],
    },
    {
      id: "cta",
      narration: "That's Agent Threads. Install it from the Geode plugin catalog, and put your first agent to work today.",
      actions: [
        click('.side-dock-ribbon-action[aria-label="Open settings"]', "That's Agent Threads"),
        click('.vertical-tab-nav-item:has-text("Community plugins")', "Install it from"),
        hover('.modal-container button:has-text("Install")', "Geode plugin catalog"),
        pause(5000),
      ],
    },
  ],
};

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "demo.config.json");
fs.writeFileSync(out, JSON.stringify(config, null, 2) + "\n");
console.log(`wrote ${path.relative(process.cwd(), out)} (${config.scenes.length} scenes)`);

#!/usr/bin/env node
/**
 * Assemble the demo vault: copies the built plugin into
 * demo/fixture-vault/.geode/plugins/claude-threads, seeds its data.json
 * (settings, projects, threads) and the workspace layout, and installs the
 * replay script the plugin reads through CLAUDE_THREADS_DEMO_SCRIPT.
 *
 *   npm run build && node demo/build-fixture.mts
 *
 * Everything this writes is generated and gitignored (see demo/.gitignore);
 * the hand-written notes in demo/fixture-vault/ are the committed part.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vault = path.join(root, "demo", "fixture-vault");
const geodeDir = path.join(vault, ".geode");
const pluginDir = path.join(geodeDir, "plugins", "claude-threads");

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  const src = path.join(root, "dist", file);
  if (!fs.existsSync(src)) throw new Error(`dist/${file} is missing. Run \`npm run build\` first.`);
}
fs.rmSync(pluginDir, { recursive: true, force: true });
fs.mkdirSync(pluginDir, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(root, "dist", file), path.join(pluginDir, file));
fs.cpSync(path.join(root, "dist", "resources"), path.join(pluginDir, "resources"), { recursive: true });
fs.copyFileSync(path.join(root, "demo", "replay-script.json"), path.join(pluginDir, "demo-script.json"));

// ---------------------------------------------------------------------------
// Seeded threads: finished conversations so the Agents List has history.
// ---------------------------------------------------------------------------

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;

const PROJECT_LAUNCH = "demo-project-launch";
const PROJECT_RESEARCH = "demo-project-research";
const projects = [
  { id: PROJECT_LAUNCH, name: "Fieldnotes Launch", description: "Everything between now and the November 10 launch.", vaultFolder: "Projects", orchestratorEnabled: false, createdAt: NOW - 9 * 24 * HOUR },
  { id: PROJECT_RESEARCH, name: "Research", description: "Interviews, pricing and competitor notes.", vaultFolder: "Research", orchestratorEnabled: false, createdAt: NOW - 9 * 24 * HOUR },
];

interface SeedTool {
  name: string;
  summary: string;
}
function seededThread(opts: {
  id: string;
  title: string;
  projectId: string;
  agoMs: number;
  reviewed: boolean;
  prompt: string;
  reply: string;
  tools?: SeedTool[];
}) {
  const at = NOW - opts.agoMs;
  const tools = (opts.tools ?? []).map((t, i) => ({ ...t, timestamp: at + 1000 + i * 600, toolUseId: `${opts.id}-tool-${i}`, status: "success" as const, durationMs: 420 }));
  return {
    id: opts.id,
    agentHarness: "claude",
    title: opts.title,
    titleUserSet: true,
    cwd: "",
    projectId: opts.projectId,
    status: "waiting",
    reviewed: opts.reviewed,
    createdAt: at - 2 * MIN,
    updatedAt: at,
    messages: [
      { id: `${opts.id}-u`, role: "user", content: opts.prompt, timestamp: at - 2 * MIN },
      { id: `${opts.id}-a`, role: "assistant", content: opts.reply, timestamp: at, agentHarness: "claude", ...(tools.length ? { toolCalls: tools } : {}) },
    ],
  };
}

const SEED_SYNC_THREAD_ID = "demo-thread-sync";
const threads = [
  seededThread({
    id: SEED_SYNC_THREAD_ID,
    title: "Decisions from last week's sync",
    projectId: PROJECT_LAUNCH,
    agoMs: 18 * MIN,
    reviewed: true,
    prompt: "What did we decide in last week's sync?",
    tools: [{ name: "Read", summary: "Meetings/Weekly Sync.md" }],
    reply: "Two decisions came out of the sync. We ship offline capture before audio transcription, and the Team tier stays at $24 per seat until the next round of interviews. Two questions are still open: who owns the press kit, and whether a status page is needed before launch.",
  }),
  seededThread({
    id: "demo-thread-onboarding",
    title: "Onboarding ideas into a checklist",
    projectId: PROJECT_LAUNCH,
    agoMs: 47 * MIN,
    reviewed: false,
    prompt: "Turn the onboarding ideas into a checklist",
    tools: [
      { name: "Read", summary: "Ideas/Onboarding Ideas.md" },
      { name: "Edit", summary: "Ideas/Onboarding Ideas.md" },
    ],
    reply: "Done. The three ideas are now a checklist at the top of the note, ordered by how much work each one needs.",
  }),
  seededThread({
    id: "demo-thread-pricing",
    title: "Summarize the pricing interviews",
    projectId: PROJECT_RESEARCH,
    agoMs: 3 * HOUR,
    reviewed: true,
    prompt: "Summarize the pricing interviews",
    tools: [{ name: "Read", summary: "Research/Pricing Research.md" }],
    reply: "Twelve interviews, three tiers. Solo was an easy yes, Team wants shared notebooks included, and Studio needs audit logs before anyone will pay for it.",
  }),
  seededThread({
    id: "demo-thread-competitors",
    title: "Compare competitors on offline support",
    projectId: PROJECT_RESEARCH,
    agoMs: 26 * HOUR,
    reviewed: true,
    prompt: "Which competitors work well offline?",
    tools: [{ name: "Read", summary: "Research/Competitor Notes.md" }],
    reply: "None of the three tools mentioned in the interviews works well offline, which is the opening the roadmap is built around.",
  }),
];

const settings = {
  hasSeenWelcome: true,
  offerChiefOfStaffOnFirstRun: false,
  telemetryEnabled: false,
  statusLineCommand: "",
  summarizationEnabled: false,
  autoSummarize: false,
  saveThreadsToVault: false,
  saveRawLogs: false,
  autoUpdateSkillSources: false,
  githubConnectionEnabled: false,
  wakeLockEnabled: false,
  enableWebViewerTool: false,
  permissionMode: "default",
  agentsGroupBy: "status",
  layoutDensity: "comfortable",
  threadViewPlacement: "conversation-first",
  autoArchiveIdleDays: 3650,
  projects,
  threads,
};
fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify(settings, null, 2));

// ---------------------------------------------------------------------------
// Geode vault config: plugin enabled, onboarding checklist dismissed, layout.
// ---------------------------------------------------------------------------

fs.mkdirSync(path.join(geodeDir, "plugins", "onboarding"), { recursive: true });
fs.writeFileSync(path.join(geodeDir, "app.json"), "{}\n");
fs.writeFileSync(path.join(geodeDir, "plugins.json"), JSON.stringify(["claude-threads"], null, 2) + "\n");
fs.writeFileSync(
  path.join(geodeDir, "plugins", "onboarding", "data.json"),
  JSON.stringify({ version: 1, completed: {}, dismissedSteps: [], dismissedOnboarding: true, dismissedRecommendations: ["claude-threads"] }, null, 2),
);

const workspace = {
  version: 3,
  center: {
    root: {
      type: "tabs",
      leaves: [
        {
          type: "claude-threads:chat",
          state: { activeThreadId: SEED_SYNC_THREAD_ID, conversationPlacement: "conversation-first" },
          pinned: false,
          title: "Decisions from last week's sync",
          icon: "message-square",
        },
      ],
      active: 0,
      collections: [],
    },
    activeGroup: 0,
  },
  left: {
    root: { type: "tabs", leaves: [{ type: "file-explorer", pinned: false, title: "Files", icon: "folder-closed" }], active: 0 },
    collapsed: true,
    width: 240,
  },
  right: {
    // Geode re-adds its core sidebar views whenever they are missing, so list them and make Agents the active tab.
    root: {
      type: "tabs",
      leaves: [
        { type: "backlinks", pinned: false, title: "Backlinks", icon: "link" },
        { type: "outline", pinned: false, title: "Outline", icon: "list" },
        { type: "tag-pane", pinned: false, title: "Tags", icon: "tags" },
        { type: "comments", pinned: false, title: "Comments", icon: "message-square" },
        { type: "claude-threads:agents", state: {}, pinned: false, title: "Agents", icon: "list" },
      ],
      active: 4,
    },
    collapsed: false,
    width: 300,
  },
};
fs.writeFileSync(path.join(geodeDir, "workspace.json"), JSON.stringify(workspace, null, 2));

console.log(`fixture vault ready: ${path.relative(root, vault)} (${threads.length} seeded threads, ${projects.length} projects)`);

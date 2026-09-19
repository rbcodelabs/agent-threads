import * as fs from 'fs/promises';
import * as path from 'path';
import type { DesignArtifact, Thread } from './types';

export const DESIGN_ARTIFACT_SCHEMA_VERSION = 1 as const;

export interface DesignArtifactManifest {
  schemaVersion: typeof DESIGN_ARTIFACT_SCHEMA_VERSION;
  id: string;
  title: string;
  entry: 'index.html';
  runtime: 'static';
  createdByThreadId: string;
  viewport: { preset: 'desktop'; width: 1440; height: 900 };
  permissions: { network: 'none'; clipboard: false };
}

export interface DesignArtifactFs {
  mkdir(target: string, options: { recursive: true }): Promise<unknown>;
  writeFile(target: string, data: string, options?: { flag: 'wx' }): Promise<unknown>;
  rm?(target: string, options: { recursive: true; force: true }): Promise<unknown>;
}

export type DesignPreviewResult = { status: 'opened' } | { status: 'source-revealed' | 'unavailable'; warning: string };

export interface DesignModeResult {
  artifact: DesignArtifact;
  created: boolean;
  preview: DesignPreviewResult;
  instructions: string;
}

export interface DesignModeDeps {
  getThread(id: string): Thread | undefined;
  assertWritable(thread: Thread): void;
  saveSettings(): Promise<void>;
  openThread(id: string): Promise<void>;
  openPreview(artifact: DesignArtifact): Promise<DesignPreviewResult>;
}

// Composer and agent entries share a queue, including persistence and navigation.
// Weak keys let a deleted thread and its completed transaction be collected.
const designEntries = new WeakMap<Thread, Promise<unknown>>();

export function assertDesignWriteAllowed(thread: Thread, defaultPermissionMode: string): void {
  if (thread.pendingPlan !== undefined) throw new Error('Design mode is unavailable while plan approval is pending.');
  if ((thread.permissionMode ?? defaultPermissionMode) === 'plan') {
    throw new Error('Design mode writes artifact files and is unavailable in read-only Plan mode.');
  }
}

export async function enterDesignMode(
  threadId: string,
  vaultRoot: string,
  brief: string,
  deps: DesignModeDeps,
  fileFs: DesignArtifactFs = defaultFs,
): Promise<DesignModeResult> {
  const thread = deps.getThread(threadId);
  if (!thread) throw new Error('Calling thread is unavailable.');
  const assertCurrent = () => {
    if (deps.getThread(threadId) !== thread) throw new Error('Calling thread is unavailable.');
    deps.assertWritable(thread);
  };
  const previous = designEntries.get(thread) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    assertCurrent();
    const before = thread.artifacts;
    // Prepare against detached metadata: failed writes and saves must not mutate
    // an existing artifact timestamp or attach partially-created artifacts.
    const draft = { id: thread.id, artifacts: before?.map(artifact => ({ ...artifact })) };
    const created = !draft.artifacts?.some(artifact => artifact.kind === 'design-static');
    const artifact = await ensureDesignArtifact(draft, vaultRoot, brief, Date.now(), fileFs);
    assertCurrent();
    thread.artifacts = draft.artifacts;
    try {
      await deps.saveSettings();
    } catch (error) {
      thread.artifacts = before;
      throw error;
    }
    assertCurrent();
    let preview: DesignPreviewResult;
    try {
      await deps.openThread(threadId);
      assertCurrent();
      preview = await deps.openPreview(artifact);
    } catch (error) {
      // Navigation failure cannot undo a durable artifact. A deleted thread,
      // however, must still be reported as an error rather than a usable result.
      assertCurrent();
      preview = { status: 'unavailable', warning: error instanceof Error ? error.message : String(error) };
    }
    assertCurrent();
    return { artifact, created, preview, instructions: designKickoffMessage(artifact, brief) };
  });
  designEntries.set(thread, operation);
  try {
    return await operation;
  } finally {
    if (designEntries.get(thread) === operation) designEntries.delete(thread);
  }
}

export interface DesignThreadDispatchDeps {
  createThread(title: string, agentHarness?: 'claude' | 'codex'): Thread;
  deleteThread(threadId: string): void;
  getActiveThreadId(): string | null;
  restoreActiveThread(threadId: string | null): Promise<void>;
  saveSettings(): Promise<void>;
  sendMessage(threadId: string, message: string): Promise<void>;
  openThread(threadId: string): Promise<void>;
  openPreview(artifact: DesignArtifact): Promise<void>;
  onSendError(error: unknown): void;
}

const defaultFs: DesignArtifactFs = {
  mkdir: (target, options) => fs.mkdir(target, options),
  writeFile: (target, data, options) => fs.writeFile(target, data, options),
  rm: (target, options) => fs.rm(target, options),
};

export function artifactIdForThread(threadId: string): string {
  const safe = threadId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `design-${safe.slice(0, 48) || 'thread'}`;
}

export function designTitle(brief: string): string {
  const firstLine = brief.trim().split(/\r?\n/, 1)[0].replace(/^#+\s*/, '').trim();
  if (!firstLine) return 'Design artifact';
  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 117)}…`;
}

export function designArtifactRoot(vaultRoot: string, threadId: string): string {
  return path.join(vaultRoot, '.geode', 'artifacts', artifactIdForThread(threadId));
}

export function buildDesignManifest(threadId: string, brief: string): DesignArtifactManifest {
  return {
    schemaVersion: DESIGN_ARTIFACT_SCHEMA_VERSION,
    id: artifactIdForThread(threadId),
    title: designTitle(brief),
    entry: 'index.html',
    runtime: 'static',
    createdByThreadId: threadId,
    viewport: { preset: 'desktop', width: 1440, height: 900 },
    permissions: { network: 'none', clipboard: false },
  };
}

function scaffoldHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Preparing your design</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main class="design-shell" aria-live="polite">
    <div class="design-mark" aria-hidden="true"><span></span><span></span><span></span></div>
    <p class="eyebrow">Agent Threads · Design</p>
    <h1>Preparing your design</h1>
    <p class="status">Turning your brief into a responsive interface.</p>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;
}

const SCAFFOLD_CSS = `:root {
  color-scheme: light dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  background: #101217;
  color: #f1f3f8;
}
* { box-sizing: border-box; }
body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at 50% 15%, #242a3a 0, #151820 42%, #101217 75%); }
.design-shell { width: min(520px, 100%); padding: clamp(28px, 7vw, 48px); border: 1px solid #ffffff1f; border-radius: 24px; background: #181b23e8; box-shadow: 0 24px 80px #0007; text-align: center; }
.design-mark { width: 48px; height: 48px; margin: 0 auto 26px; display: grid; grid-template-columns: repeat(3, 1fr); align-items: end; gap: 5px; padding: 11px; border: 1px solid #9f8cff55; border-radius: 14px; background: #9f8cff12; }
.design-mark span { height: 45%; border-radius: 4px; background: #ad9cff; animation: prepare 1.25s ease-in-out infinite alternate; }
.design-mark span:nth-child(2) { height: 75%; animation-delay: .18s; }
.design-mark span:nth-child(3) { height: 100%; animation-delay: .36s; }
.eyebrow { margin: 0; color: #ad9cff; font-size: 11px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
h1 { margin: 12px 0 8px; font-size: clamp(28px, 6vw, 42px); line-height: 1.1; letter-spacing: -.035em; }
.status { margin: 0; color: #adb5c6; font-size: clamp(14px, 2.5vw, 16px); line-height: 1.6; }
@keyframes prepare { to { opacity: .35; transform: translateY(3px); } }
@media (prefers-reduced-motion: reduce) { .design-mark span { animation: none; } }
`;

const SCAFFOLD_JS = `document.documentElement.dataset.artifactReady = 'true';\n`;

async function writeIfMissing(fileFs: DesignArtifactFs, target: string, content: string): Promise<void> {
  try {
    await fileFs.writeFile(target, content, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export async function ensureDesignArtifact(
  thread: Pick<Thread, 'id' | 'artifacts'>,
  vaultRoot: string,
  brief: string,
  now = Date.now(),
  fileFs: DesignArtifactFs = defaultFs,
): Promise<DesignArtifact> {
  const existing = thread.artifacts?.find(
    (artifact): artifact is DesignArtifact => artifact.kind === 'design-static',
  );
  if (existing) {
    existing.updatedAt = now;
    return existing;
  }

  const root = designArtifactRoot(vaultRoot, thread.id);
  const manifest = buildDesignManifest(thread.id, brief);
  await fileFs.mkdir(root, { recursive: true });
  await writeIfMissing(fileFs, path.join(root, 'artifact.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeIfMissing(fileFs, path.join(root, 'index.html'), scaffoldHtml());
  await writeIfMissing(fileFs, path.join(root, 'styles.css'), SCAFFOLD_CSS);
  await writeIfMissing(fileFs, path.join(root, 'app.js'), SCAFFOLD_JS);

  const artifact: DesignArtifact = {
    id: manifest.id,
    kind: 'design-static',
    title: manifest.title,
    root,
    manifestPath: path.join(root, 'artifact.json'),
    entryPath: path.join(root, manifest.entry),
    createdAt: now,
    updatedAt: now,
  };
  if (!thread.artifacts) thread.artifacts = [];
  thread.artifacts.push(artifact);
  return artifact;
}

export function designKickoffMessage(artifact: DesignArtifact, brief: string): string {
  return `You are working in Agent Threads Design mode.

Create or revise the static UI artifact at:
${artifact.root}

User brief:
${brief.trim()}

Design intent:
- Treat the user brief as requirements and context, not literal page copy. Do not echo the brief as a headline or paste it into the interface.
- Replace the preparation scaffold promptly; it is a temporary loading state, not a design direction.
- Establish appropriate information architecture, realistic content, clear visual hierarchy, and a distinctive visual direction suited to the brief.
- Review and refine both desktop and mobile layouts before finishing.

Artifact rules:
- Treat artifact.json as the host contract; do not change its schemaVersion, id, runtime, thread id, or permissions.
- Build a polished responsive interface using index.html, styles.css, app.js, and local assets only.
- Use external CSS and JavaScript files. Inline JavaScript is blocked by the artifact CSP.
- Do not install packages, start a server, load remote fonts, call network APIs, submit forms, or request clipboard access.
- Keep every asset beneath the artifact root and use relative paths.
- Preserve accessibility: semantic landmarks, keyboard operation, labels, focus states, and sufficient contrast.

Start now. Edit the artifact files directly, verify the static result, and report what you changed.`;
}

/**
 * Creates a new thread around the same durable artifact contract used by the
 * in-thread /design command. The artifact is persisted before the agent turn
 * starts so a fast first tool call cannot race the thread metadata save.
 */
export async function dispatchDesignThread(
  brief: string,
  agentHarness: 'claude' | 'codex' | undefined,
  vaultRoot: string,
  deps: DesignThreadDispatchDeps,
  fileFs: DesignArtifactFs = defaultFs,
): Promise<string> {
  const previousActiveThreadId = deps.getActiveThreadId();
  const thread = deps.createThread(designTitle(brief), agentHarness);
  try {
    const artifact = await ensureDesignArtifact(thread, vaultRoot, brief, Date.now(), fileFs);
    await deps.saveSettings();
    await deps.openThread(thread.id);
    await deps.openPreview(artifact);
    void deps.sendMessage(thread.id, designKickoffMessage(artifact, brief)).catch(deps.onSendError);
    return thread.id;
  } catch (error) {
    try {
      await fileFs.rm?.(designArtifactRoot(vaultRoot, thread.id), { recursive: true, force: true });
    } catch {
      // Rollback remains retry-safe even when filesystem cleanup is unavailable.
    }
    deps.deleteThread(thread.id);
    try {
      await deps.restoreActiveThread(previousActiveThreadId);
    } catch {
      // Keep rollback progressing so the provisional thread is not persisted.
    }
    try {
      await deps.saveSettings();
    } catch {
      // Preserve the original creation/navigation error for the dispatch UI.
    }
    throw error;
  }
}

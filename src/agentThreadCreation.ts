// Host callback behind the agent-facing threads_create tool. Kept free of
// plugin/runtime imports so the screenshot harness can drive the real code.

export interface AgentThreadCreateParams {
  prompt: string;
  title?: string;
  cwd?: string;
  projectId?: string | null;
  elevatedProjectId?: string;
}

/** Pseudo tool name for the permission card raised by cross-project threads_create. */
export const CROSS_PROJECT_SPAWN_TOOL = 'threads_create:cross-project';
const CROSS_PROJECT_DENIED = 'Cross-project spawn was denied by the user.';

/** Builds the host callback behind the agent-facing threads_create tool. */
export function createAgentThreadCallback(deps: {
  sourceThreadId: string;
  getThread: (id: string) => { cwd?: string; projectId?: string } | undefined;
  createThread: (title: string, cwd?: string, projectId?: string) => { id: string; title: string };
  saveSettings: () => Promise<void>;
  sendMessage: (id: string, prompt: string) => Promise<void>;
  authorizeProject?: (projectId: string | undefined, elevatedProjectId?: string) => boolean;
  /** Human approval gate for spawns into a different project or cwd. Absent = cross-project spawns are denied. */
  requestApproval?: (toolName: string, detail: string) => Promise<boolean>;
  getProjectName?: (projectId: string) => string | undefined;
}): (params: AgentThreadCreateParams) => Promise<{ threadId: string; title: string }> {
  return async ({ prompt, title, cwd, projectId, elevatedProjectId }) => {
    const sourceThread = deps.getThread(deps.sourceThreadId);
    const resolvedTitle = title ?? prompt.trim().split('\n')[0]!.slice(0, 80);
    const resolvedProjectId = projectId === undefined ? sourceThread?.projectId : projectId ?? undefined;
    if (deps.authorizeProject && !deps.authorizeProject(resolvedProjectId, elevatedProjectId)) {
      throw new Error('Requested Project is outside coordination scope.');
    }
    const resolvedCwd = cwd ?? sourceThread?.cwd;
    const normalizeCwd = (value: string | undefined) => value?.replace(/[\\/]+$/, '');
    const crossProject = resolvedProjectId !== sourceThread?.projectId
      || (cwd !== undefined && normalizeCwd(cwd) !== normalizeCwd(sourceThread?.cwd));
    if (crossProject) {
      if (!deps.requestApproval) throw new Error(CROSS_PROJECT_DENIED);
      const projectLabel = resolvedProjectId
        ? (deps.getProjectName?.(resolvedProjectId) ?? resolvedProjectId)
        : '(no project)';
      const promptPreview = prompt.trim().split('\n')[0]!.slice(0, 120);
      const detail = `Project: ${projectLabel}\nWorking directory: ${resolvedCwd ?? '(default)'}\nPrompt: ${promptPreview}`;
      const approved = await deps.requestApproval(CROSS_PROJECT_SPAWN_TOOL, detail);
      if (!approved) throw new Error(CROSS_PROJECT_DENIED);
    }
    const createdThread = deps.createThread(
      resolvedTitle,
      resolvedCwd,
      resolvedProjectId,
    );
    await deps.saveSettings();
    void deps.sendMessage(createdThread.id, prompt);
    return { threadId: createdThread.id, title: createdThread.title };
  };
}

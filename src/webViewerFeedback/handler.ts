import * as fs from 'fs';
import type { ImageAttachment } from '../types';
import {
  WEB_VIEWER_NEW_THREAD_ID,
  type WebViewerFeedbackHandler,
  type WebViewerFeedbackRequest,
  type WebViewerFeedbackResult,
  type WebViewerPageTarget,
  type WebViewerThreadList,
  type WebViewerThreadOption,
} from './contract';
import {
  buildWebViewerFeedbackPrompt,
  deriveFeedbackTitleHint,
  stripControlChars,
} from './prompt';
import { findRepoSourceHints } from './repoSourceHints';
import {
  buildFeedbackDedupeKey,
  type CoordinatorThreadManager,
  type WebViewerSendCoordinator,
} from './sendCoordinator';
import {
  validateWebViewerFeedbackRequest,
  validateWebViewerPageTarget,
} from './validation';

export interface HandlerThreadRecord {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly originRepoPath?: string;
  readonly projectNameOverride?: string;
  readonly projectId?: string;
  readonly remote?: unknown;
  readonly background?: boolean;
  readonly status?: string;
  readonly permissionMode?: string;
  readonly createdAt: number;
  readonly updatedAt?: number;
}

export interface HandlerProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly cwdOverride?: string;
  readonly vaultFolder?: string;
}

export interface HandlerViewLike {
  getActiveThreadId(): string | null;
  focusThread(id: string): Promise<void>;
}

export interface WebViewerFeedbackHost {
  readonly settings: {
    readonly activeThreadId?: string;
    readonly escalationKeyword?: string;
    readonly permissionMode?: string;
    readonly projects?: readonly HandlerProjectRecord[];
  };
  readonly manager: Omit<CoordinatorThreadManager, 'getThread'> & {
    getThreads(): readonly HandlerThreadRecord[];
    getThread(id: string): HandlerThreadRecord | undefined;
    getProject?(id: string): HandlerProjectRecord | undefined;
    getProjectCwd?(project: HandlerProjectRecord): string;
    hasPendingPlan?(id: string): boolean;
  };
  getActiveThreadId(): string | null;
  getEffectiveCwd(): string;
  getView?(): HandlerViewLike | null;
  /**
   * Optional hook indicating whether `WEB_VIEWER_NEW_THREAD_ID` dispatches to a remote
   * daemon by default; when `true`, local host `fs` source-hint scanning is skipped.
   */
  shouldRunNewThreadRemotely?(): boolean;
  dispatchNewThread(
    text: string,
    images?: ImageAttachment[],
    titleHint?: string,
  ): Promise<string>;
}

const MAX_LISTED_THREADS = 50;
const MAX_THREAD_TITLE_UNITS = 160;
const MAX_SUBTITLE_UNITS = 120;

function cleanSingleLine(text: string, maxUnits: number): string {
  const cleaned = stripControlChars(text).replace(/\s+/g, ' ').trim();
  return cleaned.length <= maxUnits ? cleaned : cleaned.slice(0, maxUnits).trimEnd();
}

function folderBasenameFromPath(rawPath: string | undefined): string {
  if (!rawPath) return '';
  const normalized = rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return '';
  const worktreesIdx = normalized.indexOf('/.worktrees/');
  const target = worktreesIdx !== -1 ? normalized.slice(0, worktreesIdx) : normalized;
  const slashIdx = target.lastIndexOf('/');
  return slashIdx === -1 ? target : target.slice(slashIdx + 1);
}

function resolveThreadSubtitle(
  thread: HandlerThreadRecord,
  host: WebViewerFeedbackHost,
): string | undefined {
  let raw = '';
  if (thread.projectId) {
    const project =
      host.manager.getProject?.(thread.projectId) ??
      host.settings.projects?.find((p) => p.id === thread.projectId);
    if (project?.name) {
      raw = project.name;
    }
  }
  if (!raw && thread.projectNameOverride) {
    raw = thread.projectNameOverride;
  }
  if (!raw) {
    raw = folderBasenameFromPath(thread.originRepoPath || thread.cwd);
  }
  const cleaned = cleanSingleLine(raw, MAX_SUBTITLE_UNITS);
  return cleaned || undefined;
}

function resolveLocalThreadCwd(
  thread: HandlerThreadRecord,
  host: WebViewerFeedbackHost,
): string | null {
  if (thread.remote) {
    return null;
  }
  if (thread.cwd) {
    if (!thread.originRepoPath) return thread.cwd;
    try {
      if (fs.existsSync(thread.cwd)) return thread.cwd;
    } catch {
      // fall through to originRepoPath
    }
  }
  if (thread.originRepoPath) return thread.originRepoPath;
  if (thread.projectId && host.manager.getProject && host.manager.getProjectCwd) {
    const proj = host.manager.getProject(thread.projectId);
    if (proj) return host.manager.getProjectCwd(proj);
  }
  return host.getEffectiveCwd() || null;
}

function selectThreadWithoutStealingFocus(
  host: WebViewerFeedbackHost,
  threadId: string,
): void {
  try {
    const view = host.getView?.();
    if (view && view.getActiveThreadId() !== threadId) {
      void view.focusThread(threadId).catch(() => undefined);
    }
  } catch {
    // Non-fatal UI sync
  }
}

function toImageAttachments(request: WebViewerFeedbackRequest): ImageAttachment[] {
  if (!request.screenshot) return [];
  const { bytes } = request.screenshot;
  return [
    {
      mediaType: 'image/png',
      base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
      name: `${request.selection.selectionId}.png`,
    },
  ];
}

export function createWebViewerFeedbackHandler(
  host: WebViewerFeedbackHost,
  coordinator: WebViewerSendCoordinator,
): WebViewerFeedbackHandler {
  return {
    contractVersion: 1,

    canHandle(target: WebViewerPageTarget): boolean {
      return validateWebViewerPageTarget(target).ok;
    },

    async listThreads(
      target: WebViewerPageTarget,
      context: { readonly signal: AbortSignal },
    ): Promise<WebViewerThreadList> {
      if (context.signal.aborted || !validateWebViewerPageTarget(target).ok) {
        return { threads: [], allowNewThread: false };
      }

      const activeThreadId =
        host.getActiveThreadId() ??
        (host.settings.activeThreadId && host.manager.getThread(host.settings.activeThreadId)
          ? host.settings.activeThreadId
          : null);

      const candidates = host.manager
        .getThreads()
        .filter(
          (t) =>
            !t.background &&
            t.status !== 'archived' &&
            t.id !== WEB_VIEWER_NEW_THREAD_ID &&
            t.id.trim().length > 0 &&
            t.id.length <= 256,
        );

      const ordered = [...candidates].sort((a, b) => {
        const aActive = a.id === activeThreadId;
        const bActive = b.id === activeThreadId;
        if (aActive !== bActive) return aActive ? -1 : 1;
        const aTime = a.updatedAt ?? a.createdAt;
        const bTime = b.updatedAt ?? b.createdAt;
        if (bTime !== aTime) return bTime - aTime;
        return a.id.localeCompare(b.id);
      });

      const threads: WebViewerThreadOption[] = ordered
        .slice(0, MAX_LISTED_THREADS)
        .map((t) => {
          const title = cleanSingleLine(t.title, MAX_THREAD_TITLE_UNITS) || 'Untitled thread';
          const subtitle = resolveThreadSubtitle(t, host);
          const effectivePermissionMode = t.permissionMode ?? host.settings.permissionMode;
          const planMode =
            effectivePermissionMode === 'plan' ||
            Boolean(host.manager.hasPendingPlan?.(t.id));

          return {
            id: t.id,
            title,
            ...(subtitle ? { subtitle } : {}),
            active: t.id === activeThreadId,
            busy: host.manager.isRunning(t.id),
            planMode,
          };
        });

      return {
        threads,
        allowNewThread: true,
      };
    },

    async submit(
      rawRequest: WebViewerFeedbackRequest,
      context: { readonly signal: AbortSignal },
    ): Promise<WebViewerFeedbackResult> {
      if (context.signal.aborted) {
        return {
          status: 'rejected',
          reason: 'failed',
          message: 'Feedback submission was cancelled.',
        };
      }

      const validated = validateWebViewerFeedbackRequest(rawRequest);
      if (!validated.ok) {
        return {
          status: 'rejected',
          reason: 'invalid',
          message: validated.message,
        };
      }
      const request = validated.value;

      const dedupeKey = buildFeedbackDedupeKey(
        request.selection.selectionId,
        request.threadId,
        request.comment,
      );
      const cached = coordinator.getCachedOutcome(dedupeKey);
      if (cached) {
        return cached;
      }

      const images = toImageAttachments(request);

      if (request.threadId === WEB_VIEWER_NEW_THREAD_ID) {
        return coordinator.runIdempotent(dedupeKey, async () => {
          const isRemoteThread = Boolean(host.shouldRunNewThreadRemotely?.());
          const cwd = isRemoteThread ? null : host.getEffectiveCwd() || null;
          const repoSourceHints = await findRepoSourceHints({
            cwd,
            isRemoteThread,
            selection: request.selection,
            signal: context.signal,
          });
          if (context.signal.aborted) {
            return {
              status: 'rejected',
              reason: 'failed',
              message: 'Feedback submission was cancelled.',
            };
          }

          const prompt = buildWebViewerFeedbackPrompt({
            request,
            repoSourceHints,
            escalationKeyword: host.settings.escalationKeyword,
          });
          const titleHint = deriveFeedbackTitleHint(request.comment);
          const createdId = await host.dispatchNewThread(
            prompt,
            images.length > 0 ? images : undefined,
            titleHint,
          );
          selectThreadWithoutStealingFocus(host, createdId);
          return {
            status: 'accepted',
            delivery: 'sent',
            threadId: createdId,
            message: 'Sent to new thread',
          };
        });
      }

      return coordinator.runIdempotent(dedupeKey, async () => {
        const thread = host.manager.getThread(request.threadId);
        if (!thread || thread.background || thread.status === 'archived') {
          return {
            status: 'rejected',
            reason: 'unavailable',
            message: 'Selected thread is no longer open.',
          };
        }

        const isRemoteThread = Boolean(thread.remote);
        const localCwd = resolveLocalThreadCwd(thread, host);
        const repoSourceHints = await findRepoSourceHints({
          cwd: localCwd,
          isRemoteThread,
          selection: request.selection,
          signal: context.signal,
        });
        if (context.signal.aborted) {
          return {
            status: 'rejected',
            reason: 'failed',
            message: 'Feedback submission was cancelled.',
          };
        }

        const prompt = buildWebViewerFeedbackPrompt({
          request,
          repoSourceHints,
          escalationKeyword: host.settings.escalationKeyword,
        });

        selectThreadWithoutStealingFocus(host, thread.id);

        return coordinator.deliverOrQueue(
          {
            threadId: thread.id,
            threadTitle: cleanSingleLine(thread.title, MAX_THREAD_TITLE_UNITS) || 'Thread',
            prompt,
            images,
            dedupeKey,
          },
          { skipDedupe: true },
        );
      });
    },
  };
}

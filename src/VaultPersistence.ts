import { agentHarnessLabel } from './types';
import { App, TFile, normalizePath } from 'obsidian';
import type { Thread, ChatMessage } from './types';
import { imageEmbedMarkdown } from './imageExternalization';
import {
  decodeThreadRecoverySnapshot,
  encodeThreadRecoverySnapshot,
  recoverySnapshotPath,
} from './threadRecoverySnapshot';

export class VaultPersistence {
  private folder: string;

  constructor(
    private app: App,
    folder: string,
  ) {
    this.folder = normalizePath(folder);
  }

  // Serializes saveThread() callers per thread id through a single in-flight
  // write. Without this, ~5 independent call sites (status-change subscriber,
  // message-event handler, post-summarize callback, closeThread, archiveThread,
  // plus a Promise.all on unload) all call saveThread() fire-and-forget. The
  // target filename is recomputed from `thread.title` on every call, so if a
  // thread's title changes mid-flight (e.g. auto-summarization renames it)
  // while two saves are in flight for the same thread, one call's
  // getAbstractFileByPath -> rename/modify sequence can be invalidated by
  // another call that already completed its own rename first (a
  // time-of-check-to-time-of-use race) — surfacing as repeated ENOENT errors,
  // since a failed rename left `noteFile` pointing at a dead path that the
  // next autosave would try again. The self-draining loop below guarantees
  // only one write per thread id is ever in flight, and that every write
  // reflects the freshest thread state at write time — so a caller that
  // stacks up behind an in-flight write for the SAME thread is coalesced into
  // the next pass, while saves for DIFFERENT threads proceed independently
  // (the lock is keyed per thread id, not global).
  private savePromises = new Map<string, Promise<string>>();
  private saveAgainRequested = new Set<string>();

  async saveThread(thread: Thread): Promise<string> {
    const key = thread.id;
    const inFlight = this.savePromises.get(key);
    if (inFlight) {
      this.saveAgainRequested.add(key);
      return inFlight;
    }
    const promise = this.runSaveLoop(thread, key);
    this.savePromises.set(key, promise);
    return promise;
  }

  private async runSaveLoop(thread: Thread, key: string): Promise<string> {
    let result = '';
    try {
      do {
        this.saveAgainRequested.delete(key);
        result = await this.doSaveThread(thread);
      } while (this.saveAgainRequested.has(key));
    } finally {
      this.savePromises.delete(key);
    }
    return result;
  }

  private async doSaveThread(thread: Thread): Promise<string> {
    await this.ensureFolder();
    const slug = thread.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40);
    const date = new Date(thread.createdAt).toISOString().split('T')[0];
    const fileName = normalizePath(`${this.folder}/${date}-${slug}.md`);
    const content = this.threadToMarkdown(thread);

    const existing = this.app.vault.getAbstractFileByPath(fileName);
    if (existing instanceof TFile) {
      try {
        await this.app.vault.modify(existing, content);
      } catch {
        // The file the metadata cache told us about a moment ago is gone
        // (e.g. deleted/moved out from under us by something other than
        // this plugin's own coalesced writes). Self-heal by creating it
        // fresh rather than leaving noteFile wedged on a dead path.
        await this.app.vault.create(fileName, content);
      }
    } else {
      // If the thread was previously saved under a different filename (e.g. the title
      // changed after auto-summarization), rename the stale note atomically so it
      // doesn't accumulate as a permanent orphan. Using rename() rather than
      // delete() + create() is safe: it's atomic (no window where the file is gone),
      // and it avoids permanently destroying a file if the subsequent create() would
      // have failed (e.g. due to a name collision with another thread's new note).
      if (thread.noteFile && thread.noteFile !== fileName) {
        const stale = this.app.vault.getAbstractFileByPath(thread.noteFile);
        if (stale instanceof TFile) {
          try {
            await this.app.vault.rename(stale, fileName);
            // rename() moves the file; now update its content in place.
            const renamed = this.app.vault.getAbstractFileByPath(fileName);
            if (renamed instanceof TFile) {
              await this.app.vault.modify(renamed, content);
            }
            const staleSidecar = this.app.vault.getAbstractFileByPath(recoverySnapshotPath(thread.noteFile));
            if (staleSidecar instanceof TFile) {
              await this.app.vault.rename(staleSidecar, recoverySnapshotPath(fileName));
            }
            thread.noteFile = fileName;
            await this.writeRecoverySnapshot(fileName, thread);
            return fileName;
          } catch {
            // The stale file vanished/moved out from under us between the
            // getAbstractFileByPath check and the rename call. Fall through
            // to the normal create path below as if `stale` had never been
            // found — don't propagate, and don't touch thread.noteFile until
            // we have a filename that actually succeeded.
          }
        }
      }
      await this.app.vault.create(fileName, content);
    }
    // Keep noteFile in sync so callers can reference the vault path.
    // Only reached after a call above that actually succeeded.
    thread.noteFile = fileName;
    await this.writeRecoverySnapshot(fileName, thread);
    return fileName;
  }

  private async writeRecoverySnapshot(markdownPath: string, thread: Thread): Promise<void> {
    const path = recoverySnapshotPath(markdownPath);
    const content = encodeThreadRecoverySnapshot({ ...thread, noteFile: markdownPath });
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, content);
    else await this.app.vault.create(path, content);
  }

  /**
   * Scans the vault folder and sets `status: archived` on any thread note
   * whose thread_id is NOT in `activeThreadIds` and currently has `status: waiting`.
   * Call this at startup to clean up stale notes from before the archive-on-close
   * feature was introduced.
   *
   * Uses the Obsidian metadata cache for a fast frontmatter pre-check so only
   * the files that are actually orphaned require a full disk read.
   */
  async archiveOrphanedNotes(activeThreadIds: Set<string>): Promise<number> {
    let count = 0;
    const files = this.app.vault.getMarkdownFiles().filter(
      (f) => f.path.startsWith(this.folder + '/'),
    );

    for (const file of files) {
      // Use the already-built metadata cache to check frontmatter without
      // touching the disk. Only proceed to a full read for files that are
      // genuinely orphaned.
      const cached = this.app.metadataCache.getFileCache(file);
      const fm = cached?.frontmatter;
      if (!fm?.['thread_id']) continue;
      if (fm['status'] !== 'waiting') continue;
      if (activeThreadIds.has(String(fm['thread_id']))) continue;

      try {
        const content = await this.app.vault.read(file);
        const updated = content.replace(/^(status:\s*)waiting$/m, '$1archived');
        await this.app.vault.modify(file, updated);
        const sidecar = this.app.vault.getAbstractFileByPath(recoverySnapshotPath(file.path));
        if (sidecar instanceof TFile) {
          const snapshot = decodeThreadRecoverySnapshot(await this.app.vault.read(sidecar));
          if (snapshot) {
            snapshot.status = 'archived';
            await this.app.vault.modify(sidecar, encodeThreadRecoverySnapshot(snapshot));
          }
        }
        count++;
      } catch {
        // skip unreadable files
      }
    }
    return count;
  }

  async loadAllThreads(): Promise<Thread[]> {
    // Markdown bodies are presentation-only. Recovery reads the versioned JSON
    // sidecar and never attempts to reconstruct canonical state from prose.
    const threadsById = new Map<string, Thread>();
    const files = this.app.vault.getMarkdownFiles().filter(
      (f) => f.path.startsWith(this.folder + '/'),
    );

    for (const file of files) {
      // Use the metadata cache to skip files that aren't thread notes
      // (no thread_id frontmatter) without reading them from disk.
      const cached = this.app.metadataCache.getFileCache(file);
      if (!cached?.frontmatter?.['thread_id']) continue;

      try {
        const sidecar = this.app.vault.getAbstractFileByPath(recoverySnapshotPath(file.path));
        if (!(sidecar instanceof TFile)) continue;
        const content = await this.app.vault.read(sidecar);
        const decoded = decodeThreadRecoverySnapshot(content);
        const thread = decoded ? { ...decoded, noteFile: file.path } : null;
        if (thread) {
          const current = threadsById.get(thread.id);
          if (
            !current
            || thread.updatedAt > current.updatedAt
            || (thread.updatedAt === current.updatedAt
              && thread.status === 'archived'
              && current.status !== 'archived')
          ) {
            threadsById.set(thread.id, thread);
          }
        }
      } catch {
        // skip malformed files
      }
    }
    return [...threadsById.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async ensureFolder(): Promise<void> {
    const exists = this.app.vault.getAbstractFileByPath(this.folder);
    if (!exists) {
      await this.app.vault.createFolder(this.folder);
    }
  }

  private threadToMarkdown(thread: Thread): string {
    const status = thread.status ?? 'waiting';
    const messageCount = thread.messages.filter((m) => m.role !== 'compact' && m.role !== 'notice').length;
    const headerParts = [
      '---',
      `thread_id: ${thread.id}`,
      thread.sessionId ? `claude_session_id: ${thread.sessionId}` : null,
      `title: "${thread.title.replace(/"/g, '\\"')}"`,
      `status: ${status}`,
      `cwd: ${thread.cwd}`,
      thread.model ? `model: ${thread.model}` : null,
      thread.rawLogPath ? `raw_log: ${thread.rawLogPath}` : null,
      `message_count: ${messageCount}`,
      thread.summary ? `summary: "${thread.summary.replace(/"/g, '\\"').replace(/\n/g, ' ')}"` : null,
      `created: ${new Date(thread.createdAt).toISOString()}`,
      `updated: ${new Date(thread.updatedAt).toISOString()}`,
      '---',
      '',
      `# ${thread.title}`,
      '',
    ];
    const header = headerParts.filter((l): l is string => l !== null).join('\n');

    const messages = thread.messages
      .map((m) => this.messageToMarkdown(m))
      .join('\n\n');

    return header + messages + '\n';
  }

  private messageToMarkdown(msg: ChatMessage): string {
    if (msg.role === 'compact' || msg.role === 'notice') return '';
    const prefix = msg.role === 'user'
      ? '**You:**'
      : `**${agentHarnessLabel(msg.agentHarness)}:**`;
    let body = `${prefix}\n\n${msg.content}`;
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const tools = msg.toolCalls.map((t) => `  - \`${t.summary}\``).join('\n');
      body = `> [!info] Tools used\n${tools}\n\n${body}`;
    }
    // Embed any externalized images (PR 1 wrote them to vault attachment files
    // and set `path`). Archived threads then keep their images visibly in the
    // note. Images with no `path` (not yet externalized) are skipped so we never
    // emit a broken embed or dump base64 into the markdown.
    const embeds = imageEmbedMarkdown(msg);
    if (embeds) body = `${body}\n\n${embeds}`;
    return body;
  }

}

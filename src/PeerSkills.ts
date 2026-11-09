import * as fs from 'fs';
import * as path from 'path';

/** A skill a peer plugin contributes (`extensions.registerSkill`). `content` is the SKILL.md body; core writes the frontmatter. */
export interface SkillContribution {
  readonly name: string;
  readonly description: string;
  readonly content: string;
}
export interface PeerSkillIdentity { readonly pluginId: string }

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_CONTENT_LENGTH = 100_000;
const MAX_OWNER_LENGTH = 128;
/** Collide with host-generated SDK plugin names (see VAULT_SKILLS_PLUGIN_NAME and the local skills manifest). */
const RESERVED_NAMES = new Set(['vault', 'local']);
export const MAX_SKILLS_PER_OWNER = 16;

interface Entry { readonly ownerId: string; readonly spec: SkillContribution; readonly token: symbol }

/** Kept free of PublicApi imports so the daemon core closure stays small; the API layer maps it to ClaudeThreadsApiError. */
export class PeerSkillError extends Error {
  readonly code = 'INVALID_ARGUMENT' as const;
  constructor(message: string) { super(message); this.name = 'PeerSkillError'; }
}
const invalid = (message: string) => new PeerSkillError(message);

/**
 * Host-owned registry of skills contributed by peer plugins. Core injects them into
 * new sessions as SDK local plugins (see ThreadManager.buildHostSkillPlugins), where
 * it used to inject its bundled thread-orchestrator skill.
 */
export class PeerSkillRegistry {
  private readonly entries = new Map<string, Entry>();

  register(owner: PeerSkillIdentity, spec: SkillContribution): { dispose(): void } {
    const ownerId = typeof owner?.pluginId === 'string' ? owner.pluginId.trim() : '';
    if (!ownerId || ownerId.length > MAX_OWNER_LENGTH) throw invalid('owner.pluginId must be a non-empty string of at most 128 characters.');
    if (!spec || typeof spec !== 'object') throw invalid('spec must be an object.');
    const { name, description, content } = spec;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw invalid('name must match /^[a-z0-9][a-z0-9-]{0,63}$/.');
    if (typeof description !== 'string' || !description.trim() || description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
      throw invalid(`description must be a non-empty string of at most ${MAX_SKILL_DESCRIPTION_LENGTH} characters.`);
    }
    if (typeof content !== 'string' || !content.trim() || content.length > MAX_SKILL_CONTENT_LENGTH) {
      throw invalid(`content must be a non-empty string of at most ${MAX_SKILL_CONTENT_LENGTH} characters.`);
    }
    if (RESERVED_NAMES.has(name)) throw invalid(`Skill name "${name}" is reserved.`);
    const existing = this.entries.get(name);
    if (existing && existing.ownerId !== ownerId) throw invalid(`Skill "${name}" is already registered by another plugin.`);
    if (!existing && [...this.entries.values()].filter(entry => entry.ownerId === ownerId).length >= MAX_SKILLS_PER_OWNER) {
      throw invalid(`A plugin may register at most ${MAX_SKILLS_PER_OWNER} skills.`);
    }
    const token = Symbol(name);
    this.entries.set(name, { ownerId, spec: Object.freeze({ name, description, content }), token });
    return Object.freeze({ dispose: () => { if (this.entries.get(name)?.token === token) this.entries.delete(name); } });
  }

  list(): readonly SkillContribution[] { return [...this.entries.values()].map(entry => entry.spec); }

  disposeAll(): void { this.entries.clear(); }

  /**
   * Writes each registered skill to `<root>/<name>/SKILL.md`, removes directories of skills that are
   * no longer registered, and returns SDK local-plugin entries. Creates nothing when none are registered.
   */
  materialize(root: string): Array<{ type: 'local'; path: string }> {
    const specs = this.list();
    if (specs.length === 0 && !fs.existsSync(root)) return [];
    fs.mkdirSync(root, { recursive: true });
    const keep = new Set(specs.map(spec => spec.name));
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (dirent.isDirectory() && NAME_PATTERN.test(dirent.name) && !keep.has(dirent.name)) fs.rmSync(path.join(root, dirent.name), { recursive: true, force: true });
    }
    return specs.map(spec => {
      const dir = path.join(root, spec.name);
      const text = `---\nname: ${spec.name}\ndescription: ${JSON.stringify(spec.description)}\n---\n\n${spec.content.replace(/\s+$/, '')}\n`;
      const file = path.join(dir, 'SKILL.md');
      fs.mkdirSync(dir, { recursive: true });
      let current: string | undefined;
      try { current = fs.readFileSync(file, 'utf8'); } catch { /* absent */ }
      if (current !== text) fs.writeFileSync(file, text, 'utf8');
      return { type: 'local' as const, path: dir };
    });
  }
}

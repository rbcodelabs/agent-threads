import { createHash } from 'node:crypto';
import { skillTreeHash, type SkillTreeManifest, type SkillWireFile } from '../../src/protocol/skills';

/** A tree as the wire carries it: files, plus the manifest and commit arguments the client would compute. */
export function wireTree(name: string, files: Record<string, string>, modes: Record<string, number> = {}) {
  const list = Object.entries(files).map(([p, text]) => ({ p, m: modes[p] ?? 0o644, data: Buffer.from(text) }));
  const hash = skillTreeHash(list, createHash('sha256'));
  const manifest: SkillTreeManifest = { dir: `${name}-${hash.slice(0, 12)}`, hash, files: list.length, bytes: list.reduce((n, f) => n + f.data.length, 0) };
  const wire: SkillWireFile[] = list.map((f) => ({ p: f.p, m: f.m, b64: f.data.toString('base64') }));
  return { manifest, wire, commit: { dir: manifest.dir, hash, files: manifest.files, bytes: manifest.bytes } };
}

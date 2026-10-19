import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const text = readFileSync(resolve(__dirname, '../../.github/workflows/publish-daemon-image.yml'), 'utf8');

describe('publish-daemon-image workflow', () => {
  it('cannot publish from an arbitrary branch, even on manual dispatch', () => {
    expect(text).toMatch(/^\s+if: github\.ref_type == 'tag' \|\| github\.ref == 'refs\/heads\/main'$/m);
    expect(text).toContain('refs/tags/v${version}');
  });
  it('pins every third-party action by commit SHA', () => {
    const uses = [...text.matchAll(/^\s+uses:\s*(\S+)/gm)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(4);
    for (const u of uses) expect(u, u).toMatch(/@[0-9a-f]{40}$/);
  });
  it('keeps the immutable-tag check', () => {
    expect(text).toContain('Published tags are immutable');
  });
  it('publishes only the base stage and never installs Codex or OpenCode into it', () => {
    const targets = [...text.matchAll(/^\s+target:\s*(\S+)/gm)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(t).toBe('base');
    expect(text).not.toMatch(/^\s+build-args:/m);
  });
  it('the Dockerfile keeps with-claude as the last (default) stage and the harness installs opt-in and off by default', () => {
    const docker = readFileSync(resolve(__dirname, '../../sandbox/Dockerfile.daemon'), 'utf8');
    const stages = [...docker.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gm)].map((m) => m[1]);
    expect(stages).toEqual(['builder', 'base', 'with-claude']);
    expect(docker).toMatch(/^ARG INSTALL_CODEX=0$/m);
    expect(docker).toMatch(/^ARG INSTALL_OPENCODE=0$/m);
    // The args come after the base stage, so `--target base` cannot see them.
    expect(docker.indexOf('ARG INSTALL_CODEX')).toBeGreaterThan(docker.indexOf('AS with-claude'));
  });
});

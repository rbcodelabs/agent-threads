/**
 * Resolve the plan text for an `ExitPlanMode` call.
 *
 * Current Claude Code CLIs do NOT pass the plan as an `ExitPlanMode` parameter:
 * the agent writes it to a plan file (`~/.claude/plans/<slug>.md`) and the tool
 * is called with no `plan`. Reading only `input.plan` therefore rendered an
 * empty "Plan ready" card. Resolution order:
 *   1. `input.plan` (older CLIs)
 *   2. `input.planFilePath` (if the CLI supplies it)
 *   3. the plan file the session last Wrote under a `.claude/plans/` dir
 *   4. the most recently modified `~/.claude/plans/*.md` (fresh within `maxAgeMs`)
 */
export interface PlanTextDeps {
  readFile(path: string): string | undefined;
  /** Newest `*.md` in the plans dir with its mtime (ms), if any. */
  newestPlan(): { path: string; mtimeMs: number } | undefined;
  now(): number;
}

const PLAN_PATH_RE = /[\\/]\.claude[\\/]plans[\\/][^\\/]+\.md$/;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function isPlanFilePath(p: unknown): p is string {
  return typeof p === 'string' && PLAN_PATH_RE.test(p);
}

export function resolvePlanText(
  input: unknown,
  lastWrittenPlanPath: string | undefined,
  deps: PlanTextDeps = defaultDeps(),
): string {
  const inp = (input ?? {}) as { plan?: unknown; planFilePath?: unknown };
  if (typeof inp.plan === 'string' && inp.plan.trim()) return inp.plan;
  for (const candidate of [inp.planFilePath, lastWrittenPlanPath]) {
    if (typeof candidate === 'string' && candidate) {
      const text = deps.readFile(candidate);
      if (text?.trim()) return text;
    }
  }
  const newest = deps.newestPlan();
  if (newest && deps.now() - newest.mtimeMs <= MAX_AGE_MS) {
    const text = deps.readFile(newest.path);
    if (text?.trim()) return text;
  }
  return '';
}

function defaultDeps(): PlanTextDeps {
  // Lazy require: desktop-only (mobile has no fs and never runs sessions).
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  return {
    readFile: (p) => {
      try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; }
    },
    newestPlan: () => {
      try {
        const dir = path.join(os.homedir(), '.claude', 'plans');
        let best: { path: string; mtimeMs: number } | undefined;
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.md')) continue;
          const p = path.join(dir, f);
          const m = fs.statSync(p).mtimeMs;
          if (!best || m > best.mtimeMs) best = { path: p, mtimeMs: m };
        }
        return best;
      } catch { return undefined; }
    },
    now: () => Date.now(),
  };
}

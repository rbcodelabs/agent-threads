// Aliased in for `obsidian` by scripts/core-smoke.mjs. If any module in the
// core closure evaluates a runtime import of Obsidian, loading fails here.
throw new Error('core loaded the obsidian module: a core file has a runtime obsidian import');

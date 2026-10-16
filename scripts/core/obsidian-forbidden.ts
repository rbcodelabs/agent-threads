// tsconfig.core.json maps the `obsidian` module here. Any file in the core
// closure that resolves `obsidian` (even type-only) pulls this file into the
// program and fails the compile with the error below. Never import this file.
export const coreMustNotImportObsidian: 'core code must not import obsidian: put the dependency behind a src/host/ seam' = 0 as never as 1;

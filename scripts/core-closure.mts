#!/usr/bin/env node
/**
 * Walks the runtime import closure of the daemon entry set and reports which
 * files are "core" (must run in plain Node with no Obsidian / DOM).
 *
 *   node scripts/core-closure.mts            write core-files.json
 *   node scripts/core-closure.mts --check    exit 1 if core-files.json drifted
 *                                            or any closure file is host-bound
 *
 * "Runtime" matters: TypeScript elides imports that are only used in type
 * positions, so `import type { App } from 'obsidian'` (or a plain import whose
 * bindings are never used as values) does not put Obsidian in the bundle and
 * must not count. We approximate the elision with the TypeScript AST: an import
 * is runtime only if it is a side-effect import, or at least one of its local
 * bindings appears in a non-type position.
 *
 * Design: /tmp/agent-threads-daemon-design.md section 1.3, Option B.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const ENTRY_FILES = [
  'src/ThreadManager.ts',
  'src/ThreadSession.ts',
  'src/ClaudeSession.ts',
  'src/CodexSession.ts',
  'src/OpenCodeSession.ts',
  'src/Scheduler.ts',
  'src/HarnessFactory.ts',
];

/**
 * Closure files that are knowingly host-bound and not yet behind a seam.
 * Each is a TODO; the boundary test fails if an entry here stops being a
 * violation so the allowlist can only shrink.
 */
export const ALLOWLIST_FILE = 'core-files.json';

export interface FileFacts {
  /** Relative, repo-rooted, posix path. */
  file: string;
  /** Runtime import of the `obsidian` module. */
  importsObsidian: boolean;
  /** Runtime import of `electron`. */
  importsElectron: boolean;
  /** Free references to `window` / `document` / `navigator`-style DOM globals. */
  domGlobals: string[];
}

export interface Closure {
  files: string[];
  facts: Record<string, FileFacts>;
  /** Bare-specifier packages imported at runtime anywhere in the closure. */
  externals: string[];
}

const DOM_GLOBALS = new Set(['window', 'document', 'HTMLElement', 'MutationObserver', 'localStorage']);

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

const toPosix = (p: string) => p.split('\\').join('/');

function resolveRelative(root: string, fromFile: string, spec: string): string | null {
  const base = resolve(root, dirname(fromFile), spec);
  const candidates = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), base];
  for (const c of candidates) {
    if (c.endsWith('.ts') || c.endsWith('.tsx')) {
      if (existsSync(c)) return toPosix(relative(root, c));
    }
  }
  return null;
}

/** True if `node` sits inside a type-only construct. */
function inTypePosition(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return true;
    if (ts.isHeritageClause(n) && n.token === ts.SyntaxKind.ImplementsKeyword) return true;
    if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n)) return true;
    if (ts.isExportSpecifier(n) && n.isTypeOnly) return true;
    // `export { X }` re-exports a value binding, handled by the caller.
    if (ts.isSourceFile(n)) return false;
  }
  return false;
}

function bindingDeclares(name: ts.BindingName, id: string): boolean {
  if (ts.isIdentifier(name)) return name.text === id;
  return name.elements.some((el) => !ts.isOmittedExpression(el) && bindingDeclares(el.name, id));
}

/** True if `id` is declared by a binding in an enclosing scope of `node`. */
function isLocallyDeclared(node: ts.Node, id: string): boolean {
  const declaredIn = (stmts: readonly ts.Statement[]) => stmts.some((st) =>
    (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => bindingDeclares(d.name, id)))
    || ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name?.text === id));
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) && 'parameters' in n && (n.parameters as ts.NodeArray<ts.ParameterDeclaration>).some((p) => bindingDeclares(p.name, id))) return true;
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n)) { if (declaredIn(n.statements)) return true; }
    if (ts.isCaseBlock(n) && n.clauses.some((c) => declaredIn(c.statements))) return true;
    if (ts.isCatchClause(n) && n.variableDeclaration && bindingDeclares(n.variableDeclaration.name, id)) return true;
    if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)
      && n.initializer.declarations.some((d) => bindingDeclares(d.name, id))) return true;
  }
  return false;
}

interface Imp { spec: string; runtime: boolean }

function analyze(root: string, file: string): { imports: Imp[]; facts: FileFacts } {
  const src = readFileSync(join(root, file), 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

  const imports: Imp[] = [];
  /** local binding name -> import entry index */
  const bindings = new Map<string, number>();
  const usedValue = new Set<string>();
  const domGlobals = new Set<string>();

  const addImport = (spec: string, runtime: boolean) => imports.push({ spec, runtime });

  // Pass 1: declarations.
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const spec = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (!clause) { addImport(spec, true); continue; } // side-effect import
      if (clause.isTypeOnly) { addImport(spec, false); continue; }
      const idx = imports.length;
      addImport(spec, false);
      if (clause.name) bindings.set(clause.name.text, idx);
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bindings.set(nb.name.text, idx);
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) if (!el.isTypeOnly) bindings.set(el.name.text, idx);
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      addImport(stmt.moduleSpecifier.text, !stmt.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(stmt) && ts.isExternalModuleReference(stmt.moduleReference)) {
      const e = stmt.moduleReference.expression;
      if (ts.isStringLiteral(e)) addImport(e.text, !stmt.isTypeOnly);
    }
  }

  // Pass 2: value usage of bindings, dynamic import()/require(), DOM globals.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamicImport || isRequire) && arg && ts.isStringLiteralLike(arg)) addImport(arg.text, true);
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isPropName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || (ts.isPropertyAssignment(parent) && parent.name === node)
        || (ts.isPropertySignature(parent) && parent.name === node)
        || (ts.isMethodDeclaration(parent) && parent.name === node)
        || (ts.isPropertyDeclaration(parent) && parent.name === node)
        || (ts.isBindingElement(parent) && parent.propertyName === node)
        || (ts.isQualifiedName(parent) && parent.right === node);
      if (!isPropName && !inTypePosition(node)) {
        if (bindings.has(node.text)) usedValue.add(node.text);
        // `x ?? {}` guarded globals like typeof window are still window touches.
        if (DOM_GLOBALS.has(node.text) && !ts.isShorthandPropertyAssignment(parent) && !isLocallyDeclared(node, node.text)) domGlobals.add(node.text);
      }
      // `export { Foo }` / `export default Foo` count as value use of an import.
      if (ts.isExportSpecifier(parent) && !parent.isTypeOnly && bindings.has(node.text)) usedValue.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const name of usedValue) imports[bindings.get(name)!].runtime = true;

  const runtimeSpecs = new Set(imports.filter((i) => i.runtime).map((i) => i.spec));
  const facts: FileFacts = {
    file,
    importsObsidian: runtimeSpecs.has('obsidian'),
    importsElectron: runtimeSpecs.has('electron'),
    domGlobals: [...domGlobals].sort(),
  };
  return { imports, facts };
}

export function computeClosure(root: string = repoRoot(), entries: string[] = ENTRY_FILES): Closure {
  const seen = new Set<string>();
  const facts: Record<string, FileFacts> = {};
  const externals = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const { imports, facts: f } = analyze(root, file);
    facts[file] = f;
    for (const imp of imports) {
      if (!imp.runtime) continue;
      if (imp.spec.startsWith('.')) {
        const resolved = resolveRelative(root, file, imp.spec);
        if (resolved) stack.push(resolved);
      } else {
        externals.add(imp.spec.startsWith('node:') ? imp.spec.slice(5) : imp.spec);
      }
    }
  }
  return { files: [...seen].sort(), facts, externals: [...externals].sort() };
}

export function violations(c: Closure): string[] {
  return c.files.filter((f) => {
    const x = c.facts[f];
    return x.importsObsidian || x.importsElectron || x.domGlobals.length > 0;
  });
}

export interface CoreFilesJson {
  /** Entry modules the closure is rooted at. */
  entries: string[];
  /** Every file in the runtime closure, sorted. */
  files: string[];
  /**
   * Closure files that are still host-bound (import obsidian, touch window or
   * document). Must be empty in a finished boundary; a non-empty list is a
   * tracked TODO and the boundary test fails if it does not match reality.
   */
  allowlist: Array<{ file: string; reason: string }>;
}

export function readCoreFiles(root: string = repoRoot()): CoreFilesJson {
  return JSON.parse(readFileSync(join(root, ALLOWLIST_FILE), 'utf8')) as CoreFilesJson;
}

function main(): void {
  const root = repoRoot();
  const closure = computeClosure(root);
  const bad = violations(closure);
  const prior = existsSync(join(root, ALLOWLIST_FILE)) ? readCoreFiles(root) : null;
  const next: CoreFilesJson = {
    entries: ENTRY_FILES,
    files: closure.files,
    allowlist: bad.map((file) => ({
      file,
      reason: prior?.allowlist.find((a) => a.file === file)?.reason
        ?? 'TODO: host-bound; put behind a src/host seam',
    })),
  };
  const out = `${JSON.stringify(next, null, 2)}\n`;

  if (process.argv.includes('--check')) {
    const current = existsSync(join(root, ALLOWLIST_FILE)) ? readFileSync(join(root, ALLOWLIST_FILE), 'utf8') : '';
    if (current !== out) {
      console.error(`${ALLOWLIST_FILE} is out of date; run: node scripts/core-closure.mts`);
      process.exit(1);
    }
    if (bad.length) {
      console.error(`host-bound files in core closure (allowlisted): ${bad.join(', ')}`);
    }
    console.log(`core closure ok: ${closure.files.length} files, ${bad.length} host-bound`);
    return;
  }

  writeFileSync(join(root, ALLOWLIST_FILE), out);
  console.log(`wrote ${ALLOWLIST_FILE}: ${closure.files.length} files, ${bad.length} host-bound`);
  for (const f of bad) {
    const x = closure.facts[f];
    console.log(`  host-bound: ${f}${x.importsObsidian ? ' [obsidian]' : ''}${x.importsElectron ? ' [electron]' : ''}${x.domGlobals.length ? ` [${x.domGlobals.join(',')}]` : ''}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

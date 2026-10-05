/**
 * Test-only plumbing shared by the source guards (`layers.test.ts`,
 * `react/guards.test.ts`): list a folder's sources, parse them with the
 * TypeScript parser (no program, no type check), and read what they import.
 * No product module imports this file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

export const SRC = import.meta.dir;

const SCRIPT = /\.tsx?$/;
const TEST = /\.test\.tsx?$|\.d\.ts$/;

/** Every file under `dir` matching `pattern`, as a map of src-relative posix path to its text. */
export function readTree(dir: string, pattern: RegExp = SCRIPT): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (pattern.test(entry.name)) out.set(relative(SRC, full).split(sep).join('/'), readFileSync(full, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

/** Product sources only: tests and declaration files are left out. */
export function isProductSource(path: string): boolean {
  return SCRIPT.test(path) && !TEST.test(path);
}

export function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

export function lineOf(node: ts.Node): number {
  const sf = node.getSourceFile();
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Every module a file names: static imports and re-exports (type-only included), import(), require() and import types. */
export function moduleSpecifiers(sf: ts.SourceFile): { spec: string; line: number }[] {
  const out: { spec: string; line: number }[] = [];
  const add = (lit: ts.Node | undefined) => {
    if (lit && ts.isStringLiteralLike(lit)) out.push({ spec: lit.text, line: lineOf(lit) });
  };
  walk(sf, (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) add(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
  });
  return out;
}

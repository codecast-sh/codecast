/**
 * The layer rule of the shared evals package. Layers in order: contract,
 * analysis, query, client, react. A layer imports only itself and the layers
 * above it. `contract` has zero dependencies. `analysis`, `query` and
 * `client` are pure: no node, bun, React, commander or DOM, through any file
 * they reach. `react` reaches nothing node-side. The checks follow imports
 * transitively, so a pure layer cannot borrow node through a shared module
 * such as `model.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import ts from 'typescript';
import { SRC, isProductSource, moduleSpecifiers, parse, readTree, walk, lineOf } from './guardKit';
import pkg from '../package.json';

const LAYERS = ['contract', 'analysis', 'query', 'client', 'react'] as const;
type Layer = (typeof LAYERS)[number];

const PURE: readonly Layer[] = ['contract', 'analysis', 'query', 'client'];
const NODE = new Set(builtinModules);
const isNodeSide = (spec: string) =>
  spec.startsWith('node:') || spec === 'bun' || spec.startsWith('bun:') || NODE.has(spec) || NODE.has(spec.split('/')[0]) || spec === 'commander';
const isReact = (spec: string) => /^(react|react-dom|lucide-react)(\/|$)/.test(spec);

/** Globals that only exist in a browser or only on the server; a free reference to one breaks isomorphism. */
const DOM_GLOBALS = new Set([
  'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'indexedDB',
  'HTMLElement', 'Element', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'matchMedia',
  'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'DOMParser', 'customElements',
]);
const NODE_GLOBALS = new Set(['process', 'Buffer', 'Bun', '__dirname', '__filename', 'global']);

const layerOf = (path: string): Layer | null => (LAYERS as readonly string[]).includes(path.split('/')[0]) ? (path.split('/')[0] as Layer) : null;
const rank = (layer: Layer) => LAYERS.indexOf(layer);

function bareProblem(layer: Layer, spec: string): string | null {
  if (layer === 'contract') return `imports ${spec}; contract has zero dependencies`;
  if (PURE.includes(layer) && (isNodeSide(spec) || isReact(spec))) return `imports ${spec}; ${layer} is pure (no node, bun, React or commander)`;
  if (layer === 'react' && isNodeSide(spec)) return `imports ${spec}; react reaches nothing node-side`;
  return null;
}

/** Names a file declares itself, so a local `history` or `location` is not mistaken for the global. */
function declaredNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  walk(sf, (node) => {
    const name = (node as { name?: ts.Node }).name;
    if (name && ts.isIdentifier(name) && (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) || ts.isBindingElement(node) || ts.isImportSpecifier(node) || ts.isImportClause(node) ||
      ts.isNamespaceImport(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node))) {
      names.add(name.text);
    }
  });
  return names;
}

/** Is this identifier a name in a property or member position rather than a reference? */
function isMemberName(id: ts.Identifier): boolean {
  const p = id.parent;
  return (ts.isPropertyAccessExpression(p) && p.name === id) || (ts.isQualifiedName(p) && p.right === id) ||
    ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p) || ts.isJsxAttribute(p)) && p.name === id) ||
    ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isBindingElement(p)) && p.propertyName === id) ||
    ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p);
}

function globalProblems(layer: Layer, sf: ts.SourceFile): string[] {
  const banned = PURE.includes(layer) ? new Set([...DOM_GLOBALS, ...NODE_GLOBALS]) : NODE_GLOBALS;
  const local = declaredNames(sf);
  const out: string[] = [];
  walk(sf, (node) => {
    if (!ts.isIdentifier(node) || !banned.has(node.text)) return;
    const p = node.parent;
    const viaGlobalThis = ts.isPropertyAccessExpression(p) && p.name === node && ts.isIdentifier(p.expression) && p.expression.text === 'globalThis';
    if (viaGlobalThis || (!isMemberName(node) && !local.has(node.text))) {
      out.push(`line ${lineOf(node)} uses the global ${node.text}; ${layer} ${PURE.includes(layer) ? 'is pure (no DOM or node globals)' : 'reaches nothing node-side'}`);
    }
  });
  return out;
}

/**
 * Check every product source in a layer against the rule. `files` maps a
 * src-relative path to its text; `exportsMap` resolves self imports by
 * package name (`@platform/evals/<subpath>`).
 */
function layerProblems(files: Map<string, string>, exportsMap: Record<string, string>): string[] {
  const parsed = new Map<string, ts.SourceFile>();
  const sourceOf = (path: string) => {
    if (!parsed.has(path)) parsed.set(path, parse(path, files.get(path)!));
    return parsed.get(path)!;
  };
  const resolve = (from: string, spec: string): string | null | undefined => {
    let base: string;
    if (spec === '@platform/evals' || spec.startsWith('@platform/evals/')) {
      const target = exportsMap['.' + spec.slice('@platform/evals'.length)];
      if (!target) return null;
      base = posix.normalize(target.replace(/^\.\/src\//, ''));
    } else if (spec.startsWith('.')) {
      base = posix.join(posix.dirname(from), spec);
    } else return undefined; // a bare package
    const candidates = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
    return candidates.find((c) => files.has(c)) ?? null;
  };

  // A file's global scan depends only on the layer it is judged for, so each is scanned once per layer, however many starts reach it.
  const scanned = new Map<string, string[]>();
  const globalsOf = (layer: Layer, path: string) => {
    const k = `${layer}\0${path}`;
    if (!scanned.has(k)) scanned.set(k, globalProblems(layer, sourceOf(path)));
    return scanned.get(k)!;
  };
  const imports = new Map<string, ReturnType<typeof moduleSpecifiers>>();
  const importsOf = (path: string) => imports.get(path) ?? imports.set(path, moduleSpecifiers(sourceOf(path))).get(path)!;

  const problems = new Set<string>();
  for (const start of files.keys()) {
    const layer = layerOf(start);
    if (!layer || !isProductSource(start)) continue;
    const via = new Map<string, string | null>([[start, null]]);
    const queue = [start];
    const chain = (path: string) => {
      const steps: string[] = [];
      for (let at: string | null = path; at; at = via.get(at) ?? null) steps.unshift(at);
      return steps.join(' -> ');
    };
    while (queue.length) {
      const at = queue.shift()!;
      for (const g of globalsOf(layer, at)) problems.add(`${chain(at)}: ${g}`);
      for (const { spec, line } of importsOf(at)) {
        const where = `${chain(at)}:${line}`;
        if (spec.endsWith('.css')) continue; // CSS imports are react/guards.test.ts's rule
        const target = resolve(at, spec);
        if (target === undefined) {
          const bad = bareProblem(layer, spec);
          if (bad) problems.add(`${where}: ${bad}`);
          continue;
        }
        if (target === null) {
          problems.add(`${where}: cannot resolve ${spec} inside src`);
          continue;
        }
        const from = layerOf(at);
        const to = layerOf(target);
        if (layer === 'contract' && to !== 'contract') problems.add(`${where}: imports ${target}; contract imports nothing outside itself`);
        if (from && to && rank(to) > rank(from)) problems.add(`${where}: imports ${target}; ${from} may import only itself and the layers above it`);
        if (!via.has(target)) {
          via.set(target, at);
          queue.push(target);
        }
      }
    }
  }
  return [...problems].sort();
}

const tree = () => readTree(SRC);

describe('layers', () => {
  it('every layer has its barrel and its package export', () => {
    const files = tree();
    for (const layer of LAYERS) {
      expect(files.has(`${layer}/index.ts`)).toBe(true);
      expect((pkg.exports as Record<string, string>)[`./${layer}`]).toBe(`./src/${layer}/index.ts`);
    }
  });

  // Parses every product source once: about a second on an idle machine, several under load, so it gets more than the default 5 s.
  it('the package keeps the layer rule', () => {
    expect(layerProblems(tree(), pkg.exports)).toEqual([]);
  }, 30_000);

  describe('the checker catches each kind of break', () => {
    const exportsMap = { '.': './src/index.ts', './react': './src/react/index.ts', './query': './src/query/index.ts' };
    const check = (extra: Record<string, string>) =>
      layerProblems(new Map(Object.entries({ 'index.ts': 'export {};', 'model.ts': 'export type M = 1;', ...extra })), exportsMap);

    it('a layer importing a layer below it', () => {
      expect(check({ 'analysis/index.ts': "export * from '../query';", 'query/index.ts': 'export {};' }))
        .toEqual(['analysis/index.ts:1: imports query/index.ts; analysis may import only itself and the layers above it']);
    });
    it('the same through the package name', () => {
      expect(check({ 'client/a.ts': "import { x } from '@platform/evals/react';", 'react/index.ts': 'export const x = 1;' }))
        .toEqual(['client/a.ts:1: imports react/index.ts; client may import only itself and the layers above it']);
    });
    it('contract reaching outside itself, even for a type', () => {
      expect(check({ 'contract/a.ts': "import type { M } from '../model';\nimport type { Z } from 'zod';" })).toEqual([
        'contract/a.ts:1: imports model.ts; contract imports nothing outside itself',
        'contract/a.ts:2: imports zod; contract has zero dependencies',
      ]);
    });
    it('a pure layer importing node, bun, React or commander', () => {
      expect(check({ 'query/a.ts': "import { readFileSync } from 'fs';\nimport { useState } from 'react';\nconst c = require('commander');\nimport('bun:sqlite');" })).toEqual([
        'query/a.ts:1: imports fs; query is pure (no node, bun, React or commander)',
        'query/a.ts:2: imports react; query is pure (no node, bun, React or commander)',
        'query/a.ts:3: imports commander; query is pure (no node, bun, React or commander)',
        'query/a.ts:4: imports bun:sqlite; query is pure (no node, bun, React or commander)',
      ]);
    });
    it('a pure layer borrowing node through a shared module', () => {
      expect(check({ 'analysis/a.ts': "import type { S } from '../story';", 'story.ts': "import { join } from 'node:path';\nexport type S = 1;" }))
        .toEqual(['analysis/a.ts -> story.ts:1: imports node:path; analysis is pure (no node, bun, React or commander)']);
    });
    it('DOM and node globals in a pure layer, but not locals or members of the same name', () => {
      expect(check({
        'client/a.ts': [
          'export const w = window.innerWidth;',
          'export const t = globalThis.document;',
          'export function f(history: string[], o: { location: string }) { return history.length + o.location.length; }',
          'export const e = process.env.X;',
          'export const el: HTMLElement | null = null;',
        ].join('\n'),
      })).toEqual([
        'client/a.ts: line 1 uses the global window; client is pure (no DOM or node globals)',
        'client/a.ts: line 2 uses the global document; client is pure (no DOM or node globals)',
        'client/a.ts: line 4 uses the global process; client is pure (no DOM or node globals)',
        'client/a.ts: line 5 uses the global HTMLElement; client is pure (no DOM or node globals)',
      ]);
    });
    it('react may use React and the DOM, never node', () => {
      expect(check({ 'react/a.tsx': "import { useState } from 'react';\nimport { readFile } from 'node:fs/promises';\nexport const w = () => window.innerWidth + Number(process.env.N);" })).toEqual([
        'react/a.tsx: line 3 uses the global process; react reaches nothing node-side',
        'react/a.tsx:2: imports node:fs/promises; react reaches nothing node-side',
      ]);
    });
    it('the layers above, the package root types and allowed packages pass', () => {
      expect(check({
        'contract/index.ts': "export * from './core';",
        'contract/core.ts': 'export type Row = { id: string };',
        'analysis/index.ts': "import type { Row } from '../contract';\nimport type { M } from '../model';\nimport { fmt } from '@platform/cli-kit/format';",
        'react/index.tsx': "'use client';\nimport { createElement } from 'react';\nimport { x } from '@platform/evals/query';",
        'query/index.ts': 'export const x = 1;',
        'analysis/verdict.test.ts': "import { test } from 'bun:test';",
      })).toEqual([]);
    });
  });
});

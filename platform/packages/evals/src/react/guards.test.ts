/**
 * Guards on the shared views, which render inside hosts with different
 * styling and React versions (codecast and union on 19, eaiden on 18):
 * - every class name is an `ev-*` rule (no Tailwind or host utilities);
 * - no React-19-only API, so the `react >=18` peer stays true;
 * - components import no CSS: a host imports `styles.css` and `tokens.css` once;
 * - views and CSS read only `--ev-*` tokens, and nothing declares `--sol-*`
 *   (only `tokens.css` reads a host's `--sol-*` and `--font-*`);
 * - the barrel is a client boundary for server-rendering hosts.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import ts from 'typescript';
import { SRC, isProductSource, lineOf, moduleSpecifiers, parse, readTree, walk } from '../guardKit';

const REACT_19_ONLY = new Set(['use', 'useActionState', 'useOptimistic', 'useFormStatus']);
const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

/** The literal class text inside a className value, skipping strings that are compared or used as keys rather than rendered. */
function classTokens(value: ts.Node): { token: string; line: number }[] {
  const out: { token: string; line: number }[] = [];
  // A token cut by a substitution (`ev-chip--${tone}`) is judged by its literal prefix; the text right after one continues it.
  const add = (text: string, node: ts.Node, continuesSubstitution: boolean) => {
    const tokens = text.split(/\s+/);
    tokens.forEach((token, i) => {
      if (!token || (i === 0 && continuesSubstitution && !/^\s/.test(text))) return;
      out.push({ token, line: lineOf(node) });
    });
  };
  walk(value, (node) => {
    const p = node.parent;
    const skipped = (ts.isBinaryExpression(p) && EQUALITY.has(p.operatorToken.kind)) || (ts.isElementAccessExpression(p) && p.argumentExpression === node) || ts.isCaseClause(p);
    if (skipped) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node.text, node, false);
    else if (ts.isTemplateHead(node)) add(node.text, node, false);
    else if (ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node.text, node, true);
  });
  return out;
}

function viewProblems(path: string, text: string): string[] {
  const sf = parse(path, text);
  const out: string[] = [];
  const at = (node: ts.Node) => `${path}:${lineOf(node)}`;
  const reactNamespaces = new Set(['React']);

  for (const { spec, line } of moduleSpecifiers(sf)) {
    if (spec.endsWith('.css')) out.push(`${path}:${line}: imports ${spec}; a host imports styles.css once, components import no CSS`);
  }

  walk(sf, (node) => {
    // Class names.
    const classValue =
      (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && ['className', 'class'].includes(node.name.text) && node.initializer) ||
      (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === 'className' && node.initializer);
    if (classValue) {
      for (const { token, line } of classTokens(classValue)) {
        if (!token.startsWith('ev-')) out.push(`${path}:${line}: class "${token}" is not an ev-* rule`);
      }
    }

    // React-19-only APIs.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /^react(-dom)?$/.test(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) reactNamespaces.add(bindings.name.text);
      if (node.importClause?.name) reactNamespaces.add(node.importClause.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const name = (el.propertyName ?? el.name).text;
          if (REACT_19_ONLY.has(name)) out.push(`${at(el)}: ${name} is React 19 only; the peer is react >=18`);
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && reactNamespaces.has(node.expression.text) && REACT_19_ONLY.has(node.name.text)) {
      out.push(`${at(node)}: ${node.expression.text}.${node.name.text} is React 19 only; the peer is react >=18`);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'use') {
      out.push(`${at(node)}: use() is React 19 only; the peer is react >=18`);
    }
    if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name)) {
      for (const el of node.name.elements) {
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key) && key.text === 'ref') out.push(`${at(el)}: ref read as a plain prop is React 19 only; use forwardRef`);
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'ref' && ts.isIdentifier(node.expression) && node.expression.text === 'props') {
      out.push(`${at(node)}: props.ref is React 19 only; use forwardRef`);
    }

    // Tokens in inline styles and class-building strings.
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const name of node.text.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (!name[1].startsWith('--ev-')) out.push(`${at(node)}: reads ${name[1]}; views read only --ev-* tokens`);
      }
    }
  });
  return out;
}

function cssProblems(path: string, text: string): string[] {
  const out: string[] = [];
  const isTokens = path.endsWith('/tokens.css');
  text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).split('\n').forEach((line, i) => {
    const where = `${path}:${i + 1}`;
    for (const m of line.matchAll(/(^|[\s;{])(--[\w-]+)\s*:/g)) {
      if (!m[2].startsWith('--ev-')) out.push(`${where}: declares ${m[2]}; only --ev-* tokens are declared`);
    }
    if (!isTokens) {
      for (const m of line.matchAll(/var\(\s*(--[\w-]+)/g)) {
        if (!m[1].startsWith('--ev-')) out.push(`${where}: reads ${m[1]}; only tokens.css reads host variables`);
      }
    }
  });
  return out;
}

const REACT = join(SRC, 'react');

describe('react guards', () => {
  it('the shared views keep every guard', () => {
    const views = [...readTree(REACT)].filter(([path]) => isProductSource(path));
    expect(views.flatMap(([path, text]) => viewProblems(path, text))).toEqual([]);
    expect([...readTree(REACT, /\.css$/)].flatMap(([path, text]) => cssProblems(path, text))).toEqual([]);
  });

  it('the barrel is a client boundary', () => {
    const barrel = readTree(REACT).get('react/index.ts')!;
    expect(parse('react/index.ts', barrel).statements[0]?.getText()).toBe("'use client';");
  });

  describe('the guards catch each kind of break', () => {
    it('class names that are not ev-* rules, wherever the literal sits', () => {
      expect(viewProblems('react/a.tsx', [
        'export const A = ({ tone, on }: { tone: string; on: boolean }) => (',
        '  <div className="ev-run flex gap-2">',
        '    <span className={on ? "ev-on" : "text-sm"} />',
        '    <span className={`ev-chip ev-chip--${tone} ${tone}-x mt-1`} />',
        '    <span className={tone === "pass" ? "ev-pass" : "ev-fail"} />',
        '    <span className={{ a: "ev-a" }[tone]} />',
        '  </div>',
        ');',
        'export const props = { className: "p-2 ev-pad" };',
      ].join('\n'))).toEqual([
        'react/a.tsx:2: class "flex" is not an ev-* rule',
        'react/a.tsx:2: class "gap-2" is not an ev-* rule',
        'react/a.tsx:3: class "text-sm" is not an ev-* rule',
        'react/a.tsx:4: class "mt-1" is not an ev-* rule',
        'react/a.tsx:9: class "p-2" is not an ev-* rule',
      ]);
    });

    it('React 19 only APIs, however they are reached', () => {
      expect(viewProblems('react/b.tsx', [
        "import React, { use, useOptimistic as opt, forwardRef } from 'react';",
        "import * as R from 'react';",
        "import { useFormStatus } from 'react-dom';",
        'export const A = ({ ref, label }: { ref?: unknown; label: string }) => <i>{label}</i>;',
        'export const B = (props: { ref?: unknown }) => <i ref={props.ref as never} />;',
        'export const C = () => { const s = R.useActionState; const v = React.use; return use(null as never); };',
        'export const D = forwardRef<HTMLDivElement, { x: number }>((props, ref) => <div ref={ref} />);',
      ].join('\n'))).toEqual([
        'react/b.tsx:1: use is React 19 only; the peer is react >=18',
        'react/b.tsx:1: useOptimistic is React 19 only; the peer is react >=18',
        'react/b.tsx:3: useFormStatus is React 19 only; the peer is react >=18',
        'react/b.tsx:4: ref read as a plain prop is React 19 only; use forwardRef',
        'react/b.tsx:5: props.ref is React 19 only; use forwardRef',
        'react/b.tsx:6: R.useActionState is React 19 only; the peer is react >=18',
        'react/b.tsx:6: React.use is React 19 only; the peer is react >=18',
        'react/b.tsx:6: use() is React 19 only; the peer is react >=18',
      ]);
    });

    it('a component importing CSS, or reading a host variable', () => {
      expect(viewProblems('react/c.tsx', [
        "import './run.css';",
        "export const A = () => <div className=\"ev-a\" style={{ color: 'var(--sol-red)', background: 'var(--ev-bg)' }} />;",
      ].join('\n'))).toEqual([
        'react/c.tsx:1: imports ./run.css; a host imports styles.css once, components import no CSS',
        'react/c.tsx:2: reads --sol-red; views read only --ev-* tokens',
      ]);
    });

    it('CSS reading host variables outside tokens.css, or declaring them anywhere', () => {
      expect(cssProblems('react/run/run.css', '.ev-run { color: var(--ev-text); border: 1px solid var(--sol-border); --sol-text: red; }\n/* var(--sol-x) in a comment */'))
        .toEqual([
          'react/run/run.css:1: declares --sol-text; only --ev-* tokens are declared',
          'react/run/run.css:1: reads --sol-border; only tokens.css reads host variables',
        ]);
      expect(cssProblems('react/tokens.css', ':where(.ev-area) {\n  --ev-text: var(--sol-text, #657b83);\n  --ev-font-ui: var(--font-ui, system-ui);\n}')).toEqual([]);
    });
  });
});

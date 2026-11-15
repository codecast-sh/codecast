import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { walkSources, WEB_ROOT } from "./sourceWalk";

// A screen is an app, not a document (CLAUDE.md, UI conventions): each
// element's words fit a glance. The Line pages kept explaining themselves in
// paragraphs while that rule sat in the docs (ct-59105), so this reads the copy
// the source renders, not the docs. A run of copy is the text one element
// shows: its JSX text, string children and inline children (<b>, <KeyCap>,
// <code>...) joined across lines, with each other expression standing in as a
// short word. A run may hold one sentence of at most 90 characters.

const ROOTS = [join(WEB_ROOT, "components", "line"), join(WEB_ROOT, "app", "line")];
const MAX = 90;
const INLINE = new Set(["b", "i", "em", "strong", "code", "a", "kbd", "KeyCap", "abbr", "small", "u", "s"]);
const PLACEHOLDER = "x";

function tagName(el: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const tag = ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName;
  return tag.getText();
}

function literalText(e: ts.Expression): string | null {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => PLACEHOLDER + s.literal.text).join("");
  if (ts.isParenthesizedExpression(e)) return literalText(e.expression);
  return null;
}

function runOf(children: ts.NodeArray<ts.JsxChild>): string {
  let out = "";
  for (const c of children) {
    if (ts.isJsxText(c)) out += c.text;
    else if (ts.isJsxExpression(c)) {
      if (!c.expression) continue;
      out += literalText(c.expression) ?? PLACEHOLDER;
    } else if (ts.isJsxElement(c) && INLINE.has(tagName(c))) out += runOf(c.children);
    else if (ts.isJsxSelfClosingElement(c) && INLINE.has(tagName(c))) out += PLACEHOLDER;
    else if (ts.isJsxFragment(c)) out += runOf(c.children);
    else out += "\n\n";
  }
  return out;
}

function tooLong(run: string): boolean {
  const pieces = run.split("\n\n").map((p) => p.replace(/\s+/g, " ").trim());
  return pieces.some((p) => p.length > MAX || /[.!?]\s+\S/.test(p));
}

function offendersIn(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rel = file.slice(WEB_ROOT.length + 1);
  const found: Array<{ text: string; line: number }> = [];
  const add = (node: ts.Node, run: string) => {
    if (!tooLong(run)) return;
    found.push({ text: run.replace(/\s+/g, " ").trim(), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) add(node, runOf(node.children));
    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      const branches = ts.isConditionalExpression(node.expression)
        ? [node.expression.whenTrue, node.expression.whenFalse]
        : ts.isBinaryExpression(node.expression) ? [node.expression.right] : [node.expression];
      for (const b of branches) {
        const lit = literalText(b);
        if (lit !== null) add(b, lit);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...new Set(found
    .filter((f) => !found.some((g) => g !== f && g.text.length > f.text.length && g.text.includes(f.text)))
    .map((f) => `${rel}:${f.line}: ${f.text}`))];
}

describe("line screen copy", () => {
  test("no run of copy on the Line pages is longer than one sentence of 90 characters", () => {
    const files = ROOTS.flatMap((r) => walkSources(r)).filter((f) => f.endsWith(".tsx"));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap(offendersIn);
    expect(offenders).toEqual([]);
  });

  test("the guard reads a paragraph split across lines and inline elements", () => {
    const sample = [
      "export const P = () => <p>",
      "  This flow has nothing yet. Add a source below, such as <b>Sentry</b>,",
      "  and it reports on its own.",
      "</p>;",
    ].join("\n");
    const sf = ts.createSourceFile("s.tsx", sample, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let run = "";
    const visit = (n: ts.Node) => {
      if (ts.isJsxElement(n) && !run) run = runOf(n.children);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(tooLong(run)).toBe(true);
    expect(tooLong("Run it")).toBe(false);
  });
});

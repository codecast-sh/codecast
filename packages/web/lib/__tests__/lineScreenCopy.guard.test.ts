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
// short word (`#`). A run may hold one sentence of at most 90 characters.

const ROOTS = [join(WEB_ROOT, "components", "line"), join(WEB_ROOT, "app", "line")];
const MAX = 90;
const INLINE = new Set(["b", "i", "em", "strong", "code", "a", "kbd", "KeyCap", "abbr", "small", "u", "s"]);
const PLACEHOLDER = "#";
/** A second sentence: words, an end mark, then words again (a bare value on either side is not a sentence). */
const TWO_SENTENCES = /[A-Za-z]{2}[.!?]\s+(#\s*)*[A-Za-z]{2}/;

function tagName(el: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const tag = ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName;
  return tag.getText();
}

// The copy an expression renders, when it is copy: literals, templates (each interpolation read the same way), `+`
// joins, the longer branch of a choice, the right of `&&`/`??`/`||`, and fragments or inline elements. Null when it
// holds no copy at all, so a bare value stands in as one short word.
function textOf(e: ts.Expression): string | null {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => (textOf(s.expression) ?? PLACEHOLDER) + s.literal.text).join("");
  if (ts.isParenthesizedExpression(e)) return textOf(e.expression);
  if (ts.isConditionalExpression(e)) {
    const [a, b] = [textOf(e.whenTrue), textOf(e.whenFalse)];
    return a === null ? b : b === null ? a : a.length >= b.length ? a : b;
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) {
      const [l, r] = [textOf(e.left), textOf(e.right)];
      return l === null && r === null ? null : (l ?? PLACEHOLDER) + (r ?? PLACEHOLDER);
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) return textOf(e.right);
  }
  if (ts.isJsxFragment(e)) return runOf(e.children);
  if (ts.isJsxElement(e) && INLINE.has(tagName(e))) return runOf(e.children);
  return null;
}

// A span inside a sentence (a number styled as `lw-num`) is part of that sentence; a span among other elements is a
// block of its own.
function runOf(children: ts.NodeArray<ts.JsxChild>): string {
  const prose = children.some((c) => ts.isJsxText(c) && c.text.trim() !== "");
  const inline = (el: ts.JsxElement | ts.JsxSelfClosingElement) => INLINE.has(tagName(el)) || (prose && tagName(el) === "span");
  let out = "";
  for (const c of children) {
    if (ts.isJsxText(c)) out += c.text;
    else if (ts.isJsxExpression(c)) {
      if (!c.expression) continue;
      const e = c.expression;
      // `{state === "x" && <>...</>}` blocks are alternatives, each its own piece.
      const block = ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && (ts.isJsxFragment(e.right) || ts.isJsxElement(e.right));
      out += block ? `\n\n${textOf(e) ?? ""}\n\n` : textOf(e) ?? PLACEHOLDER;
    } else if (ts.isJsxElement(c) && inline(c)) out += runOf(c.children);
    else if (ts.isJsxSelfClosingElement(c) && inline(c)) out += PLACEHOLDER;
    else if (ts.isJsxFragment(c)) out += runOf(c.children);
    else out += "\n\n";
  }
  return out;
}

function tooLong(run: string): boolean {
  const pieces = run.split("\n\n").map((p) => p.replace(/\s+/g, " ").trim());
  return pieces.some((p) => p.length > MAX || TWO_SENTENCES.test(p));
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
      const text = textOf(node.expression);
      if (text !== null) add(node.expression, text);
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

  test("the guard reads sentences behind styled numbers and inside template interpolations", () => {
    const sample = [
      "export const A = () => <p><span className=\"lw-num\">{n}</span> runs stalled. <span className=\"lw-num\">{m}</span> never started.</p>;",
      "export const B = () => <div>{`${n} differ.${m ? \" Click one to edit it.\" : \"\"}`}</div>;",
    ].join("\n");
    const sf = ts.createSourceFile("s.tsx", sample, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const runs: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isJsxElement(n)) runs.push(runOf(n.children));
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(runs.filter(tooLong)).toHaveLength(2);
  });
});

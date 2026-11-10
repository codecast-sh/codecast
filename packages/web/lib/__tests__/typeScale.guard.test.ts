import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// TYPE SCALE GUARD.
//
// Text in the app is sized from one scale (tailwind.config.ts fontSize, mirrored
// as --fs-* in app/globals.css): text-mark 11, text-meta 12, text-ui 13,
// text-body 14, text-read 15, text-title 18, text-display 24. 12px is the floor
// for words; 11px (text-mark, var(--fs-mark)) is for glyph-like marks only: a
// count in a small badge, a key cap legend, an avatar initial, a label set in
// capitals. Most screens once rendered 60-75% of their text under 12px, because
// every component picked its own size.
//
// So a source file may not set an arbitrary Tailwind size under 12px
// (`text-[10px]`: use text-meta, or text-mark for a mark), and a stylesheet may
// not set a literal font size under 11px (use var(--fs-meta) or var(--fs-mark)).
// Only string literals and template parts are read, never comments or JSX text.
// Minimal's own scale (--t-*, guarded by minimalStyle.guard) keeps 11px.

const ROOT = join(import.meta.dir, "..", "..");
const DIRS = ["app", "components", "hooks", "lib", "tours", "src"];
const SUB12_CLASS = /(?<![\w-])text-\[(\d+(?:\.\d+)?)px\]/g;

function walk(ext: RegExp): string[] {
  const out: string[] = [];
  for (const dir of DIRS) {
    for (const f of readdirSync(join(ROOT, dir), { recursive: true }) as string[]) {
      const rel = join(dir, f);
      if (!ext.test(rel) || rel.endsWith(".d.ts") || rel.includes("node_modules")) continue;
      if (/\.test\.|\.spec\.|(^|\/)__tests__\/|(^|\/)__snapshots__\//.test(rel)) continue;
      out.push(rel);
    }
  }
  return out;
}

/** Every string literal and template part in a source file, with its line. */
function strings(rel: string, src: string): Array<{ text: string; line: number }> {
  const kind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, kind);
  const out: Array<{ text: string; line: number }> = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      out.push({ text: n.text, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** px of a literal CSS length, or null for anything else (em, %, var(), calc()). */
function literalPx(value: string): number | null {
  const m = /^(\d*\.?\d+)(px|rem)$/.exec(value.trim());
  return m ? Number(m[1]) * (m[2] === "rem" ? 16 : 1) : null;
}

describe("type scale", () => {
  test("no source sets an arbitrary text size under 12px", () => {
    const off: string[] = [];
    for (const rel of walk(/\.tsx?$/)) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      if (!src.includes("text-[")) continue;
      for (const s of strings(rel, src)) {
        for (const m of s.text.matchAll(SUB12_CLASS)) {
          if (Number(m[1]) < 12) off.push(`${rel}:${s.line} ${m[0]}`);
        }
      }
    }
    expect(off.slice(0, 40)).toEqual([]);
  });

  test("no stylesheet sets a literal font size under 11px", () => {
    const off: string[] = [];
    for (const rel of walk(/\.css$/)) {
      const css = readFileSync(join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
      const lineAt = (i: number) => css.slice(0, i).split("\n").length;
      for (const m of css.matchAll(/(?<![\w-])font-size\s*:\s*([^;}]+?)\s*(?:!important\s*)?[;}]/g)) {
        const px = literalPx(m[1]!);
        if (px !== null && px < 11) off.push(`${rel}:${lineAt(m.index!)} font-size: ${m[1]}`);
      }
      // The size in a `font:` shorthand: the first length before the family.
      for (const m of css.matchAll(/(?<![\w-])font\s*:\s*([^;}]+)[;}]/g)) {
        const size = /(?:^|\s)(\d*\.?\d+(?:px|rem))(?=\/|\s)/.exec(m[1]!)?.[1];
        const px = size ? literalPx(size) : null;
        if (px !== null && px < 11) off.push(`${rel}:${lineAt(m.index!)} font: ${m[1]!.trim()}`);
      }
    }
    expect(off.slice(0, 40)).toEqual([]);
  });
});

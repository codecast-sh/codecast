// A file reads the same in a transcript's code block (Prism, colored by the
// `.token.*` rules in globals.css) and in the editor (Lezer, colored by
// theme.ts). Each fixture is tokenized both ways and every visible character
// is resolved to the color it paints in; any difference fails, naming the
// characters. The Prism side reads the real stylesheet, so a change to either
// side's colors is caught here.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-json";
import "prismjs/components/prism-css";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-python";
import { highlightTree } from "@lezer/highlight";
import type { LanguageSupport } from "@codemirror/language";
import { CODE_HIGHLIGHT_STYLES, CODE_HIGHLIGHTERS, SYNTAX } from "../theme";
import { describeLanguage, loadLanguage } from "../languages";

// ── Prism: token classes to colors, as the stylesheet resolves them ─────────

const css = readFileSync(join(import.meta.dir, "../../../app/globals.css"), "utf8");
const base = /code\[class\*="language-"\],\s*pre\[class\*="language-"\]\s*\{[^}]*?color:\s*([^;]+);/.exec(css)![1].trim();

/** `.token.x` rules with a color, in stylesheet order (a later rule wins). */
const tokenRules: { classes: string[]; color: string }[] = [];
for (const m of css.matchAll(/((?:\.token\.[\w-]+\s*,?\s*)+)\{([^}]*)\}/g)) {
  const color = /(?:^|;|\s)color:\s*([^;]+);/.exec(m[2])?.[1].trim();
  if (!color) continue;
  for (const sel of m[1].split(",")) tokenRules.push({ classes: [sel.trim().replace(/^\.token\./, "")], color });
}

function prismColor(classes: readonly string[]): string | null {
  let color: string | null = null;
  for (const r of tokenRules) if (r.classes.every((c) => classes.includes(c))) color = r.color;
  return color;
}

function prismColors(code: string, lang: string): string[] {
  const out: string[] = [];
  const walk = (tokens: (string | Prism.Token)[], inherited: string) => {
    for (const tok of tokens) {
      if (typeof tok === "string") {
        for (let i = 0; i < tok.length; i++) out.push(inherited);
        continue;
      }
      const aliases = tok.alias ? (Array.isArray(tok.alias) ? tok.alias : [tok.alias]) : [];
      const color = prismColor([tok.type, ...aliases]) ?? inherited;
      const content = tok.content;
      if (typeof content === "string") for (let i = 0; i < content.length; i++) out.push(color);
      else walk(Array.isArray(content) ? content : [content], color);
    }
  };
  walk(Prism.tokenize(code, Prism.languages[lang]!), base);
  return out;
}

// ── Lezer: the editor's highlighters, class to the color its rule paints ────

/** Each class a highlighter emits has one rule in its style's module; the
 *  color comes from there, so the test sees what the editor paints. */
async function lezerColors(code: string, file: string): Promise<string[]> {
  const support = (await loadLanguage(describeLanguage(file))) as LanguageSupport;
  const out: string[] = Array.from({ length: code.length }, () => SYNTAX.plain);
  highlightTree(support.language.parser.parse(code), CODE_HIGHLIGHTERS, (from, to, classes) => {
    const color = colorOfClasses(classes);
    if (color) for (let i = from; i < to; i++) out[i] = color;
  });
  return out;
}

/** The color a span's classes paint: the last of its classes' rules that
 *  sets one (each style's rules are written in spec order). */
function colorOfClasses(classes: string): string | null {
  let color: string | null = null;
  for (const cls of classes.split(" ")) {
    const c = ruleColors().get(cls);
    if (c) color = c;
  }
  return color;
}

let rules: Map<string, string> | null = null;
/** Each style's module holds its rules as text: `.ͼx {color: ...}`. */
function ruleColors(): Map<string, string> {
  if (rules) return rules;
  rules = new Map();
  for (const style of CODE_HIGHLIGHT_STYLES) {
    for (const m of style.module!.getRules().matchAll(/\.([^\s{]+)\s*\{([^}]*)\}/g)) {
      const color = /color:\s*([^;]+)/.exec(m[2]!)?.[1]!.trim();
      if (color) rules.set(m[1]!, color);
    }
  }
  return rules;
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** Text (every occurrence) whose color the two sides are not expected to
 *  share, with why. Each is a place Prism guesses from a pattern where the
 *  editor's parser knows the construct, or the reverse; nothing a tag could
 *  tell apart is waived. */
type Waiver = { text: string; why: string };

const FIXTURES: { name: string; file: string; prism: string; code: string; waive?: Waiver[] }[] = [
  {
    name: "TypeScript",
    file: "a.ts",
    prism: "typescript",
    code: [
      `import { join } from "node:path";`,
      `// a comment`,
      `export interface Row { id: string; count: number }`,
      `const limit = 42, on = true, none = null;`,
      `export function total(rows: Row[]): number {`,
      `  const seen = { first: 1, "second": 2 };`,
      `  return rows.reduce((n, r) => n + r.count, 0) * limit;`,
      `}`,
      `class Box extends Base { constructor() { super(); this.x = /a+b/g; } }`,
      `const s = \`tpl \${limit}\`;`,
    ].join("\n"),
    waive: [
      { text: "string", why: "a primitive type is Prism's `builtin`; the parser's TypeName does not say which types are primitive" },
      { text: "number", why: "the same" },
      { text: "Row[]", why: "Prism colors a type only after `class`/`interface`/`extends`; the parser marks every type reference" },
      { text: "Row {", why: "the same, at its declaration" },
      { text: "Base", why: "Prism takes the name after `extends` for a class; the parser reads it as the variable it is" },
      { text: `"second"`, why: "a quoted key is a string to the parser and a property to Prism's pattern" },
      { text: "constructor", why: "Prism calls any `name(` a function; to the parser a method name is a property definition, like a key" },
      { text: "${limit}", why: "Prism's TypeScript leaves a template's interpolation inside the string; the parser colors the expression" },
    ],
  },
  {
    name: "JavaScript",
    file: "a.js",
    prism: "javascript",
    code: [`// keys are properties in JavaScript`, `const row = { id: 1, on: false, none: null };`, `export const f = (a, ...rest) => a ? rest : [];`].join("\n"),
    waive: [{ text: "f =", why: "Prism calls a name assigned an arrow a function, by pattern; the parser reads a variable definition" }],
  },
  {
    name: "JSON",
    file: "a.json",
    prism: "json",
    code: `{\n  "name": "codecast",\n  "count": 3,\n  "on": true,\n  "none": null,\n  "list": [1, "two"]\n}`,
    waive: [{ text: ":", why: "Prism's JSON calls `:` an operator; the parser tags it with `,` as one separator" }],
  },
  {
    name: "CSS",
    file: "a.css",
    prism: "css",
    code: [
      `/* a comment */`,
      `.card > a:hover, #main {`,
      `  color: #fff;`,
      `  margin: 0 4px;`,
      `}`,
      `@media (max-width: 600px) { body { padding: 0; } }`,
    ].join("\n"),
    waive: [
      { text: ".card > a:hover, #main", why: "Prism paints a whole selector, punctuation included, as one token; the parser tags its marks as punctuation" },
      { text: "0", why: "Prism's CSS has no numbers; the parser colors them as everywhere else" },
      { text: "4px", why: "the same" },
      { text: "600px", why: "the same, inside an at-rule Prism paints as one" },
    ],
  },
  {
    name: "YAML",
    file: "a.yaml",
    prism: "yaml",
    code: `# a comment\nname: codecast\ncount: 3\non: true\nlist:\n  - one\n  - "two"\n`,
    waive: [
      { text: "3", why: "the YAML parser does not type a plain scalar (number, boolean): every one is content" },
      { text: "true", why: "the same" },
    ],
  },
  {
    name: "Markdown",
    file: "a.md",
    prism: "markdown",
    code: `# Title\n\nSome **bold** and _italic_ words.\n\n- item\n`,
  },
  {
    name: "Python",
    file: "a.py",
    prism: "python",
    code: [`# a comment`, `def total(rows):`, `    return sum(r.count for r in rows) + 42`, `name = "codecast"`].join("\n"),
    waive: [
      { text: ":", why: "the Python parser gives `:` no tag" },
      { text: "sum", why: "Prism knows Python's builtins by name; to the parser `sum` is a call like any other" },
    ],
  },
];

function mismatches(code: string, a: string[], b: string[], waive: Waiver[] = []): string[] {
  const waived = new Set<number>();
  for (const w of waive) {
    let at = code.indexOf(w.text);
    if (at < 0) throw new Error(`waiver text not in fixture: ${w.text}`);
    for (; at >= 0; at = code.indexOf(w.text, at + 1)) for (let i = at; i < at + w.text.length; i++) waived.add(i);
  }
  const out: string[] = [];
  let run: { from: number; to: number; prism: string; editor: string } | null = null;
  const flush = () => {
    if (run) out.push(`${JSON.stringify(code.slice(run.from, run.to))}: prism ${run.prism}, editor ${run.editor}`);
    run = null;
  };
  for (let i = 0; i < code.length; i++) {
    if (/\s/.test(code[i]!) || waived.has(i) || a[i] === b[i]) {
      flush();
      continue;
    }
    if (run && run.to === i && run.prism === a[i] && run.editor === b[i]) run.to++;
    else {
      flush();
      run = { from: i, to: i + 1, prism: a[i]!, editor: b[i]! };
    }
  }
  flush();
  return out;
}

describe("syntax colors in the editor match the transcript's code blocks", () => {
  it("reads the Prism rules from the stylesheet", () => {
    expect(base).toBe(SYNTAX.plain);
    expect(prismColor(["keyword"])).toBe(SYNTAX.keyword);
    expect(prismColor(["comment"])).toBe(SYNTAX.comment);
  });

  for (const f of FIXTURES) {
    it(f.name, async () => {
      const prism = prismColors(f.code, f.prism);
      const editor = await lezerColors(f.code, f.file);
      expect(prism.length).toBe(f.code.length);
      expect(mismatches(f.code, prism, editor, f.waive)).toEqual([]);
    });
  }
});

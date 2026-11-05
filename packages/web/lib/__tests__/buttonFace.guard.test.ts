import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// Every filled press on the site is a <Button variant=…> (components/ui/button.tsx),
// which draws the raised face in button.css: toned fill, top light, hairline,
// soft shadow, a press that sinks. A <button>, <a> or <Link> that paints its own
// solid accent fill comes out flat beside it, and a <Button> given a bg- class
// keeps the shadow but loses the toning. This fails both, so the fix is always
// to pick a variant (add a tone in button.tsx and button.css if none fits).
//
// A fill that only marks state inside a ternary (a selected segment, an active
// chip) is not a button face and is not read: only the classes a tag always has
// count, plus constants it interpolates.

const ROOT = join(import.meta.dir, "..", "..");
const DIRS = ["app", "components", "hooks", "lib"];

// Drawn surfaces that are buttons but not faces.
const ALLOWED = new Set([
  // The numbered pin dropped on an image under review: a map marker, not a press.
  "components/ImageGallery.tsx",
]);

const ACCENT = "(?:sol-(?:yellow|blue|cyan|green|red|violet|magenta|orange|amber)|(?:amber|emerald|green|red|blue|violet|orange|yellow|sky|indigo)-[4-9]00|primary|destructive)";
// Solid, or a wash of half strength or more.
const FILL = new RegExp(`(?<![\\w:\\[-])bg-${ACCENT}(?:/(?:[5-9]\\d|100))?(?![\\w/-])`);

function files(dir: string): string[] {
  return (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
    .filter((f) => f.endsWith(".tsx") && !f.includes(".test.") && !f.includes("node_modules"))
    .map((f) => join(dir, f))
    .filter((f) => !f.startsWith("components/ui/"));
}

/** Module-level string constants: NAME -> value. */
function constants(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]*) = (["`])([^"`]*)\2;?$/gm)) out.set(m[1], m[3]);
  return out;
}

/** The end of a JSX opening tag starting at i, skipping braces and strings. */
function tagEnd(src: string, i: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i;
  }
  return src.length;
}

/** The className={…} or className="…" value inside an opening tag, raw. */
function classAttr(tag: string): string | null {
  const m = /\bclassName=/.exec(tag);
  if (!m) return null;
  const start = m.index + m[0].length;
  if (tag[start] === '"') return tag.slice(start, tag.indexOf('"', start + 1) + 1);
  if (tag[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < tag.length; i++) {
    if (tag[i] === "{") depth++;
    else if (tag[i] === "}" && --depth === 0) return tag.slice(start, i + 1);
  }
  return null;
}

/** The classes a className always applies: literals outside any condition, and the constants it names. */
function alwaysClasses(value: string, consts: Map<string, string>): string {
  if (value.startsWith('"')) return value.slice(1, -1);
  const expr = value.slice(1, -1).trim();
  const resolve = (part: string) => {
    const p = part.trim();
    const lit = /^(["'`])([\s\S]*)\1$/.exec(p);
    if (lit && !lit[2].includes(lit[1])) {
      return lit[2].replace(/\$\{\s*([A-Z][A-Z0-9_]*)\s*\}/g, (_, n) => consts.get(n) ?? "").replace(/\$\{[^}]*\}/g, "");
    }
    return consts.get(p) ?? "";
  };
  const call = /^(?:cn|clsx|twMerge)\(([\s\S]*)\)$/.exec(expr);
  if (!call) return resolve(expr);
  // Top-level arguments only: a ternary or && argument is a condition.
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const c of call[1]) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) {
      args.push(cur);
      cur = "";
    } else cur += c;
  }
  args.push(cur);
  return args.filter((a) => !/\?|&&|\|\|/.test(a.replace(/(["'`])(?:(?!\1).)*\1/g, ""))).map(resolve).join(" ");
}

describe("button faces", () => {
  test("filled presses use a <Button> variant, never a hand-painted fill", () => {
    const offenders: string[] = [];
    for (const file of DIRS.flatMap(files)) {
      if (ALLOWED.has(file)) continue;
      const src = readFileSync(join(ROOT, file), "utf8");
      const consts = constants(src);
      for (const m of src.matchAll(/<(button|a|Link|Button)\b/g)) {
        const tag = src.slice(m.index!, tagEnd(src, m.index! + m[0].length) + 1);
        const value = classAttr(tag);
        if (!value) continue;
        const fill = FILL.exec(alwaysClasses(value, consts));
        if (fill) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${relative(ROOT, join(ROOT, file))}:${line} <${m[1]}> ${fill[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the guard reads what a tag always applies", () => {
    const c = new Map([["FACE", "bg-sol-blue text-sol-bg"]]);
    expect(FILL.test(alwaysClasses('"rounded bg-amber-500 px-2"', c))).toBe(true);
    expect(FILL.test(alwaysClasses("{`${FACE} px-2`}", c))).toBe(true);
    expect(FILL.test(alwaysClasses('{cn("h-7", "bg-sol-green")}', c))).toBe(true);
    expect(FILL.test(alwaysClasses('{cn("h-7", on ? "bg-sol-cyan" : "")}', c))).toBe(false);
    expect(FILL.test(alwaysClasses('{`px-2 ${on ? "bg-sol-cyan" : ""}`}', c))).toBe(false);
    expect(FILL.test(alwaysClasses('"bg-sol-green/10 text-sol-green"', c))).toBe(false);
    expect(FILL.test(alwaysClasses('"hover:bg-sol-red"', c))).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ONE MARKETING NAV.
//
// Every marketing page renders components/marketing/MarketingNav. Before it
// existed, ten pages each hand-rolled a bar with its own subset of links, and
// none of them knew the visitor was signed in. A page that grows its own
// "Sign in" link again has forked the bar; the fix is to render MarketingNav
// (or BlogNav, which wraps it) and pass `active`.

const ROOT = join(import.meta.dir, "..", "..");
const MARKETING = join(ROOT, "app", "(marketing)");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

describe("marketing nav", () => {
  test("no marketing page hand-rolls a sign-in link", () => {
    const offenders = walk(MARKETING)
      .filter((f) => /href=["']\/login["']/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  test("every top-level marketing page renders the shared nav", () => {
    const pages = readdirSync(MARKETING)
      .map((name) => join(MARKETING, name, "page.tsx"))
      .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } })
      .concat(join(MARKETING, "page.tsx"));
    const missing = pages
      .filter((f) => !/<(MarketingNav|BlogNav)\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(missing).toEqual([]);
  });
});

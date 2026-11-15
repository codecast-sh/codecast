import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// In expo-router 6, router.navigate to a tab from a screen stacked over the
// tabs (a conversation, its slide-out panel) PUSHES a second tabs screen and
// leaves the conversation mounted under it. Every exit stacked one more, with
// every subscription in it live, so the store's listener count grew by ~430 a
// round trip and opening a conversation slowed down with each one. Leaving
// for a tab is router.dismissTo, which pops back to the tabs that are there.
//
// A file may navigate to a tab only if it is drawn inside the tabs, where the
// tabs are already on top and navigate switches them in place.
const INSIDE_TABS = new Set(["components/nav/Places.tsx"]);

const root = `${import.meta.dir}/..`;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (statSync(join(root, path)).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("leaving for a tab", () => {
  test("only code drawn inside the tabs navigates to a tab", () => {
    const offenders: string[] = [];
    for (const path of ["app", "components", "lib", "hooks"].flatMap(sources)) {
      if (INSIDE_TABS.has(path)) continue;
      const text = readFileSync(join(root, path), "utf8");
      if (/\.navigate\(\s*[`'"]\/\(tabs\)/.test(text)) offenders.push(relative(root, join(root, path)));
    }
    expect(offenders).toEqual([]);
  });

  test("the conversation's panel and its area bar leave with dismissTo", () => {
    for (const path of ["components/inbox/ConversationSlideOut.tsx", "components/nav/AreaBar.tsx"]) {
      expect(readFileSync(join(root, path), "utf8")).toContain("router.dismissTo(");
    }
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Every tab address reaches the router through goToTab (lib/tabNavigation),
// which knows whether the app is over the tabs or inside them. A direct
// push, navigate or replace from a screen stacked over the tabs adds a SECOND
// tabs screen and leaves what was open mounted under it; a direct dismissTo
// from inside the tabs does nothing. Both were in the app at once.
//
// Not covered, because no call here makes it: a link that arrives from
// outside the app (app/+native-intent.tsx hands expo-router an address and
// the router navigates itself).

const root = `${import.meta.dir}/..`;
const HELPER = "lib/tabNavigation.ts";
/** Tables of addresses with no router of their own. */
const ADDRESS_TABLES = new Set(["lib/linkRoutes.ts"]);

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

const files = ["app", "components", "lib", "hooks"].flatMap(sources).map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));

/** A router call of any spelling: router.push(, to.navigate(, router?.replace(. */
const ROUTER_CALL = /\.\s*(?:push|navigate|replace|dismissTo)\s*\(/;
/** One handed a tab's address as a string or template, on the same line. */
const DIRECT_TAB_CALL = /\.\s*(?:push|navigate|replace|dismissTo)\s*\(\s*[`'"]\/\(tabs\)/;
/** A tab's address written as a string anywhere in a file. */
const TAB_LITERAL = /[`'"]\/\(tabs\)[/?`'"]/;
/** What mobileRouteForUrl returns can be a tab's address (lib/linkRoutes PAGE_ROUTES). */
const RESOLVES_LINKS = /\bmobileRouteForUrl\s*\(/;
const USES_HELPER = /\b(?:goToTab|openAppRoute)\s*\(/;

describe("going to a tab", () => {
  test("no router call is handed a tab's address", () => {
    const offenders = files.filter((f) => f.path !== HELPER && DIRECT_TAB_CALL.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test("a file that holds a tab's address and calls the router goes through goToTab", () => {
    // A route kept in a table or a variable (components/nav/Places) is not on
    // the line of the call, so the file is held to the rule as a whole.
    const offenders = files
      .filter((f) => f.path !== HELPER && !ADDRESS_TABLES.has(f.path))
      .filter((f) => TAB_LITERAL.test(f.text) && ROUTER_CALL.test(f.text) && !USES_HELPER.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test("a file that resolves a link to a route opens it with openAppRoute", () => {
    const offenders = files
      .filter((f) => !ADDRESS_TABLES.has(f.path) && f.path !== "app/+native-intent.tsx")
      .filter((f) => RESOLVES_LINKS.test(f.text) && ROUTER_CALL.test(f.text) && !/\bopenAppRoute\s*\(/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test("the address tables hold addresses and call no router", () => {
    for (const path of ADDRESS_TABLES) {
      const text = files.find((f) => f.path === path)?.text ?? "";
      expect(text).not.toBe("");
      expect(/\brouter\b/.test(text)).toBe(false);
    }
  });

  test("the root layout tells the helper where the app is", () => {
    expect(readFileSync(join(root, "app/_layout.tsx"), "utf8")).toContain("noteRouteSegments(useSegments())");
  });

  test("the guard sees each spelling it bans", () => {
    for (const bad of [
      "router.push('/(tabs)/chat' as never)",
      "router.replace(`/(tabs)/tasks?assignee=${x}`)",
      'router.navigate("/(tabs)/inbox")',
      "router.dismissTo('/(tabs)/inbox' as never)",
      "router?.push(\n  '/(tabs)/notifications')",
    ]) expect(DIRECT_TAB_CALL.test(bad)).toBe(true);
    expect(DIRECT_TAB_CALL.test("goToTab(router, '/(tabs)/chat')")).toBe(false);
    expect(DIRECT_TAB_CALL.test("router.push('/session/x')")).toBe(false);
    expect(TAB_LITERAL.test("route: '/(tabs)/tasks?segment=plans'")).toBe(true);
  });
});

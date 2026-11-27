import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ALIASES, WEB, rel, walk } from "../../test-helpers/importGraph";

// The standalone boots (src/shareBoot.tsx: the share pages and a guest's
// /meet page) exist so that a stranger's page carries nothing of the app: no
// store, no call manager. The store boots persistence the moment it loads
// (IndexedDB, the signed-in member's cached inbox), so a share or guest page
// that reaches it hydrates somebody's inbox into a page anybody can open.
//
// The way in is rarely a direct import. `next/navigation` is an alias
// (tsconfig paths, vite.shared.ts) for src/compat/next-navigation.ts, which
// imports the store for its tab routing: one innocent `useParams` pulled the
// whole store directory into the guest page. So this walks the graph the way
// the bundler does, aliases included, and fails on any path into the app.
// Static imports only: an `import()` is a chunk boundary that loads when it
// runs, which is how a module the guest never exercises (the error reporter
// behind notificationDelivery, say) stays out of what the page loads.

const FORBIDDEN = [/^store\//, /^lib\/calls\/callManager\.ts$/, /^src\/compat\/next-navigation\.ts$/];

function leaks(entry: string): string[] {
  const out: string[] = [];
  for (const [file, chain] of walk(join(WEB, entry))) {
    if (FORBIDDEN.some((re) => re.test(rel(file)))) out.push(chain.join(" -> "));
  }
  return out;
}

describe("standalone boots stay out of the app", () => {
  test("a guest's /meet page reaches neither the store nor the call manager", () => {
    expect(leaks("app/meet/[token]/page.tsx")).toEqual([]);
  });

  // Not yet: the doc and message share pages render markdown through
  // components/tools/MarkdownRenderer, whose ObjectReveal imports the store,
  // and HtmlSnippet uses the next/navigation shim. Cutting those is its own
  // change; this turns on when it lands.
  test.todo("the share boot (every share page, and /meet behind it) does not either", () => {
    expect(leaks("src/shareBoot.tsx")).toEqual([]);
  });

  test("the walker follows aliases (a self check: the shim itself is a leak)", () => {
    expect(walk(join(WEB, ALIASES["next/navigation"])).size).toBeGreaterThan(5);
    expect(leaks(ALIASES["next/navigation"]).length).toBeGreaterThan(0);
  });
});

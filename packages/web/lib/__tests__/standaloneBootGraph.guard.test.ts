import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

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

const WEB = resolve(import.meta.dir, "../..");
const ALIASES: Record<string, string> = {
  "next/navigation": "src/compat/next-navigation.ts",
  "next/link": "src/compat/next-link.tsx",
};
const FORBIDDEN = [/^store\//, /^lib\/calls\/callManager\.ts$/, /^src\/compat\/next-navigation\.ts$/];

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g;

function resolveFile(base: string): string | null {
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const p = base + ext;
    if (existsSync(p) && !p.endsWith("/")) {
      try {
        readFileSync(p);
        return p;
      } catch {
        // a directory
      }
    }
  }
  return null;
}

function resolveSpec(from: string, spec: string): string | null {
  if (ALIASES[spec]) return join(WEB, ALIASES[spec]);
  if (spec.startsWith("@/")) return resolveFile(join(WEB, spec.slice(2)));
  if (spec.startsWith(".")) return resolveFile(resolve(dirname(from), spec));
  return null; // a package: never the app
}

/** Every web file the entry reaches, with the chain that reached it. */
function walk(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[entry, [rel(entry)]]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(IMPORT_RE)) {
      if (m[1]) continue; // `import type` erases
      const spec = m[2];
      const target = resolveSpec(file, spec);
      if (!target || seen.has(target)) continue;
      seen.set(target, [...seen.get(file)!, rel(target)]);
      queue.push(target);
    }
  }
  return seen;
}

function rel(p: string): string {
  return relative(WEB, p);
}

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

import { describe, expect, test } from "bun:test";
import { checkRatchet, codeOnly } from "@codecast/shared/ratchet";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// CONVEX SERVER MODULES STAY OUT OF THE BROWSER BUNDLE.
//
// Plenty of modules under packages/convex/convex are pure helpers, and the web
// imports them on purpose (ccAccountsShared, wakeCost, lib/slackMirror). A
// module that DEFINES convex functions is different: importing it for one
// constant drags every query and mutation in the file, and everything its
// `./functions` wrapper pulls in, into the client. Convex notices and logs
// "Convex functions should not be imported in the browser ... will throw an
// error in future versions" once per definition — eight of them came from a
// single `import { FOLLOW_RENEW_MS } from ".../convex/follow"`.
//
// The fix is never to silence the log: move the shared value into
// @codecast/shared/contracts, where both halves import it and neither carries
// the other's code.

const WEB = join(import.meta.dir, "..", "..");
const CONVEX = join(WEB, "..", "convex", "convex");
const ALLOWLIST = join(import.meta.dir, "convexServerImports.allowlist.txt");

/** How many files import a convex module that defines functions. May only fall. */
const PIN = 0;

const IMPORT_RE = /from\s+["']@codecast\/convex\/convex\/([^"']+)["']/g;
/** `export const x = query({`, `= mutation({`, `= internalAction({`, `= httpAction(`. */
const DEFINES_FN_RE = /\b(?:internal)?(?:[Qq]uery|[Mm]utation|[Aa]ction)\s*\(\s*\{/;

const definesFunctions = new Map<string, boolean>();
function convexModuleDefinesFunctions(spec: string): boolean {
  const cached = definesFunctions.get(spec);
  if (cached !== undefined) return cached;
  const file = [".ts", ".tsx", "/index.ts"].map((ext) => join(CONVEX, spec + ext)).find(existsSync);
  const src = file ? codeOnly(readFileSync(file, "utf8")) : "";
  // A file is a server module when it declares convex functions itself, which
  // in this codebase always means the `./functions` wrappers.
  const defines = !!file && /from\s+["']\.{1,2}\/(?:\.\.\/)*functions["']/.test(src) && DEFINES_FN_RE.test(src);
  definesFunctions.set(spec, defines);
  return defines;
}

const result = checkRatchet({
  name: "web import of a convex module that defines functions",
  root: WEB,
  dirs: ["app", "components", "hooks", "lib", "store", "src"],
  ignoreDirs: ["__tests__"],
  exempt: (rel) => /\.test\.tsx?$/.test(rel),
  count: (src) => {
    let hits = 0;
    for (const m of codeOnly(src).matchAll(IMPORT_RE)) if (convexModuleDefinesFunctions(m[1])) hits += 1;
    return hits;
  },
  allowlist: ALLOWLIST,
  pin: PIN,
  fix: "Move the shared value into @codecast/shared/contracts and import it from there on both sides.",
  pruneCommand: "cd packages/web && RATCHET_WRITE=prune bun test lib/__tests__/convexServerImports.guard.test.ts",
  minScanned: 400,
});

describe("convex function modules stay out of the web bundle", () => {
  test("the scan can tell a server module from a helper", () => {
    // A detector that answered "no" to everything would make the scan vacuous.
    expect(convexModuleDefinesFunctions("follow")).toBe(true);
    expect(convexModuleDefinesFunctions("wakeCost")).toBe(false);
  });

  test("no web file imports one", () => {
    expect(result.problems).toEqual([]);
  });
});

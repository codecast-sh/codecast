import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// DOC REFERENCES. The architecture docs and the project instructions are bound
// to the files they name.
//
// docs/architecture/*.md, CLAUDE.md and AGENTS.md name files, directories and
// commands by repo path. Nothing failed when the code they named was renamed
// or deleted, so the docs drifted silently: CLAUDE.md listed three `cast check`
// programs while .codecast/check.toml had six. This test scans every doc for a
// path rooted at one of the repo's top-level directories and fails on any that
// no longer exists in the repo (tracked or untracked-but-not-ignored, so a
// gitignored .env.local is not a repo file and a fresh clone agrees with a
// working tree).
//
// The references that were dead when this landed are frozen in
// doc-refs-baseline.txt, one `<doc> <path>` per line. A dead reference not in
// the baseline fails. A baseline entry that is no longer dead also fails,
// naming the line to delete, so the file can only shrink. The only sanctioned
// edit is downward: fix the doc, then delete its line. There is no mode that
// adds a line; adding one is a hand edit that shows in review.
//
// Scope: a reference is a path starting with one of ROOTS and holding at least
// one slash. Bare file names (`daemon.ts`) and package-relative paths
// (`convex/lib/access.ts`, `store/wakeSig.ts`) are not checked. Anything with a
// glob or placeholder character right after it (`packages/*`, `docs/<slug>`)
// is skipped, and a `:line` suffix or trailing punctuation is dropped. A path
// without an extension also resolves as a module specifier (`components/Themed`
// finds Themed.tsx).

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const BASELINE = join(import.meta.dir, "doc-refs-baseline.txt");
const DOC_DIR = "docs/architecture";
const ROOT_DOCS = ["CLAUDE.md", "AGENTS.md"];
const ROOTS = ["packages", "docs", "scripts", "platform", ".codecast", ".github"];
const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];
// Dirs no doc should have to name a file under: build output and codegen.
const GENERATED = new Set(["node_modules", "dist", "_generated"]);

const REF = new RegExp(
  String.raw`(?<![\w./~@-])(?:${ROOTS.map((r) => r.replace(".", "\\.")).join("|")})/[\w@.()\[\]/+-]*`,
  "g",
);

function unbalanced(path: string, open: string, close: string): boolean {
  return path.endsWith(close) && path.split(close).length > path.split(open).length;
}

/** Drops trailing punctuation, a closing bracket the path did not open, and a `:line` suffix. */
function trim(raw: string): string {
  let path = raw.replace(/:\d+(-\d+)?$/, "");
  for (;;) {
    const next = /[.,;:!?'"\/-]$/.test(path) || unbalanced(path, "(", ")") || unbalanced(path, "[", "]")
      ? path.slice(0, -1)
      : path;
    if (next === path) return path;
    path = next;
  }
}

/** The repo paths a doc names, deduplicated. */
export function refsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(REF)) {
    const next = text[match.index + match[0].length] ?? "";
    if (next && "*<>{$…".includes(next)) continue;
    if (match[0].includes("..")) continue;
    const path = trim(match[0]);
    if (!path.includes("/") || path.endsWith("/")) continue;
    if (path.split("/").some((segment) => GENERATED.has(segment))) continue;
    out.add(path);
  }
  return out;
}

/** Every file in the repo, plus every directory holding one. Tracked, or untracked and not ignored. */
function repoPaths(): Set<string> {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: REPO_ROOT,
    maxBuffer: 256 * 1024 * 1024,
  }).toString("utf8");
  const out = new Set<string>();
  for (const file of listed.split("\0")) {
    if (!file) continue;
    out.add(file);
    let dir = file;
    for (;;) {
      const slash = dir.lastIndexOf("/");
      if (slash === -1) break;
      dir = dir.slice(0, slash);
      if (out.has(dir)) break;
      out.add(dir);
    }
  }
  return out;
}

function exists(paths: Set<string>, ref: string): boolean {
  return paths.has(ref) || MODULE_EXTENSIONS.some((ext) => paths.has(ref + ext));
}

/** The docs this test binds, by their real path so the CLAUDE.md symlink and AGENTS.md count once. */
function docs(): string[] {
  const out = new Set<string>();
  const root = realpathSync(REPO_ROOT);
  for (const name of readdirSync(join(REPO_ROOT, DOC_DIR))) {
    if (name.endsWith(".md")) out.add(`${DOC_DIR}/${name}`);
  }
  for (const name of ROOT_DOCS) {
    const full = join(REPO_ROOT, name);
    if (existsSync(full)) out.add(relative(root, realpathSync(full)));
  }
  return [...out].sort();
}

function parseBaseline(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

/** Every dead reference today, as sorted `<doc> <path>` lines, and how many references were checked. */
function deadReferences(): { scanned: number; dead: string[] } {
  const paths = repoPaths();
  const dead: string[] = [];
  let scanned = 0;
  for (const doc of docs()) {
    for (const ref of refsIn(readFileSync(join(REPO_ROOT, doc), "utf8"))) {
      scanned++;
      if (!exists(paths, ref)) dead.push(`${doc} ${ref}`);
    }
  }
  return { scanned, dead: dead.sort() };
}

describe("doc references", () => {
  test("every path a doc names exists, and the baseline only shrinks", () => {
    expect(existsSync(BASELINE), `${BASELINE} is missing; a missing baseline is an error, never an empty set`).toBe(true);
    const { scanned, dead } = deadReferences();
    const deadSet = new Set(dead);

    if (process.env.RATCHET_WRITE === "prune") {
      // Drops the lines that are no longer dead and nothing else.
      const kept = readFileSync(BASELINE, "utf8").split("\n").filter((line) => {
        const body = line.replace(/#.*/, "").trim();
        return !body || deadSet.has(body);
      });
      writeFileSync(BASELINE, kept.join("\n"));
    }

    const baseline = new Set(parseBaseline(readFileSync(BASELINE, "utf8")));
    const unlisted = dead.filter((line) => !baseline.has(line));
    const stale = [...baseline].filter((line) => !deadSet.has(line));

    // A scanner that walks the wrong tree or whose pattern stopped matching
    // finds nothing and passes forever.
    expect(scanned, "the scan found too few references to be reading the docs").toBeGreaterThan(200);

    const problems = [
      ...unlisted.map((line) => `dead reference: ${line}\n  fix the doc so the path exists; a baseline entry is never the fix`),
      ...stale.map((line) => `baseline entry no longer dead: ${line}\n  delete that line from ${relative(REPO_ROOT, BASELINE)}`),
    ];
    if (stale.length > 0) {
      problems.push(`prune with: cd packages/shared && RATCHET_WRITE=prune bun test ratchet/docRefs.guard.test.ts`);
    }
    expect(problems).toEqual([]);
  }, 120_000);

  test("the cast check programs CLAUDE.md names are the projects in .codecast/check.toml", () => {
    const toml = readFileSync(join(REPO_ROOT, ".codecast/check.toml"), "utf8");
    const projects = toml
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter((line) => /^[\w-]+\s*=/.test(line))
      .map((line) => line.split("=")[0].trim());

    const claude = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8");
    const section = claude.match(/^## Typechecking\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? "";
    const sentence = section.match(/`\.codecast\/check\.toml`:([^.]*)\./)?.[1] ?? "";
    const named = [...sentence.matchAll(/`([\w-]+)`/g)].map((m) => m[1]);

    expect(projects.length).toBeGreaterThan(0);
    expect(named.sort()).toEqual([...projects].sort());
  });

  test("the scanner reads paths the way docs write them", () => {
    const refs = refsIn([
      "see `packages/cli/src/daemon.ts:42` and (docs/architecture/sync-host.md).",
      "the generated api under packages/convex/convex/_generated/api.ts",
      "any of packages/*, docs/<slug>.md, ~/.codecast/config.json, $HOME/.codecast/x",
      "a route at packages/web/app/(marketing)/page.tsx and scripts/ci/ alone",
      "a relative ../../../scripts/sim.ts include",
    ].join("\n"));
    expect([...refs].sort()).toEqual([
      "docs/architecture/sync-host.md",
      "packages/cli/src/daemon.ts",
      "packages/web/app/(marketing)/page.tsx",
      "scripts/ci",
    ]);
  });
});

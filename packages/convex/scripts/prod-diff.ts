// WHAT A PUSH WOULD CHANGE IN PROD, computed without pushing.
//
// A Convex push replaces the whole backend: every function, HTTP route, table
// and index prod has that this tree lacks is gone after it. On 2026-11-21 a
// push from main dropped the indexes of tables an earlier uncommitted push had
// added. This script names both directions before a push:
//   adds:  what this tree would put into prod
//   drops: what prod would lose
//
// Names are flat strings, the same on both sides:
//   fn:<module>:<export>      module = path under convex/ without extension
//   http:<METHOD> <path>      prefix routes end in `*` (`/api/ingest/*`), as
//                             Convex's own router and prod's apiSpec spell them
//   index:<table>.<index>     database, search and vector indexes, staged or not
//   table:<table>
//
// Usage:
//   bun packages/convex/scripts/prod-diff.ts [--json] [--out <file>]
//     Summary on stderr; with --json, {adds, drops, tree_ms, prod_ms} on
//     stdout; --out writes the same JSON to a file. Exit 0 when the diff ran,
//     drops or not; exit 3 when the tree or prod could not be read (callers
//     fail open), the reason on stderr.
//     Each drop names the recorded push that put it there (`cast ship
//     added-by`), when cast can say.
//   bun packages/convex/scripts/prod-diff.ts --tree-only
//     The tree's names as a JSON array. The main command runs this as a child
//     process, so a long-lived caller (the dev watcher) never holds ~800
//     backend modules in its own module cache.
//
// Prod is read with two read-only system queries and nothing else. The admin
// key comes from CONVEX_SELF_HOSTED_ADMIN_KEY, else from packages/convex/.env.local
// (only that key and CONVEX_SELF_HOSTED_URL are read from it), and is never printed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

export const EXIT_UNREADABLE = 3;
const DEFAULT_URL = "https://convex.codecast.sh";
const PROD_TIMEOUT_MS = 30_000;
const TREE_TIMEOUT_MS = 120_000;
const FUNCTIONS_DIR = join(import.meta.dir, "..", "convex");
const ENV_FILE = join(import.meta.dir, "..", ".env.local");

// ---------------------------------------------------------------- naming

type IndexEntry = { indexDescriptor: string };
export type SchemaJson = {
  tables: Array<{
    tableName: string;
    indexes?: IndexEntry[];
    stagedDbIndexes?: IndexEntry[];
    searchIndexes?: IndexEntry[];
    stagedSearchIndexes?: IndexEntry[];
    vectorIndexes?: IndexEntry[];
    stagedVectorIndexes?: IndexEntry[];
  }>;
};

/** Table and index names from a schema in Convex's export shape: the tree's
 *  `schema.export()` and prod's active schema are the same JSON. */
export function namesFromSchema(schema: SchemaJson): string[] {
  const names: string[] = [];
  for (const t of schema.tables) {
    names.push(`table:${t.tableName}`);
    for (const list of [t.indexes, t.stagedDbIndexes, t.searchIndexes, t.stagedSearchIndexes, t.vectorIndexes, t.stagedVectorIndexes]) {
      for (const ix of list ?? []) names.push(`index:${t.tableName}.${ix.indexDescriptor}`);
    }
  }
  return names;
}

/** Prod's active schema arrives as a JSON string, or null when prod has none. */
export function namesFromActiveSchema(active: string | null | undefined): string[] {
  return active ? namesFromSchema(JSON.parse(active) as SchemaJson) : [];
}

export type ApiSpecEntry = {
  functionType: string;
  identifier?: string | null;
  method?: string;
  path?: string;
};

/** Function and HTTP route names from prod's `_system/cli/modules:apiSpec`.
 *  A function's identifier is `emails/send.js:notifyPasswordChanged`; an HTTP
 *  route has no identifier and carries `method` and `path` instead. */
export function namesFromApiSpec(spec: ApiSpecEntry[]): string[] {
  const names: string[] = [];
  for (const e of spec) {
    if (e.identifier) {
      const colon = e.identifier.indexOf(":");
      const file = e.identifier.slice(0, colon);
      names.push(`fn:${moduleName(file)}:${e.identifier.slice(colon + 1)}`);
    } else if (e.method && e.path) {
      names.push(`http:${e.method} ${e.path}`);
    }
  }
  return names;
}

/** `emails/send.ts` (or prod's `emails/send.js`) → `emails/send`. */
export function moduleName(rel: string): string {
  return rel.split(sep).join("/").replace(/\.[cm]?[jt]sx?$/, "");
}

/** Mirrors the Convex bundler's entry-point rules (convex/dist/esm/bundler
 *  `entryPoints`): a JS/TS file outside `_generated`, not a dotfile or emacs
 *  tempfile, not schema.ts, with at most one dot in its name and no space in
 *  its path. Tests and their kits (`x.test.ts`, `x.testkit.ts`) fall out
 *  through the one-dot rule. */
export function isEntryModule(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? "";
  if (parts[0] === "_generated" || parts.includes("node_modules")) return false;
  if (!/\.(js|mjs|cjs|ts|tsx|mts|cts|jsx)$/.test(base)) return false;
  if (base.startsWith(".") || base.startsWith("#")) return false;
  if (base === "schema.ts" || base === "schema.js") return false;
  if ((base.match(/\./g) ?? []).length > 1) return false;
  return !rel.includes(" ");
}

type RouterLike = { isRouter: true; getRoutes: () => Array<[string, string, unknown]> };

/** Names one loaded module contributes: every exported query, mutation or
 *  action, and for the top-level `http` module its router's routes. */
export function namesFromModule(mod: string, exports: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const [name, value] of Object.entries(exports)) {
    const v = value as { isQuery?: boolean; isMutation?: boolean; isAction?: boolean } | null;
    if (v && (v.isQuery || v.isMutation || v.isAction)) names.push(`fn:${mod}:${name}`);
  }
  const router = exports.default as RouterLike | undefined;
  if (mod === "http" && router?.isRouter) {
    for (const [path, method] of router.getRoutes()) names.push(`http:${method} ${path}`);
  }
  return names;
}

export function diffNames(tree: Iterable<string>, prod: Iterable<string>): { adds: string[]; drops: string[] } {
  const t = new Set(tree);
  const p = new Set(prod);
  return {
    adds: [...t].filter((n) => !p.has(n)).sort(),
    drops: [...p].filter((n) => !t.has(n)).sort(),
  };
}

export const SUMMARY_ADDS_SHOWN = 10;

/** The recorded push that put a name on prod (`cast ship added-by`). */
export type AddedBy = { name: string; deploy: string; by: string | null; machine: string | null; via: string | null; at: number; dirty: number; committed_in?: string };

/** Who put a dropped name there, in words: "dp-2372, uncommitted push by Ashot on MBP, 11/21 9:21 PM". */
export function describeAdder(a: AddedBy | undefined): string {
  if (!a) return "no recorded push added it";
  const how = a.via === "dev watcher" ? "dev watcher" : a.dirty > 0 ? `uncommitted push (${a.dirty} file${a.dirty === 1 ? "" : "s"})` : "push of a commit";
  const who = [a.by, a.machine ? `on ${a.machine}` : null].filter(Boolean).join(" ");
  const since = a.committed_in ? `; committed since (${a.committed_in} carried it)` : "";
  return `${a.deploy}, ${how}${who ? ` by ${who}` : ""}, ${new Date(a.at).toLocaleString()}${since}`;
}

export function formatSummary(diff: { adds: string[]; drops: string[] }, ms?: { tree_ms: number; prod_ms: number }, addedBy?: AddedBy[]): string {
  const { adds, drops } = diff;
  const timing = ms ? ` (tree ${(ms.tree_ms / 1000).toFixed(1)}s, prod ${(ms.prod_ms / 1000).toFixed(1)}s)` : "";
  const lines = [`prod-diff: ${drops.length} drop${drops.length === 1 ? "" : "s"}, ${adds.length} add${adds.length === 1 ? "" : "s"}${timing}`];
  if (drops.length) lines.push(`  This push takes ${drops.length === 1 ? "this" : "these"} off prod${addedBy ? ", with the push that put each there" : ""}:`);
  const by = new Map((addedBy ?? []).map((a) => [a.name, a]));
  for (const d of drops) lines.push(`  DROP ${d}${addedBy ? `  ← ${describeAdder(by.get(d))}` : ""}`);
  if (adds.length) {
    const shown = adds.slice(0, SUMMARY_ADDS_SHOWN).join(", ");
    const more = adds.length > SUMMARY_ADDS_SHOWN ? `, +${adds.length - SUMMARY_ADDS_SHOWN} more` : "";
    lines.push(`  ADD ${adds.length}: ${shown}${more}`);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------- attribution

/** The recorded push that put each dropped name on prod, from `cast ship
 *  added-by`. Undefined when cast is missing, older than that command,
 *  logged out or offline: the summary then lists drops without attribution. */
function addersOf(drops: string[]): AddedBy[] | undefined {
  const dir = mkdtempSync(join(tmpdir(), "prod-diff-"));
  const file = join(dir, "drops.json");
  writeFileSync(file, JSON.stringify({ drops }));
  const r = spawnSync("cast", ["ship", "added-by", "--surface", "backend", "--names", file, "--json"], {
    cwd: join(import.meta.dir, ".."), encoding: "utf-8", timeout: 15_000, env: { ...process.env, CAST_HTTP_TIMEOUT_MS: "10000" },
  });
  rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) return undefined;
  try {
    const found = JSON.parse(r.stdout)?.found;
    return Array.isArray(found) ? found : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- tree side

function listModules(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        // The bundler skips nested component directories.
        if (e.name !== "node_modules" && !existsSync(join(p, "convex.config.ts"))) walk(p);
      } else if (e.isFile()) {
        const rel = relative(dir, p);
        if (isEntryModule(rel)) out.push(rel);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** Loads the schema and every entry module. Throws naming any module that
 *  failed to load: its functions would otherwise read as drops. */
export async function treeNames(dir = FUNCTIONS_DIR): Promise<string[]> {
  const schema = (await import(join(dir, "schema.ts"))).default as { export: () => string };
  const names = namesFromSchema(JSON.parse(schema.export()) as SchemaJson);
  const failed: string[] = [];
  const loaded = await Promise.all(
    listModules(dir).map(async (rel) => {
      try {
        return namesFromModule(moduleName(rel), (await import(join(dir, rel))) as Record<string, unknown>);
      } catch (e) {
        failed.push(`${rel}: ${(e as Error)?.message ?? e}`);
        return [];
      }
    }),
  );
  if (failed.length) throw new Error(`could not load ${failed.length} module(s):\n  ${failed.join("\n  ")}`);
  return names.concat(loaded.flat());
}

async function runTreeChild(): Promise<string[]> {
  const child = Bun.spawn([process.execPath, import.meta.path, "--tree-only"], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), TREE_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  if (code !== 0) {
    // Module-load chatter goes to the child's stderr; show its tail on failure only.
    const tail = err.trim().split("\n").slice(-20).join("\n");
    throw new Error(`tree read failed (exit ${code}${child.signalCode ? `, ${child.signalCode}` : ""}):\n${tail}`);
  }
  return JSON.parse(out) as string[];
}

// ---------------------------------------------------------------- prod side

/** Env first, then only the two named keys from packages/convex/.env.local. */
export function readCredentials(env: Record<string, string | undefined> = process.env, envFile = ENV_FILE): { url: string; key: string | undefined } {
  let url = env.CONVEX_SELF_HOSTED_URL;
  let key = env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  if ((!url || !key) && existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?(CONVEX_SELF_HOSTED_URL|CONVEX_SELF_HOSTED_ADMIN_KEY)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const value = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
      if (m[1] === "CONVEX_SELF_HOSTED_URL") url ||= value;
      else key ||= value;
    }
  }
  return { url: (url || DEFAULT_URL).replace(/\/+$/, ""), key };
}

async function systemQuery(url: string, key: string, path: string): Promise<unknown> {
  const res = await fetch(`${url}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Convex ${key}` },
    body: JSON.stringify({ path, args: {}, format: "json" }),
    signal: AbortSignal.timeout(PROD_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { status?: string; value?: unknown; errorMessage?: string } | null;
  if (!res.ok || body?.status !== "success") {
    throw new Error(`${path}: HTTP ${res.status}${body?.errorMessage ? `: ${body.errorMessage}` : ""}`);
  }
  return body.value;
}

export async function prodNames(url: string, key: string): Promise<string[]> {
  const [schemas, spec] = await Promise.all([
    systemQuery(url, key, "_system/frontend/getSchemas") as Promise<{ active?: string | null }>,
    systemQuery(url, key, "_system/cli/modules:apiSpec") as Promise<ApiSpecEntry[]>,
  ]);
  if (!Array.isArray(spec)) throw new Error("apiSpec did not return an array");
  return namesFromActiveSchema(schemas?.active).concat(namesFromApiSpec(spec));
}

// ---------------------------------------------------------------- main

async function timed<T>(p: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t = performance.now();
  const value = await p();
  return { value, ms: Math.round(performance.now() - t) };
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--tree-only")) {
    // Modules log on load (an analytics warning); keep stdout for the JSON.
    console.log = console.info = console.debug = console.warn = console.error;
    try {
      await Bun.write(Bun.stdout, JSON.stringify(await treeNames()));
      return 0;
    } catch (e) {
      console.error(`prod-diff: ${(e as Error)?.message ?? e}`);
      return EXIT_UNREADABLE;
    }
  }

  const json = argv.includes("--json");
  const outIdx = argv.indexOf("--out");
  const out = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  if (outIdx >= 0 && !out) {
    console.error("usage: prod-diff.ts [--json] [--out <file>] | --tree-only");
    return 2;
  }

  const { url, key } = readCredentials();
  if (!key) {
    console.error("prod-diff: cannot read prod: CONVEX_SELF_HOSTED_ADMIN_KEY is not set (env or packages/convex/.env.local)");
    return EXIT_UNREADABLE;
  }

  const [tree, prod] = await Promise.allSettled([timed(runTreeChild), timed(() => prodNames(url, key))]);
  if (tree.status === "rejected" || prod.status === "rejected") {
    if (tree.status === "rejected") console.error(`prod-diff: cannot read the tree: ${(tree.reason as Error)?.message ?? tree.reason}`);
    if (prod.status === "rejected") console.error(`prod-diff: cannot read prod (${url}): ${(prod.reason as Error)?.message ?? prod.reason}`);
    return EXIT_UNREADABLE;
  }

  const result = { ...diffNames(tree.value.value, prod.value.value), tree_ms: tree.value.ms, prod_ms: prod.value.ms };
  const addedBy = result.drops.length ? addersOf(result.drops) : undefined;
  console.error(formatSummary(result, result, addedBy));
  const text = JSON.stringify(result, null, 2);
  if (out) writeFileSync(out, text + "\n");
  if (json) await Bun.write(Bun.stdout, text + "\n");
  return 0;
}

if (import.meta.main) {
  // Exit explicitly: a loaded backend module can leave a timer holding the loop.
  process.exit(await main(process.argv.slice(2)));
}

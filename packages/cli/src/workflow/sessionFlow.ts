// A flow an agent defines in its session (flows doc s975wwqd, "Putting things
// in a flow"): the graph comes on stdin (`cast flow run -`, `cast flow
// validate -`), written whole or as a library flow it extends with its slots
// filled. It is kept in the checkout at `.codecast/session-flows/` (inside the
// work tree, so a run's push records where it lives and the library collects
// it), hidden from git by the checkout's own exclude file, and marked as the session's draft so the library offers it to nobody until a
// person saves it (convex flowLibrary.save). Every library flow it names by
// slug (`extends=`, `flow=`) is pinned beside it to the file the pool read, so
// the runner, a separate process, parses exactly the graph validated here.
import * as fs from "node:fs";
import * as path from "node:path";
import { withGraphAttrs, flowGraphAttr } from "@codecast/shared/contracts/flowPool";
import { spawnSync } from "../proc.js";
import type { PoolFlow } from "./flowPool.js";

export type SessionFlowFile = { slug: string; file: string; source: string };

/** The name a graph's source gives itself (`digraph <name>`), as a slug. */
export function graphSlug(source: string): string | null {
  const m = source.match(/^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(?:strict\s+)?(?:di)?graph\s+("([^"]+)"|[\w.-]+)/);
  const name = m ? (m[2] ?? m[1]) : null;
  const slug = name?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return slug || null;
}

/** Every flow a source names by slug: its base and its segments. A path (a `/` or `.cast`) is the file's own business. */
export function namedFlows(source: string): string[] {
  const names = new Set<string>();
  const ext = flowGraphAttr(source, "extends");
  if (ext) names.add(ext);
  for (const m of source.matchAll(/\bflow\s*=\s*(?:"([^"]+)"|([\w.-]+))/g)) names.add(m[1] ?? m[2]);
  return [...names].filter((n) => !n.includes("/") && !n.endsWith(".cast"));
}

/**
 * Keep a session's graph as a file the runner can read: `<checkout>/.codecast/session-flows/<slug>/<slug>.cast`,
 * marked `draft="<session>"`, with a one-line stub beside it for each library flow it names that the pool
 * read from a file (a published flow written to this machine, or the repo's), so the slug resolves to that
 * file wherever the runner runs. A shipped flow needs no stub: the parser reads the shipped copy by name.
 */
export function writeSessionFlow(top: string, source: string, session: string | null, pool: ReadonlyArray<Pick<PoolFlow, "slug" | "file">>): SessionFlowFile {
  const slug = graphSlug(source);
  if (!slug) throw new Error("A flow's graph starts with digraph <name> { ... }: name it for what it does");
  const held = pool.find((f) => f.slug === slug);
  if (held) throw new Error(`The library already has a flow named ${slug}: name this one for what it does differently (digraph <name>), and extend ${slug} with graph [extends="${slug}"] if it is built on it`);
  const dir = path.join(top, SESSION_FLOWS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  excludeFromGit(top);
  for (const name of namedFlows(source)) {
    const base = pool.find((f) => f.slug === name);
    if (base?.file) fs.writeFileSync(path.join(dir, `${name}.cast`), `digraph ${JSON.stringify(name)} { graph [extends=${JSON.stringify(base.file)}] }\n`);
  }
  const marked = session && !flowGraphAttr(source, "draft") ? withGraphAttrs(source, { draft: session }) : source;
  const file = path.join(dir, `${slug}.cast`);
  fs.writeFileSync(file, marked);
  return { slug, file, source: marked };
}

export const SESSION_FLOWS_DIR = ".codecast/session-flows";

/** The checkout's own exclude file names the session flows, so they never show as untracked work. */
function excludeFromGit(top: string): void {
  const r = spawnSync("git", ["-C", top, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf-8" });
  const common = r.status === 0 ? String(r.stdout).trim() : "";
  if (!common) return;
  const file = path.join(common, "info", "exclude");
  const line = `/${SESSION_FLOWS_DIR}/`;
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  if (text.split("\n").includes(line)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
}

/** All of stdin, for a graph written in a heredoc. */
export function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

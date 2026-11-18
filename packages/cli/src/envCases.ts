// Env case sets from the CLI (contracts/envCases.ts, convex/envCases.ts).
//
// `putCaseSet` uploads a product runner's dev or held cases in chunks and
// prints only their count and version. `fetchCaseSet` opens a logged fetch
// and reads every page. `withCaseFile` hands a run the set: it writes the
// cases to a file in a private temp directory, names it to the runner
// (CODECAST_ENV_CASES), and removes the directory when the run ends, the
// process exits or it is interrupted; a directory a killed run left behind is
// swept by the next fetch. `heldTreeProblem` keeps a held run on committed,
// reviewed harness code. Nothing here prints a held case; a dev set is
// readable by design (`cast env cases get`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CASES_READ_TTL_MAX_S, caseChunks, caseSetVersion, parseCaseSet, type CaseSetFile, type CaseSetRead, type CaseSetSplit, type EnvCaseSetStanding } from "@codecast/shared/contracts/envCases";
import { ENVS_REL_PATH, type EnvDeclaration } from "@codecast/shared/contracts/envs";
import type { Post } from "./envCommand.js";

const TMP_PREFIX = "cast-cases-";

/**
 * Why this tree may not run the env held, or null. The runner reads every
 * held case, so the tree is committed (no uncommitted or untracked file), and
 * the declaration and the paths it protects (its runner, grader and harness)
 * are the base's. A candidate is a commit that changes anything else; its
 * code still runs inside the held run, so only a sandbox would stop a
 * committed candidate from copying the file.
 */
export function heldTreeProblem(root: string, decl: EnvDeclaration, base: string | null): string | null {
  if (!decl.protects?.length) return `${decl.key} protects no paths, so its runner could be any code: declare protects = [<runner and grader globs>] in ${ENVS_REL_PATH} before running it held`;
  if (!base) return "no base to compare the runner against (no merge base with origin)";
  // Whatever the runner imports runs on every held case, and an uncommitted file is code nobody can see: a held run is a committed tree.
  try {
    // A node_modules symlinked in (withTreeAt links the checkout's into a detached tree) is the install, not a change.
    const linkedInstall = (line: string) => {
      const rel = line.slice(3).replace(/\/$/, "");
      if (!line.startsWith("?? ") || path.basename(rel) !== "node_modules") return false;
      try { return fs.lstatSync(path.join(root, rel)).isSymbolicLink(); } catch { return false; }
    };
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean).filter((l) => !linkedInstall(l));
    if (dirty.length) return `a held run reads every held case, so it runs only a committed tree: ${dirty.slice(0, 5).map((l) => l.slice(3)).join(", ")}${dirty.length > 5 ? ` and ${dirty.length - 5} more` : ""} ${dirty.length === 1 ? "is" : "are"} uncommitted. Commit them (a candidate is a commit), or run --split dev`;
  } catch {
    return "could not read the tree's status";
  }
  const specs = [ENVS_REL_PATH, ...decl.protects].map((g) => `:(glob)${g}`);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    // Ignored files count too: one under a protected path changes the runner while the tree reads as committed.
    const changed = [
      ...git(["diff", "--name-only", base, "--", ...specs]).split("\n"),
      ...git(["ls-files", "--others", "--exclude-standard", "--", ...specs]).split("\n"),
      ...git(["ls-files", "--others", "--ignored", "--exclude-standard", "--", ...specs]).split("\n"),
    ].filter(Boolean);
    if (changed.length) return `a held run reads every held case, so its runner must be the base's: ${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ` and ${changed.length - 5} more` : ""} differ from ${base.slice(0, 8)}. Land them first, or run --split dev`;
  } catch (err) {
    return `could not compare the runner with the base: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
  }
  return null;
}

/** Remove case-set directories a killed run left behind. */
function sweepStale(now = Date.now()) {
  let entries: string[] = [];
  try { entries = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(TMP_PREFIX)); } catch { return; }
  for (const n of entries) {
    const p = path.join(os.tmpdir(), n);
    try { if (now - fs.statSync(p).mtimeMs > CASES_READ_TTL_MAX_S * 1000) fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
}

/** Read a case set's JSON from a file, or stdin for "-". */
export function readCaseSetInput(file: string): string {
  return fs.readFileSync(file === "-" ? 0 : file, "utf8");
}

/** Upload a case set for a split; the server makes it live when its last case lands. */
export async function putCaseSet(post: Post, env: string, split: CaseSetSplit, text: string, extra: { scope?: Record<string, unknown>; goal?: string; session_id?: string | null; task_id?: string; replace?: boolean }): Promise<{ version: string; size: number; workspace: string }> {
  const parsed = parseCaseSet(text);
  if (!parsed.ok) throw new Error(parsed.error);
  const { set } = parsed;
  const version = await caseSetVersion(set);
  const base = {
    ...(extra.goal ? { goal: extra.goal } : extra.scope ?? {}),
    env,
    split,
    version,
    size: set.cases.length,
    ...(set.label ? { label: set.label } : {}),
    ...(set.meta ? { meta: set.meta } : {}),
    ...(extra.session_id ? { session_id: extra.session_id } : {}),
    ...(extra.task_id ? { task_id: extra.task_id } : {}),
    ...(extra.replace ? { replace: true } : {}),
  };
  let id: string | undefined;
  let out: any;
  for (const cases of caseChunks(set.cases)) {
    out = await post("/cli/envs/cases/put", { ...base, ...(id ? { set: id } : {}), cases });
    id = out.set;
  }
  if (!out?.live) throw new Error(`the upload stopped at ${out?.written ?? 0} of ${set.cases.length} cases`);
  return { version, size: set.cases.length, workspace: out.workspace };
}

/** Replace only the live set's meta (`{ meta }` as JSON); the server keeps the cases. */
export async function putCaseSetMeta(post: Post, env: string, split: CaseSetSplit, text: string, extra: { scope?: Record<string, unknown>; goal?: string; session_id?: string | null; task_id?: string }): Promise<{ version: string; size: number; workspace: string }> {
  let x: any;
  try { x = JSON.parse(text); } catch { throw new Error("the meta file is not JSON"); }
  if (!x || typeof x !== "object" || Array.isArray(x) || x.meta === undefined || Object.keys(x).some((k) => k !== "meta" && k !== "label")) throw new Error("the meta file must be { meta, label? }");
  const out = await post("/cli/envs/cases/put", {
    ...(extra.goal ? { goal: extra.goal } : extra.scope ?? {}),
    env,
    split,
    keep_cases: true,
    replace: true,
    meta: JSON.stringify(x.meta),
    ...(typeof x.label === "string" ? { label: x.label } : {}),
    cases: [],
    ...(extra.session_id ? { session_id: extra.session_id } : {}),
    ...(extra.task_id ? { task_id: extra.task_id } : {}),
  });
  return { version: out.version, size: out.size, workspace: out.workspace };
}

/** Open a logged fetch of the env's live set for a split and read every page. */
export async function fetchCaseSet(post: Post, env: string, split: CaseSetSplit, opts: { scope?: Record<string, unknown>; goal?: string; session_id?: string | null; task_id?: string; ttl_s?: number }): Promise<{ file: CaseSetFile; read: string }> {
  const opened = await post("/cli/envs/cases/open", {
    ...(opts.goal ? { goal: opts.goal } : opts.scope ?? {}),
    env,
    split,
    ...(opts.session_id ? { session_id: opts.session_id } : {}),
    ...(opts.task_id ? { task_id: opts.task_id } : {}),
    ...(opts.ttl_s ? { ttl_s: opts.ttl_s } : {}),
  });
  const cases: CaseSetFile["cases"] = [];
  for (let from: number | null = 0; from !== null;) {
    const page: { cases: { id: string; payload: string }[]; next: number | null } = await post("/cli/envs/cases/page", { read: opened.read, from }, true);
    for (const c of page.cases) cases.push({ id: c.id, payload: JSON.parse(c.payload) });
    from = page.next;
  }
  if (cases.length !== opened.size) throw new Error(`the ${split} fetch returned ${cases.length} of ${opened.size} cases`);
  return { read: opened.read, file: { env, split, version: opened.version, ...(opened.label ? { label: opened.label } : {}), ...(opened.meta ? { meta: JSON.parse(opened.meta) } : {}), cases } };
}

/**
 * Fetch the env's live set for a split into a private file, run `fn` with its
 * path, and remove it after. The fetch is logged server side before any case leaves.
 */
export async function withCaseFile<T>(post: Post, env: string, split: CaseSetSplit, opts: { scope?: Record<string, unknown>; goal?: string; session_id?: string | null; task_id?: string; ttl_s?: number }, fn: (file: string, fetch: { version: string; read: string }) => Promise<T>): Promise<T> {
  sweepStale();
  const fetched = await fetchCaseSet(post, env, split, opts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  fs.chmodSync(dir, 0o700);
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  // Exit rather than re-raise: an exit runs the exit listeners, runEnv's among them, which stops the runner's group.
  const onSignal = (sig: NodeJS.Signals) => { cleanup(); process.exit(128 + (os.constants.signals[sig] ?? 1)); };
  process.once("exit", cleanup);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  try {
    const file = path.join(dir, `${split}.json`);
    fs.writeFileSync(file, JSON.stringify(fetched.file), { mode: 0o600 });
    return await fn(file, { version: fetched.file.version, read: fetched.read });
  } finally {
    cleanup();
    process.removeListener("exit", cleanup);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
  }
}

export type CaseSetLog = { dev: EnvCaseSetStanding | null; held: EnvCaseSetStanding | null; reads: CaseSetRead[] };

type Palette = Record<"green" | "yellow" | "red" | "cyan" | "dim" | "bold" | "reset", string>;

/** The case-set lines `cast env show <key>` prints: each split's size, version and last attempt, then the access log. */
export function caseSetLines(p: Palette, log: CaseSetLog, ago: (at: number) => string): string[] {
  const out: string[] = [];
  for (const split of ["dev", "held"] as const) {
    const h = log[split];
    const name = split === "dev" ? "Dev set" : "Held set";
    if (!h) { out.push(`\n  ${p.bold}${name}${p.reset} ${p.dim}none in codecast${p.reset}`); continue; }
    out.push(`\n  ${p.bold}${name}${p.reset} ${h.size} cases ${p.dim}version ${h.version}${h.label ? ` · ${h.label}` : ""} · uploaded ${ago(h.uploaded_at)}${p.reset}`);
    out.push(`  ${p.dim}${h.last_attempt ? `last ${split} ${h.last_attempt.short_id} ${h.last_attempt.mean.toFixed(3)} n=${h.last_attempt.n} ${h.last_attempt.candidate} ${ago(h.last_attempt.finished_at)}` : `no ${split} attempt yet`} · ${h.reads} fetch${h.reads === 1 ? "" : "es"}${h.last_read_at ? `, last ${ago(h.last_read_at)}` : ""}${p.reset}${h.unfiled ? ` ${p.yellow}${h.unfiled} with no attempt filed${p.reset}` : ""}`);
  }
  if (log.reads.length) {
    out.push(`\n  ${p.bold}Access log${p.reset} ${p.dim}newest first${p.reset}`);
    for (const r of log.reads) out.push(`  ${r.kind === "put" ? `${p.yellow}upload${p.reset}` : "fetch "} ${r.split.padEnd(4)} ${r.by} ${p.dim}${r.version}${r.session_id ? ` · ${r.session_id}` : ""}${r.task_id ? ` · ${r.task_id}` : ""} · ${ago(r.at)}${r.kind === "run" ? ` · ${r.attempt ?? "no attempt"}` : ""}${p.reset}`);
  }
  return out;
}

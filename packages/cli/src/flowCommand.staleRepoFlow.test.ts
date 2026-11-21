// `cast flow run <name>` refuses a checkout cut before the repo's own flow of
// that name landed (docs/architecture/flows.md FL2): the name would otherwise
// resolve to the library's flow and run it in silence. A checkout with its own
// copy, a repo with no remote or no such flow on main, a directory outside git,
// and a subdirectory with its own flows directory all resolve as before.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { staleRepoFlow } from "./flowCommand.js";
import { poolFlows } from "./workflow/flowPool.js";

const tmp: string[] = [];
const mkdtemp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stale-flow-"))); tmp.push(d); return d; };
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const commit = (root: string, msg: string) => { git(root, "add", "."); git(root, "commit", "-q", "-m", msg); return git(root, "rev-parse", "HEAD"); };

const REPO_CHANGE = `digraph change {
  graph [kind="line", label="Repo change", takes="branch"]
  start [shape=Mdiamond]
  intent [label="Founder intent", prompt="Read the change."]
  exit [shape=Msquare]
  start -> intent -> exit
}
`;

/** An origin whose main has (or lacks) the repo's `change` after a first commit, and a clone of it. */
function originAndClone(withFlow = true): { origin: string; clone: string; first: string } {
  const origin = mkdtemp();
  git(origin, "init", "-q", "-b", "main");
  put(origin, "README.md", "repo\n");
  const first = commit(origin, "first");
  put(origin, withFlow ? ".codecast/flows/change.cast" : "NOTES.md", withFlow ? REPO_CHANGE : "notes\n");
  commit(origin, "second");
  const clone = path.join(mkdtemp(), "clone");
  const r = spawnSync("git", ["clone", "-q", origin, clone], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return { origin, clone, first };
}

/** What `cast flow run change` would resolve here, and the refusal it would print. */
const resolve = (cwd: string) => {
  const f = poolFlows(cwd, null, [], mkdtemp()).find((p) => p.slug === "change")!;
  return { where: f.where, label: f.label, refusal: staleRepoFlow(f, cwd) };
};

describe("cast flow run <name> against the repo's default branch", () => {
  test("a checkout cut before the repo's flow landed is refused, naming the reason and the fix", () => {
    const { clone, first } = originAndClone();
    git(clone, "checkout", "-q", "-b", "stale", first);
    const r = resolve(clone);
    expect(r.where).toBe("shipped");
    expect(r.refusal).toBe("This checkout predates the repo's own change flow (origin/main has .codecast/flows/change.cast), so the library's would run instead. Rebase onto origin/main, or run from a checkout that has it (--library runs the library's anyway).");
  });

  test("a checkout with its own copy runs it", () => {
    const { clone } = originAndClone();
    expect(resolve(clone)).toEqual({ where: "repo", label: "Repo change", refusal: null });
  });

  test("a repo whose main has no such flow, one with no remote, and a directory outside git resolve as before", () => {
    const { clone } = originAndClone(false);
    expect(resolve(clone)).toMatchObject({ where: "shipped", refusal: null });
    const local = mkdtemp();
    git(local, "init", "-q", "-b", "main");
    put(local, "README.md", "repo\n");
    commit(local, "first");
    expect(resolve(local)).toMatchObject({ where: "shipped", refusal: null });
    expect(resolve(mkdtemp())).toMatchObject({ where: "shipped", refusal: null });
  });

  test("a subdirectory whose own flows directory lacks the flow is not refused when the repo root has it", () => {
    const { origin, clone } = originAndClone();
    put(origin, "pkg/.codecast/flows/other.cast", `digraph other {\n  start [shape=Mdiamond]\n  exit [shape=Msquare]\n  start -> exit\n}\n`);
    commit(origin, "pkg flows");
    git(clone, "pull", "-q", "--ff-only");
    expect(resolve(path.join(clone, "pkg"))).toMatchObject({ where: "shipped", refusal: null });
  });
});

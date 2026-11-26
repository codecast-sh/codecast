// `cast flow run <name>` runs the repo's flow as the default branch has it (flows.md FL2). The case that made this:
// A repo's `.codecast/flows/change.cast` is a one-line `extends` of server/line/change.cast, identical in every
// checkout, while the base, its segment and its prompts moved on main. A session's worktree cut before that ran the
// old graph against the new scripts, and the run could never land its change (ct-98334).
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { flowAtDefaultWords, repoFlowAtDefault } from "./repoFlowAtDefault.js";
import { parseWorkflowFile } from "./parser.js";

const tmp: string[] = [];
const mkdtemp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flow-at-default-"))); tmp.push(d); return d; };
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const commit = (root: string, msg: string) => { git(root, "add", "-A"); git(root, "commit", "-q", "-m", msg); return git(root, "rev-parse", "HEAD"); };

const WRAPPER = `digraph change {\n  graph [extends="../../line/change.cast"]\n}\n`;
const LAND = (label: string) => `digraph land {
  graph [kind="segment", label="Land", takes="branch"]
  start [shape=Mdiamond]
  merge [label="${label}", shape=parallelogram, script="@land/merge.sh"]
  exit [shape=Msquare]
  start -> merge -> exit
}
`;
const BASE = (station: string) => `digraph change {
  graph [kind="line", label="Change", takes="task,branch"]
  start [shape=Mdiamond]
  ${station} [label="${station}", prompt="@change/${station}.md"]
  land [flow="land"]
  exit [shape=Msquare]
  start -> ${station} -> land -> exit
}
`;

/** An origin at the old flow (founder intent, then ship), a later commit moving it (fix, then land), and a clone at the old one. */
function staleClone(): { origin: string; clone: string; cache: string } {
  const origin = mkdtemp();
  git(origin, "init", "-q", "-b", "main");
  put(origin, ".codecast/flows/change.cast", WRAPPER);
  put(origin, ".codecast/flows/land.cast", `digraph land {\n  graph [extends="../../line/land.cast"]\n}\n`);
  put(origin, "line/change.cast", BASE("intent"));
  put(origin, "line/change/intent.md", "Read the founder's intent.\n");
  put(origin, "line/land.cast", LAND("Ship"));
  put(origin, "line/land/merge.sh", "echo old-merge\n");
  put(origin, "app.ts", "export {}\n");
  const old = commit(origin, "old flow");
  fs.rmSync(path.join(origin, "line/change/intent.md"));
  put(origin, "line/change.cast", BASE("fix"));
  put(origin, "line/change/fix.md", "Fix what review found.\n");
  put(origin, "line/land.cast", LAND("Merge"));
  put(origin, "line/land/merge.sh", "echo new-merge\n");
  commit(origin, "new flow");
  const clone = path.join(mkdtemp(), "clone");
  spawnSync("git", ["clone", "-q", origin, clone]);
  git(clone, "checkout", "-q", "-b", "session-work", old);
  return { origin, clone, cache: mkdtemp() };
}

const wrapperIn = (root: string) => path.join(root, ".codecast/flows/change.cast");

describe("a repo flow runs as the default branch has it", () => {
  test("a checkout whose wrapper is current but whose base, segment and prompts are behind runs main's whole flow", () => {
    const { clone, cache } = staleClone();
    put(clone, "app.ts", "export const work = 1;\n"); // the session's own change elsewhere is no edit to the flow
    commit(clone, "session work");
    const r = repoFlowAtDefault("change", clone, wrapperIn(clone), { fetch: false, cacheRoot: cache });
    expect(r.use).toBe("default");
    if (r.use !== "default") return;
    expect(r.ref).toBe("origin/main");
    expect(r.rel).toBe(".codecast/flows/change.cast");
    expect(r.behind).toEqual(["line/change.cast", "line/change/fix.md", "line/change/intent.md", "line/land.cast", "line/land/merge.sh"]);
    expect(r.file.startsWith(cache)).toBe(true);
    const g = parseWorkflowFile(r.file);
    expect([...g.nodes.keys()].sort()).toEqual(["exit", "fix", "land", "land__exit", "land__merge", "start"].sort());
    expect(g.nodes.get("fix")!.prompt).toBe("Fix what review found.\n");
    expect(g.nodes.get("land__merge")!.label).toBe("Merge");
    expect(g.nodes.get("land__merge")!.script).toBe("echo new-merge\n");
    expect(flowAtDefaultWords("change", r)).toContain("change runs as origin/main has it");
  });

  test("a checkout cut before the repo's flow existed runs main's rather than the library's", () => {
    const { origin, cache } = staleClone();
    const bare = mkdtemp();
    git(bare, "init", "-q", "-b", "main");
    put(bare, "README.md", "x\n");
    commit(bare, "first");
    git(bare, "remote", "add", "origin", origin);
    git(bare, "fetch", "-q", "origin");
    git(bare, "remote", "set-head", "origin", "main");
    const r = repoFlowAtDefault("change", bare, null, { fetch: false, cacheRoot: cache });
    expect(r.use).toBe("default");
    if (r.use === "default") expect(parseWorkflowFile(r.file).nodes.has("fix")).toBe(true);
  });

  test("a checkout on main's flow runs its own file", () => {
    const { clone, cache } = staleClone();
    git(clone, "checkout", "-q", "main");
    expect(repoFlowAtDefault("change", clone, wrapperIn(clone), { fetch: false, cacheRoot: cache })).toEqual({ use: "found" });
  });

  test("uncommitted edits to the flow's files run the checkout's copy, naming them", () => {
    const { clone, cache } = staleClone();
    put(clone, "line/land/merge.sh", "echo trying-a-merge\n");
    const r = repoFlowAtDefault("change", clone, wrapperIn(clone), { fetch: false, cacheRoot: cache });
    expect(r).toMatchObject({ use: "checkout", own: ["line/land/merge.sh"] });
    expect(flowAtDefaultWords("change", r)).toContain("runs this checkout's own edits to line/land/merge.sh");
  });

  test("committed edits to the flow that main lacks run the checkout's copy", () => {
    const { clone, cache } = staleClone();
    git(clone, "checkout", "-q", "main");
    put(clone, "line/change/fix.md", "Fix it a new way.\n");
    commit(clone, "flow work");
    expect(repoFlowAtDefault("change", clone, wrapperIn(clone), { fetch: false, cacheRoot: cache })).toMatchObject({ use: "checkout", own: ["line/change/fix.md"] });
  });

  test("no remote, no such flow on main, and a directory outside git leave the found one", () => {
    const { clone, cache } = staleClone();
    expect(repoFlowAtDefault("nope", clone, null, { fetch: false, cacheRoot: cache })).toEqual({ use: "found" });
    const local = mkdtemp();
    git(local, "init", "-q", "-b", "main");
    put(local, ".codecast/flows/change.cast", BASE("fix"));
    commit(local, "first");
    expect(repoFlowAtDefault("change", local, wrapperIn(local), { fetch: false, cacheRoot: cache })).toEqual({ use: "found" });
    expect(repoFlowAtDefault("change", mkdtemp(), null, { fetch: false, cacheRoot: cache })).toEqual({ use: "found" });
  });

  test("a default-branch flow this cast cannot parse stops the run rather than running the checkout's older copy", () => {
    const { origin, clone, cache } = staleClone();
    put(origin, "line/land.cast", LAND("Merge").replace("merge -> exit", "merge -> intent -> exit\n  intent [flow=\"a-segment-a-newer-cast-ships\"]"));
    commit(origin, "uses a newer segment");
    git(clone, "fetch", "-q", "origin");
    const r = repoFlowAtDefault("change", clone, wrapperIn(clone), { fetch: false, cacheRoot: cache });
    expect(r.use).toBe("unparsed");
    if (r.use === "unparsed") expect(r.error).toContain("a-segment-a-newer-cast-ships");
    expect(flowAtDefaultWords("change", r)).toContain("does not parse with this cast");
    git(clone, "checkout", "-q", "main");
    git(clone, "reset", "-q", "--hard", "origin/main");
    expect(repoFlowAtDefault("change", clone, wrapperIn(clone), { fetch: false, cacheRoot: cache })).toEqual({ use: "found" });
  });

  test("it fetches the default branch first, so a stale local origin ref is not trusted", () => {
    const { origin, clone, cache } = staleClone();
    git(clone, "checkout", "-q", "main");
    put(origin, "line/change/fix.md", "Fix, as main now says.\n");
    commit(origin, "newer prompt");
    const r = repoFlowAtDefault("change", clone, wrapperIn(clone), { cacheRoot: cache });
    expect(r.use).toBe("default");
    if (r.use === "default") expect(parseWorkflowFile(r.file).nodes.get("fix")!.prompt).toBe("Fix, as main now says.\n");
  });
});

// Replays of the incidents that stalled Ship runs on Nov 21 (pl-1077, ct-98575),
// each through the shipped change flow end to end: the real runner on the
// built-in change.cast, a real bare origin and the checkout a session works
// in, and the real PR, CI, Verdicts, Merge, Onto main, Wait for main and
// Deploy stations (incidentReplay.testkit.ts). The server is a fake that plays
// the reviewer, which pins ship with the round's nonce and records it on the
// run, and the change's session, which never fixes anything: none of these
// incidents is the session's to fix.
//
// Covered elsewhere, and not replayed again here: Land that exits 0 with main
// never moved (landed.test.ts, awaitDeploy.test.ts mergedCommit), Deploy reached
// only through a merge with a sha on main (changeFlow.e2e.test.ts), the merge
// guard's young-file rule on `cast line merge` (lineMerge.test.ts), and the CI
// station's split of a red head (ciStation.test.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFrozenChange } from "./flowChangeFile";
import { BRANCH, CONV, ENV, git, landOnMain, readState } from "./incidentReplay.testkit";
import { parseWorkflowSource } from "./parser";
import { lineRunDir, runSlug, runWorkflow } from "./runner";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";

const T = 600_000;
/** The before-merge step: records where it ran and what it saw there. */
const STEP = 'pwd -P > "$FAKE_STATE/step-cwd"; git rev-parse HEAD > "$FAKE_STATE/step-head"; git status --porcelain --untracked-files=all > "$FAKE_STATE/step-status"; cat api/handler.ts > "$FAKE_STATE/step-handler"; ls api > "$FAKE_STATE/step-api"';
const saved: Record<string, string | undefined> = {};
let sandbox = "";
let origFetch: typeof fetch;
let origLog: typeof console.log;

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-incident-replay-")));
  const bin = path.join(sandbox, "bin");
  fs.mkdirSync(bin);
  const kit = path.join(import.meta.dir, "incidentReplay.testkit.ts");
  // `ws path` names the checkout the run started from: its stations run where the session's edits sit.
  fs.writeFileSync(path.join(bin, "cast"), `#!/bin/sh
echo "$*" >> "$FAKE_STATE/calls.log"
case "$1 $2" in
  "ws path") echo "$FAKE_ROOT" ;;
  "flow "*) exec bun "${kit}" cast "$@" ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nexec bun "${kit}" gh "$@"\n`, { mode: 0o755 });
  for (const [k, v] of Object.entries({ ...ENV, HOME: sandbox, CODECAST_DIR: path.join(sandbox, ".codecast"), PATH: `${bin}:${process.env.PATH}` })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  origFetch = globalThis.fetch;
  origLog = console.log;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  globalThis.fetch = origFetch;
  console.log = origLog;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

let worlds = 0;
/** A bare origin whose main holds `base` (one commit per entry), and the clone a session works in, on main. */
function world(base: Array<{ files: Record<string, string>; message: string }>) {
  const root = path.join(sandbox, `w${++worlds}`);
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const state = path.join(root, "state");
  fs.mkdirSync(state, { recursive: true });
  process.env.CODECAST_DIR = path.join(root, ".codecast");
  Object.assign(process.env, { FAKE_ROOT: work, FAKE_STATE: state, FAKE_ORIGIN: origin });
  fs.writeFileSync(path.join(state, "calls.log"), "");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  const write = (files: Record<string, string>) => {
    for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), text); }
  };
  for (const c of base) {
    write(c.files);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", c.message);
  }
  git(work, "push", "-q", "-u", "origin", "main");
  git(work, "remote", "set-head", "origin", "main");
  /** The session's change, committed on `feat` off main: files written, and paths removed. */
  const change = (files: Record<string, string>, removed: string[] = []) => {
    git(work, "checkout", "-q", "-b", BRANCH);
    write(files);
    for (const f of removed) git(work, "rm", "-q", f);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "the change");
    git(work, "checkout", "-q", "main");
    return [...Object.keys(files), ...removed];
  };
  const runDir = lineRunDir(work, runSlug(parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change), { task_id: "ct-9" }, "run"));
  const calls = () => fs.readFileSync(path.join(state, "calls.log"), "utf-8").trim().split("\n").filter((l) => l.startsWith("flow ")).map((l) => l.split(" ").slice(0, /^flow pr --rebase/.test(l) ? 3 : 2).join(" "));
  const originMain = () => git(root, "--git-dir", origin, "rev-parse", "refs/heads/main");
  const merged = () => JSON.parse(fs.readFileSync(path.join(runDir, "merge.json"), "utf-8")).sha as string;
  return { root, origin, work, state, runDir, write, change, calls, originMain, merged };
}
type World = ReturnType<typeof world>;

/** A message that asks the session to work: not how the run ended, nor a gate's answer, which only inform. */
const isBrief = (body: string) => !/ is over: | stopped at |^Decide: /.test(body);

/** The server: each reviewer pins ship on the round and head its prompt names and records it on the run. */
function server(w: World) {
  const calls: Array<{ route: string; body: any }> = [];
  const spawned: any[] = [];
  const pins = new Map<string, object>();
  // The session ends a turn on each message it gets, changing nothing.
  let messages = 10;
  globalThis.fetch = (async (url: any, init: any) => {
    const route = String(url).replace(/^https?:\/\/[^/]+/, "");
    const body = structuredClone(JSON.parse(init?.body || "{}"));
    calls.push({ route, body });
    const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (route === "/cli/work/get") return reply({ title: "The change", status: "in_progress" });
    if (route === "/cli/spawn") {
      spawned.push(body);
      const id = `conv_review_${spawned.length}`;
      const round = /"round": "([^"]+)"/.exec(body.prompt)?.[1];
      const head_sha = /"head_sha": "([^"]+)"/.exec(body.prompt)?.[1];
      pins.set(id, { state: "Reviewed", status: "done", result: JSON.stringify({ verdict: "ship", findings: [], round, head_sha }), at: Date.now() });
      // `cast flow review-verdict`: what the server holds for the attempt, and Merge's proof.
      const kept = readState<{ rebases?: unknown[] }>("proof.json", {});
      fs.writeFileSync(path.join(w.state, "proof.json"), JSON.stringify({ review: { verdict: "ship", head_sha, node_id: "review" }, rebases: kept.rebases ?? [] }));
      return reply({ conversation_id: id, short_id: `rev${spawned.length}` });
    }
    if (route === "/cli/inbox") {
      const id = body.session_ids?.[0];
      return reply({ sessions: [{ id, work_state: "done", is_live: id === CONV, is_killed: false, message_count: id === CONV ? messages : 4 }] });
    }
    if (route === "/cli/sessions/state/get") return reply(pins.get(body.session) ?? null);
    if (route === "/cli/messages/send") { messages += 3; return reply({ ok: true }); }
    return reply({ ok: true });
  }) as typeof fetch;
  const sent = () => calls.filter((c) => c.route === "/cli/messages/send").map((c) => c.body);
  return { spawned, sent, briefs: () => sent().filter((m) => isBrief(m.body)).map((m) => m.body as string) };
}

/** The session ran `cast flow run change --branch feat`, with `ci` the answers CI gives in turn. */
async function run(w: World, paths: string[], ci: Array<"green" | "red-main">) {
  fs.writeFileSync(path.join(w.state, "ci.queue"), JSON.stringify(ci));
  const tip = git(w.work, "rev-parse", BRANCH);
  writeFrozenChange(w.runDir, { source: "branch", session: CONV.slice(0, 7), conversation: CONV, base: tip, tip, branch: BRANCH, worktree: "change-ct-9", paths, shared: [], held: [] });
  console.log = process.env.SHOW_RUN ? origLog : () => {};
  try {
    return await runWorkflow(parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change), { cwd: w.work, taskId: "ct-9", runId: "run-9", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 });
  } finally {
    console.log = origLog;
  }
}

const filesOf = (w: World, sha: string) => git(w.work, "diff-tree", "-r", "--name-only", "--no-commit-id", `${sha}^`, sha).split("\n").filter(Boolean);
const treeOf = (w: World, ref: string) => git(w.root, "--git-dir", w.origin, "ls-tree", "-r", "--name-only", ref).split("\n");

describe("incident replays: the shipped change flow on real git and the real stations", () => {
  // Nov 21 (ct-98322): the land command applied the change to the main checkout and never committed, and the
  // deploys that followed read that working tree. Here the session's checkout holds other sessions' uncommitted
  // work in the backend's files, its main is behind origin's, and every station runs in it.
  test("working-tree land: Merge deploys the backend from the change rebased onto main in a tree of its own, Deploy only waits on that target and sends the rest carrying the merged commit, and the checkout's uncommitted edits never ship", async () => {
    const w = world([{
      message: "base",
      files: {
        "api/handler.ts": "export const handler = 1;\n",
        "api/route.ts": "export const route = 1;\n",
        "web/page.tsx": "page 1\n",
      },
    }, {
      message: "the line profile",
      files: {
        ".codecast/workspace.toml": `[[ship.deploy]]\nname = "convex"\nwhen = ["api/**"]\nstage = "before_push"\nrun = ${JSON.stringify(STEP)}\n`,
        ".codecast/deploy.toml": `[[target]]\nname = "backend"\nship = "convex"\nlive = "marker"\npolicy = "release"\n\n[[target]]\nname = "web"\nwhen = ["web/**"]\nrun = "./deploy-web.sh"\nlive = "marker"\npolicy = "release"\n`,
      },
    }]);
    const s = server(w);
    const paths = w.change({ "api/route.ts": "export const route = 2;\n", "web/page.tsx": "page 2\n" });
    // Someone else's change lands after the branch was cut; this checkout's main never pulls it.
    const theirs = landOnMain(w.origin, { "web/other.tsx": "theirs\n" }, "someone else's change");
    // Other sessions' work in progress in the checkout: an unstaged edit, a staged new file, an untracked one.
    const step = (f: string) => path.join(w.state, f);
    w.write({ "api/handler.ts": "export const handler = 'HALF-DONE';\n", "api/staged.ts": "staged\n", "api/draft.ts": "draft\n" });
    git(w.work, "add", "api/staged.ts");
    const checkoutHead = git(w.work, "rev-parse", "HEAD");
    const dirty = () => [git(w.work, "diff"), git(w.work, "diff", "--cached"), fs.readFileSync(path.join(w.work, "api/draft.ts"), "utf-8")];
    const before = dirty();

    expect(await run(w, paths, ["green"])).toBe("completed");
    expect(s.sent().at(-1).body).toContain("The Ship run on ct-9 is over: Live.");
    expect(s.briefs()).toEqual([]);
    expect(w.calls()).toEqual(["flow pr", "flow ci", "flow verdicts", "flow merge", "flow await-deploy"]);

    // Merge: the step ran once, in the station's scratch tree, never in the checkout; that tree is the change on
    // origin's main, holding someone else's landed change and none of the checkout's uncommitted work.
    const ran = fs.readFileSync(step("step-cwd"), "utf-8").trim();
    expect(ran).not.toBe(fs.realpathSync(w.work));
    expect(ran.startsWith(path.join(fs.realpathSync(w.work), ".codecast", "worktrees", "merge-scratch-"))).toBe(true);
    const deployedAt = fs.readFileSync(step("step-head"), "utf-8").trim();
    expect(git(w.work, "merge-base", "--is-ancestor", theirs, deployedAt)).toBe("");
    expect(git(w.work, "show", `${deployedAt}:api/route.ts`)).toBe("export const route = 2;");
    expect(fs.readFileSync(step("step-handler"), "utf-8")).toBe("export const handler = 1;\n");
    expect(fs.readFileSync(step("step-api"), "utf-8").trim().split("\n")).toEqual(["handler.ts", "route.ts"]);
    expect(fs.readFileSync(step("step-status"), "utf-8")).not.toContain("api/");

    // What merged is the change alone, on top of main as origin had it.
    const sha = w.merged();
    expect(sha).toBe(w.originMain());
    expect(git(w.work, "rev-parse", `${sha}^`)).toBe(theirs);
    expect(filesOf(w, sha).sort()).toEqual(["api/route.ts", "web/page.tsx"]);
    expect(treeOf(w, sha)).not.toContain("api/draft.ts");
    expect(treeOf(w, sha)).not.toContain("api/staged.ts");
    expect(git(w.root, "--git-dir", w.origin, "show", `${sha}:api/handler.ts`)).toBe("export const handler = 1;");

    // Deploy: the backend Merge sent is only waited on (recorded live at the merged commit), and web is sent
    // carrying the merged commit.
    expect(readState<unknown[]>("deploy-plan.json", [])).toEqual([{ target: "backend", action: "wait", how: "merge" }, { target: "web", action: "send", how: "release" }]);
    expect(readState<Array<{ targets: string[]; carrying: string }>>("sends.json", []).map((x) => [x.targets, x.carrying])).toEqual([[["web"], sha]]);
    const pass = fs.readFileSync(step("posts.log"), "utf-8").trim().split("\n").map((l) => JSON.parse(l)).find((p) => p.route === "/cli/deploys/ship-pass")!.body;
    expect(pass).toMatchObject({ pushed: sha, deploys: [{ name: "convex", stage: "before_push", ok: true, target: "backend" }] });

    // The checkout is as the other sessions left it: its HEAD, its staged and unstaged edits, its untracked file.
    expect(git(w.work, "rev-parse", "HEAD")).toBe(checkoutHead);
    expect(dirty()).toEqual(before);
  }, T);

  // Nov 21 (ct-97881, fixed in 07cca7927 for ct-98089): a change replaced two files main had created a few commits
  // earlier with one. Main moved on another file meanwhile, and the merge guard read the deletions as the change
  // undoing their creation: it refused and sent the change back to be rebuilt.
  test("young-file deletion: a change replacing two files main created recently with one merges onto the moved main and goes live, with nothing sent back to the session", async () => {
    const w = world([
      { message: "base", files: { "a.txt": "base\n" } },
      { message: "add check", files: { "line/check.md": "check\n" } },
      { message: "add reconcile", files: { "line/reconcile.md": "reconcile\n" } },
    ]);
    const s = server(w);
    const paths = w.change({ "line/review.md": "one review step replaces check and reconcile\n" }, ["line/check.md", "line/reconcile.md"]);
    const theirs = landOnMain(w.origin, { "m.txt": "main moved\n" }, "main moved");

    expect(await run(w, paths, ["green"])).toBe("completed");
    expect(s.sent().at(-1).body).toContain("The Ship run on ct-9 is over: Live.");
    expect(s.briefs()).toEqual([]);
    expect(w.calls().filter((c) => c === "flow merge")).toHaveLength(1);
    const sha = w.merged();
    expect(sha).toBe(w.originMain());
    expect(git(w.work, "rev-parse", `${sha}^`)).toBe(theirs);
    expect(treeOf(w, sha)).toEqual(["a.txt", "line/review.md", "m.txt"]);
  }, T);

  // Nov 21: main's CI went red on someone else's commit, the change's pull request went red with it, and the run
  // sent the session to fix what was not its own; nothing waited for main or tried again.
  test("red main from another change: CI red only where main is red too waits for main, puts the change on the fixed main and merges it there, briefing nobody", async () => {
    const w = world([{ message: "base", files: { "a.txt": "base\n", "src/clock.ts": "export const tick = 1;\n" } }]);
    const s = server(w);
    const paths = w.change({ "b.txt": "the change\n" });
    const culprit = landOnMain(w.origin, { "src/clock.ts": "export const tick = BROKEN;\n" }, "someone else's change breaks test-cli");
    fs.writeFileSync(path.join(w.state, "main-ci.json"), JSON.stringify({ [culprit]: "failure" }));
    fs.writeFileSync(path.join(w.state, "main-fix.json"), JSON.stringify({ files: { "src/clock.ts": "export const tick = 2;\n" }, message: "fix test-cli on main" }));
    const reviewed = git(w.work, "rev-parse", BRANCH);

    expect(await run(w, paths, ["red-main", "green"])).toBe("completed");
    expect(s.sent().at(-1).body).toContain("The Ship run on ct-9 is over: Live.");
    expect(s.briefs()).toEqual([]);
    // The real CI station judged the red main's, not the change's.
    const [first, second] = readState<any[]>("ci.seen", []);
    expect(first).toMatchObject({ green: false, blocked_by_main: true, failing: [], head_sha: reviewed });
    expect(first.preexisting.map((f: { job: string }) => f.job)).toEqual(["test-cli"]);
    expect(w.calls()).toEqual(["flow pr", "flow ci", "flow verdicts", "flow wait-main", "flow pr --rebase", "flow ci", "flow verdicts", "flow merge", "flow await-deploy"]);
    // One review, of the head the session made; CI then passed on that head put onto the fixed main.
    expect(s.spawned).toHaveLength(1);
    const fixed = readState<string>("main-fixed.json", "");
    expect(git(w.work, "merge-base", "--is-ancestor", fixed, second.head_sha)).toBe("");
    expect(second).toMatchObject({ green: true, tested_main_sha: fixed });
    expect(readState<{ rebases: Array<{ from: string; to: string }> }>("proof.json", { rebases: [] }).rebases).toEqual([{ from: reviewed, to: second.head_sha }]);
    // It merged onto main once main was green: on the fix, never on the red commit alone.
    const sha = w.merged();
    expect(sha).toBe(w.originMain());
    expect(git(w.work, "rev-parse", `${sha}^`)).toBe(fixed);
    expect(filesOf(w, sha)).toEqual(["b.txt"]);
  }, T);
});

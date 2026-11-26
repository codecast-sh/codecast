// End to end (flows.md FL4): the shipped `change` flow in a repository that ships straight to its default branch
// ([ship] mode = "direct" in its own workspace.toml, a line profile ship command, no CI on GitHub), run by the real
// runner on real git. Check runs the profile's check in the run's worktree, an independent reviewer gives a verdict,
// the session the change came from fixes what they find, and Land rebases the branch onto origin's main and runs the
// profile's ship command, which pushes main. No pull request, no CI wait, no Merge. The server is a fake that plays
// the reviewer (its verdict lands on the task) and the session, which commits its fix in the run's worktree when a
// brief reaches it; `cast` on PATH answers what the stations ask of it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFrozenChange } from "./flowChangeFile";
import { parseWorkflowSource } from "./parser";
import { lineRunDir, runSlug, runWorkflow } from "./runner";
import type { ResumeRow } from "./runResume";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const CONV = "jx7dddddddddddddddddddddddddddd1";
const saved: Record<string, string | undefined> = {};
let sandbox = "";
let origFetch: typeof fetch;
let origLog: typeof console.log;

// `cast landed` puts the commit origin's main now holds where Deploy reads it, as the real one does once it finds the
// change there. Every other call is logged and answers nothing.
const FAKE_CAST = `#!/bin/sh
echo "$*" >> "$FAKE_STATE/calls.log"
arg() { prev=""; for a in "$@"; do [ "$prev" = "$want" ] && { echo "$a"; return; }; prev="$a"; done; }
case "$1 $2" in
  "ws path") echo "$FAKE_WT" ;;
  "flow landed")
    want=--out; out=$(arg "$@")
    echo "{\\"sha\\": \\"$(git -C "$FAKE_ORIGIN" rev-parse main)\\"}" > "$out" ;;
  "flow await-deploy") echo "Live: nothing this run deploys ships its files." ;;
esac
exit 0
`;

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-change-direct-e2e-")));
  const bin = path.join(sandbox, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "cast"), FAKE_CAST, { mode: 0o755 });
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

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV } }).trim();

let worlds = 0;
/** sit's setup: a repository that says it ships straight to main, with a check and a ship command of its own. */
function world(o: { check: string; verdicts: string[] }) {
  const n = ++worlds;
  const origin = path.join(sandbox, `origin-${n}.git`);
  const root = path.join(sandbox, `repo-${n}`);
  const state = path.join(sandbox, `state-${n}`);
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, "calls.log"), "");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, root], { env: { ...process.env, ...ENV } });
  git(root, "checkout", "-q", "-b", "main");
  fs.mkdirSync(path.join(root, ".codecast"));
  fs.writeFileSync(path.join(root, ".codecast", "workspace.toml"), `[ship]\nmode = "direct"\n`);
  fs.writeFileSync(path.join(root, ".codecast", "line.toml"), `[line.commands]\ncheck = ${JSON.stringify(o.check)}\nship = "git push -q origin HEAD:main && echo \\"Landed $(git rev-parse --short HEAD) on main\\""\n`);
  fs.writeFileSync(path.join(root, ".gitignore"), ".codecast/worktrees/\n");
  fs.writeFileSync(path.join(root, "a.txt"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  git(root, "push", "-q", "origin", "main");
  git(root, "checkout", "-q", "-b", "feat");
  fs.writeFileSync(path.join(root, "a.txt"), "bad\n");
  git(root, "commit", "-qam", "the change");
  git(root, "checkout", "-q", "main");
  // The run's worktree holds the branch, where runWorktreePath finds it.
  const wt = path.join(root, ".codecast", "worktrees", "change-ct-9");
  git(root, "worktree", "add", "-q", wt, "feat");
  Object.assign(process.env, { CODECAST_DIR: path.join(sandbox, `.codecast-${n}`), FAKE_STATE: state, FAKE_WT: wt, FAKE_ORIGIN: origin });
  const runDir = lineRunDir(root, runSlug(parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change), { task_id: "ct-9" }, "run"));
  const calls = () => fs.readFileSync(path.join(state, "calls.log"), "utf-8").trim().split("\n").filter(Boolean).map((l) => l.split(" ").slice(0, 2).join(" "));
  return { root, origin, wt, runDir, calls, verdicts: [...o.verdicts] };
}

const isBrief = (body: string) => !/ is over: | stopped at |^Decide: /.test(body);

/** The server: each reviewer leaves the next queued verdict on the task; the session fixes a.txt when a brief reaches it. */
function server(w: ReturnType<typeof world>, o: { endAt?: string } = {}) {
  let endAt = o.endAt;
  const calls: Array<{ route: string; body: any }> = [];
  const spawned: any[] = [];
  let verdict: { verdict: string; note: string; at: number } | null = null;
  let messages = 10;
  globalThis.fetch = (async (url: any, init: any) => {
    const route = String(url).replace(/^https?:\/\/[^/]+/, "");
    const body = structuredClone(JSON.parse(init?.body || "{}"));
    calls.push({ route, body });
    const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    // A person stops the run as it reaches `endAt`, once: the runner stops there, its checkpoint written.
    if (route === "/cli/workflow-runs/progress" && endAt && body.node_id === endAt && body.node_status === "running") {
      endAt = undefined;
      return reply({ ended: { status: "failed", reason: "stopped by a person" } });
    }
    if (route === "/cli/work/get") return reply({ title: "Make a.txt good", status: "in_progress", ...(verdict ? { review_verdict: verdict } : {}) });
    if (route === "/cli/spawn") {
      spawned.push(body);
      const v = w.verdicts.shift() ?? "approve";
      verdict = { verdict: v, note: v === "changes" ? "a.txt:1 says bad where the task asks for good" : "Reads right.", at: Date.now() };
      return reply({ conversation_id: `conv_review_${spawned.length}`, short_id: `rev${spawned.length}` });
    }
    if (route === "/cli/inbox") {
      const id = body.session_ids?.[0];
      return reply({ sessions: [{ id, work_state: "done", is_live: id === CONV, is_killed: false, message_count: id === CONV ? messages : 4 }] });
    }
    if (route === "/cli/sessions/state/get") return reply(body.session === CONV ? null : { state: "Reviewed", status: "done", at: Date.now() });
    if (route === "/cli/messages/send") {
      if (body.to === CONV && isBrief(body.body)) {
        fs.writeFileSync(path.join(w.wt, "a.txt"), "good\n");
        git(w.wt, "commit", "-qam", "make a.txt good");
      }
      messages += 3;
      return reply({ ok: true });
    }
    return reply({ ok: true });
  }) as typeof fetch;
  const sent = () => calls.filter((c) => c.route === "/cli/messages/send").map((c) => c.body);
  return {
    spawned,
    sent,
    briefs: () => sent().filter((m) => m.to === CONV && isBrief(m.body)).map((m) => m.body as string),
    progressNodes: () => new Set(calls.filter((c) => c.route === "/cli/workflow-runs/progress").map((c) => c.body.node_id).filter(Boolean)),
  };
}

async function run(w: ReturnType<typeof world>, resume?: ResumeRow) {
  const tip = git(w.root, "rev-parse", "feat");
  if (!resume) writeFrozenChange(w.runDir, { source: "branch", session: CONV.slice(0, 7), conversation: CONV, base: git(w.root, "rev-parse", "main"), tip, branch: "feat", worktree: "change-ct-9", paths: ["a.txt"], shared: [], held: [] });
  console.log = process.env.SHOW_RUN ? origLog : () => {};
  try {
    return await runWorkflow(parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change), { cwd: w.root, taskId: "ct-9", runId: "run-9", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, ...(resume ? { resume } : {}) });
  } finally {
    console.log = origLog;
  }
}

/** What the PR path would have asked of `cast`: none of it runs in a direct repository. */
const PR_PATH = ["flow pr", "flow ci", "flow verdicts", "flow merge", "flow wait-main", "ship run"];

describe("the shipped change flow, in a repository that ships straight to main", () => {
  test("check, review and the profile's ship command land the change on main, then Deploy; no pull request or CI", async () => {
    const w = world({ check: "test -f a.txt", verdicts: ["approve"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(w.calls().filter((c) => PR_PATH.includes(c))).toEqual([]);
    expect(w.calls()).toContain("flow await-deploy");
    // The ship command pushed the change itself to origin's main, and Deploy starts from that commit.
    expect(git(w.origin, "rev-parse", "main")).toBe(git(w.root, "rev-parse", "feat"));
    expect(git(w.origin, "show", "main:a.txt")).toBe("bad");
    expect(JSON.parse(fs.readFileSync(path.join(w.runDir, "merge.json"), "utf-8")).sha).toBe(git(w.origin, "rev-parse", "main"));
    expect(s.spawned).toHaveLength(1);
    expect(s.briefs()).toEqual([]);
    // The run reported only the stations of its own path: none of the PR path's.
    const nodes = s.progressNodes();
    expect([...nodes].some((id) => ["pr", "ci", "merge", "verdicts"].includes(id))).toBe(false);
    expect(nodes.has("land__ship")).toBe(true);
    expect(s.sent().at(-1).body).toContain("The Ship run on ct-9 is over: Live.");
  }, 120_000);

  test("the checkout's own edits pick neither the path nor the land command: main's ship command lands the change", async () => {
    const w = world({ check: "test -f a.txt", verdicts: ["approve"] });
    const s = server(w);
    // Uncommitted in the checkout the run starts from: a ship command that would land anything, unreviewed.
    fs.writeFileSync(path.join(w.root, ".codecast", "line.toml"), `[line.commands]\ncheck = "true"\nship = "touch \\"$FAKE_STATE/pwned\\"; echo landed"\n`);
    expect(await run(w)).toBe("completed");
    expect(fs.existsSync(path.join(process.env.FAKE_STATE!, "pwned"))).toBe(false);
    expect(git(w.origin, "rev-parse", "main")).toBe(git(w.root, "rev-parse", "feat"));
    expect(s.spawned).toHaveLength(1);
  }, 120_000);

  // A run's facts are its own: what main says when it resumes (another mode, or a file that no longer parses) neither
  // moves it off its path nor lets the checkout's ship command land it.
  for (const [name, workspace] of [["now says pull request", `[ship]\nmode = "pr"\n`], ["no longer parses", `[ship\nmode = \n`]] as const) {
    test(`a resumed direct run keeps its own facts when main ${name}: main's original ship command lands it`, async () => {
      const w = world({ check: "test -f a.txt", verdicts: ["changes", "approve"] });
      const s = server(w, { endAt: "direct_revise" });
      expect(await run(w)).toBe("failed");
      expect(s.briefs()).toEqual([]);
      fs.writeFileSync(path.join(w.root, ".codecast", "workspace.toml"), workspace);
      git(w.root, "commit", "-qam", "main changes how it ships");
      git(w.root, "push", "-q", "origin", "main");
      fs.writeFileSync(path.join(w.root, ".codecast", "line.toml"), `[line.commands]\ncheck = "true"\nship = "touch \\"$FAKE_STATE/pwned\\"; echo landed"\n`);
      expect(await run(w, { status: "running", current_node_id: "direct_revise" })).toBe("completed");
      expect(fs.existsSync(path.join(process.env.FAKE_STATE!, "pwned"))).toBe(false);
      expect(s.briefs()).toHaveLength(1);
      expect(w.calls().filter((c) => PR_PATH.includes(c))).toEqual([]);
      expect(git(w.origin, "show", "main:a.txt")).toBe("good");
    }, 120_000);
  }

  test("a repository whose main runs CI on GitHub stays on the pull request path, whatever its mode says", async () => {
    const w = world({ check: "test -f a.txt", verdicts: ["approve"] });
    server(w);
    fs.mkdirSync(path.join(w.root, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(w.root, ".github", "workflows", "ci.yml"), "on: push\n");
    git(w.root, "add", "-A");
    git(w.root, "commit", "-qm", "ci");
    git(w.root, "push", "-q", "origin", "main");
    await run(w);
    expect(w.calls()).toContain("flow pr");
    expect(w.calls()).not.toContain("flow await-deploy");
  }, 120_000);

  test("a failing check goes back to the session, whose fix is checked, reviewed and landed", async () => {
    const w = world({ check: "! grep -q bad a.txt", verdicts: ["approve"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const [brief, ...more] = s.briefs();
    expect(more).toEqual([]);
    expect(brief).toContain("The project's check failed on the change");
    // The reviewer reads only a change that passes the check.
    expect(s.spawned).toHaveLength(1);
    expect(git(w.origin, "show", "main:a.txt")).toBe("good");
    expect(w.calls().filter((c) => PR_PATH.includes(c))).toEqual([]);
  }, 120_000);

  test("a reviewer asking for changes goes back to the session with its note; a fresh review passes the fix", async () => {
    const w = world({ check: "test -f a.txt", verdicts: ["changes", "approve"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const [brief, ...more] = s.briefs();
    expect(more).toEqual([]);
    expect(brief).toContain("a.txt:1 says bad where the task asks for good");
    expect(s.spawned).toHaveLength(2);
    expect(git(w.origin, "show", "main:a.txt")).toBe("good");
  }, 120_000);
});

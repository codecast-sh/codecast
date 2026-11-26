// End to end (flows.md FL4): the shipped `personal` flow, Round → Find check →
// Check ‖ Review → Verdicts → Land → Deploy, run by the real runner on real
// git, with a local bare repository as origin. Its stations' commands are a
// fake `cast` on PATH that runs the real pieces: Check runs the commands Find
// check pinned (personalCheck.ts), Land's record is the real `cast flow landed`
// and the checkout catches up through the real `cast land level`. The server
// is a fake that plays Find check, the reviewer (pinning the round's nonce as
// its prompt asks), Deploy, and the session the change came from, which commits
// its fix to the branch when a brief reaches it. A fake `gh` records any call:
// nothing in this flow may open a pull request.
import { afterAll, beforeAll, describe, expect, test as bunTest } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { freezeSessionChange } from "./flowChange";
import { writeFrozenChange } from "./flowChangeFile";
import { graphHash, parseWorkflowFile, parseWorkflowSource } from "./parser";
import { lineRunDir, runSlug, runWorkflow } from "./runner";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";
import { evalCondition } from "./condition";
import { executeCommand } from "./commandStation";
import { resumeStation } from "./resumeFailed";
import { commandDir, commandEscapes, runCheck } from "./personalCheck";
import { landedExitOf, subjectKept } from "./runner";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const CONV = "jx7ssssssssssssssssssssssssssss1";
const saved: Record<string, string | undefined> = {};
let sandbox = "";
let origFetch: typeof fetch;
let origLog: typeof console.log;

// Each command logged; the ones the flow's scripts call run the real code.
const FAKE_CAST = (check: string, landed: string, level: string) => `#!/bin/bash
echo "$*" >> "$FAKE_STATE/calls.log"
arg() { local prev=""; for a in "$@"; do [ "$prev" = "$want" ] && { printf '%s\\n' "$a"; return; }; prev="$a"; done; }
case "$1 $2" in
  "ws path") [ -e "$FAKE_STATE/ws-gone" ] && exit 1; echo "$FAKE_WT" ;;
  "flow check")
    want=--spec; spec=$(arg "$@"); want=--tree; tree=$(arg "$@"); want=--dir; d=$(arg "$@")
    bun -e 'import { runCheck } from "${check}"; const [spec, tree, dir] = process.argv.slice(1); const r = runCheck({ spec, tree, dir }); if (typeof r === "string") { console.log(r); process.exit(2); } console.log(JSON.stringify(r))' "$spec" "$tree" "$d"; exit $? ;;
  "flow landed")
    [ -e "$FAKE_STATE/landed-fails" ] && { echo "the server did not answer"; exit 1; }
    # Something that happens on origin while Land records its landing.
    [ -x "$FAKE_STATE/after-land.sh" ] && "$FAKE_STATE/after-land.sh" > /dev/null 2>&1
    shift 2
    bun -e 'import { runLanded } from "${landed}"; const a = process.argv.slice(2); const o = {}; for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, "")] = a[i + 1]; delete o.run; process.exit(await runLanded(process.cwd(), o))' args "$@"; exit $? ;;
  "land level")
    want=--to; to=$(arg "$@"); want=--checkout; co=$(arg "$@")
    last=""; for a in "$@"; do [ "$a" = --ref-last ] && last=1; done
    # A slow catch-up.
    [ -e "$FAKE_STATE/level-slow" ] && sleep 65
    # The checkout Land names, else this directory, as the real command levels it, and in its words.
    bun -e 'import { levelCheckout } from "${level}"; const [to, co, last] = process.argv.slice(1); const r = await levelCheckout(co || process.cwd(), to, last ? { refLast: true } : {}); const counts = r.written.length + " written, " + r.deleted.length + " deleted, " + r.merged.length + " merged, " + r.absorbed.length + " absorbed"; if (r.from === r.to) console.log("Already level with " + to + " (" + r.to.slice(0, 9) + ")"); else console.log((r.ok ? "Levelled " : "Did not level ") + r.from.slice(0, 9) + " -> " + r.to.slice(0, 9) + " (" + to + "): " + counts); if (!r.ok) { console.log(r.reason); for (const c of r.conflicts) console.log("  " + c); } process.exit(r.ok ? 0 : 1)' "$to" "$co" "$last"; exit $? ;;
esac
exit 0
`;

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-personal-flow-e2e-")));
  const bin = path.join(sandbox, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "cast"), FAKE_CAST(path.join(import.meta.dir, "personalCheck.ts"), path.join(import.meta.dir, "landed.ts"), path.join(import.meta.dir, "..", "land", "level.ts")), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "$*" >> "$FAKE_STATE/gh.log"\nexit 1\n`, { mode: 0o755 });
  // git as itself, except a fetch while the test's world says origin cannot be read (it fails, or hangs).
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/bash\nfor a in "$@"; do if [ "$a" = fetch ]; then\n  [ -e "$FAKE_STATE/fetch-fails" ] && { echo "fatal: unable to access origin" >&2; exit 128; }\n  [ -e "$FAKE_STATE/fetch-hangs" ] && { sleep 30; exit 128; }\nfi; if [ "$a" = push ] && [ -e "$FAKE_STATE/push-hangs" ]; then sleep 30; exit 128; fi; if [ "$a" = push ] && [ -e "$FAKE_STATE/push-cut" ]; then exit 143; fi; done\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
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

// RECORD_PERSONAL_REPORTS=<file>: each test's progress reports, as the runner sent them, written to that file for the
// web's journey, diagram and report tests to replay through the server's merge (web lib/ship/__tests__/replayReports.ts).
// `bun packages/web/scripts/record-personal-reports.ts` runs this suite with it.
const RECORD = process.env.RECORD_PERSONAL_REPORTS;
const recorded: Record<string, object[]> = {};
/** What the server merges of a progress report into the run (convex workflow_runs.ts updateProgress). */
const REPORT_FIELDS = ["current_node_id", "node_id", "node_status", "outcome", "session_id", "run_status", "fail_reason", "result_preview", "visits", "waiting_on_session"];
// One list of calls per run the test starts (each world's server), so a test of several runs records each.
let recording: Array<Array<{ route: string; body: any }>> = [];
const test = (name: string, fn: () => unknown, timeout?: number) => bunTest(name, async () => {
  recording = [];
  await fn();
  if (!RECORD) return;
  const runs = recording.map((calls) => calls.filter((c) => c.route === "/cli/workflow-runs/progress")
    .map((c) => JSON.parse(JSON.stringify(Object.fromEntries(REPORT_FIELDS.filter((k) => k in c.body).map((k) => [k, c.body[k]]))).split(sandbox).join("<sandbox>"))))
    .filter((r) => r.length);
  runs.forEach((r, i) => { recorded[runs.length > 1 ? `${name} (run ${i + 1})` : name] = r; });
}, timeout);
afterAll(() => { if (RECORD) fs.writeFileSync(RECORD, `${JSON.stringify(recorded, null, 1)}\n`); });

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV } }).trim();
// The world's own commits are an hour old, so a session's writes (seconds ago) read as uncommitted edits after them.
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
const gitOld = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: HOUR_AGO, GIT_COMMITTER_DATE: HOUR_AGO } }).trim();

const CHECK = "./check.sh";
const FOUND = { outcome: "found", note: "README.md says ./check.sh is the gate", commands: [{ run: CHECK, cwd: ".", source: "README.md:3" }] };
const NOTHING = { outcome: "skipped", note: "No check documented: looked at README.md and the repo root; nothing calls a script the gate.", commands: [] };
const SHIP = { verdict: "ship", findings: [] };
const STALE = { stale: true };
const REJECTED = { verdict: "rejected", findings: ["blocker a.txt:1 the task should not be done at all"] };
const LIVE = { outcome: "live", note: "ran ./deploy.sh and saw the commit live", seen_live: "deploy.log names it", commands: [{ run: "./deploy.sh", cwd: ".", source: "README.md:4", exit: 0 }], left_for_you: null };
const FAILED = { ...LIVE, outcome: "failed", note: "./deploy.sh exited 1: no such host", seen_live: null, commands: [{ ...LIVE.commands[0], exit: 1 }] };

type World = ReturnType<typeof world>;
let worlds = 0;
/**
 * A personal repo with a bare origin. The change is the session's: committed on `feat` and run with `--branch feat`,
 * or (`own`) its uncommitted edits in the person's checkout, the Ship button's default, which the run freezes onto
 * fresh upstream as `cast flow run change` does. `edit` writes a file as the session, its transcript and the sync
 * ledger saying so.
 */
function world(answers: { find: object; review?: object[]; deploy?: object[]; content?: string; extra?: Record<string, string>; own?: boolean; base?: Record<string, string>; drop?: string[] }) {
  const base = path.join(sandbox, `w${++worlds}`);
  const origin = path.join(base, "origin.git");
  const root = path.join(base, "repo");
  const state = path.join(base, "state");
  fs.mkdirSync(state, { recursive: true });
  process.env.CODECAST_DIR = path.join(base, ".codecast");
  process.env.FAKE_STATE = state;
  fs.writeFileSync(path.join(state, "calls.log"), "");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  fs.mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "a.txt"), "base\n");
  fs.writeFileSync(path.join(root, "README.md"), "# app\n\nCheck: run `./check.sh` before landing.\nDeploy: `./deploy.sh`.\n");
  fs.writeFileSync(path.join(root, "check.sh"), `#!/bin/sh\ngrep -qx good a.txt || { echo "a.txt says $(cat a.txt), expected good" >&2; exit 1; }\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "deploy.sh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  for (const [f, text] of Object.entries(answers.base ?? {})) fs.writeFileSync(path.join(root, f), text);
  fs.appendFileSync(path.join(root, ".git", "info", "exclude"), ".codecast/worktrees/\n");
  gitOld(root, "add", "-A");
  gitOld(root, "commit", "-qm", "base");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "-u", "origin", "main");
  git(root, "fetch", "-q", "origin");
  const lines: object[] = [];
  const edit = (file: string, text: string) => {
    fs.writeFileSync(path.join(root, file), text);
    const sessionId = `sess-s-${worlds}`;
    lines.push({ type: "assistant", timestamp: new Date().toISOString(), cwd: root, message: { role: "assistant", content: [{ type: "tool_use", id: `t${Math.random()}`, name: "Edit", input: { file_path: path.join(root, file), old_string: "x", new_string: "y" } }] } });
    const tdir = path.join(sandbox, ".claude", "projects", `-w${worlds}`);
    fs.mkdirSync(tdir, { recursive: true });
    const tfile = path.join(tdir, `${sessionId}.jsonl`);
    fs.writeFileSync(tfile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const ledgerFile = path.join(process.env.CODECAST_DIR!, "sync-ledger.json");
    fs.mkdirSync(process.env.CODECAST_DIR!, { recursive: true });
    fs.writeFileSync(path.join(process.env.CODECAST_DIR!, "session-links.json"), JSON.stringify({ [sessionId]: { conversation_id: CONV, team_visible: true, checked_at: Date.now() } }));
    fs.writeFileSync(ledgerFile, JSON.stringify({ [tfile]: { lastSyncedAt: Date.now(), lastSyncedPosition: 0, messageCount: lines.length, conversationId: CONV, sourceGeneration: { client: "claude", sessionId, dev: 0, ino: 0, birthtimeMs: 0, unit: "bytes", watermark: 0, prefixProven: true } } }));
  };
  const branch = answers.own ? "codecast/change-ct-9" : "feat";
  if (answers.own) {
    edit("a.txt", answers.content ?? "good\n");
  } else {
    git(root, "checkout", "-q", "-b", "feat");
    fs.writeFileSync(path.join(root, "a.txt"), answers.content ?? "good\n");
    for (const [f, text] of Object.entries(answers.extra ?? {})) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), text);
    }
    for (const f of answers.drop ?? []) fs.rmSync(path.join(root, f));
    git(root, "add", "-A");
    git(root, "commit", "-qm", "the change");
    git(root, "checkout", "-q", "main");
  }
  const wt = path.join(root, ".codecast", "worktrees", "change-ct-9");
  if (!answers.own) git(root, "worktree", "add", "-q", wt, "feat");
  process.env.FAKE_WT = wt;
  // The worktree holds the branch, so the session commits from elsewhere: here, with plumbing, one file at a time.
  const commit = (file: string, text: string, msg: string) => {
    const index = path.join(state, "index");
    const env = { ...process.env, ...ENV, GIT_INDEX_FILE: index };
    execFileSync("git", ["-C", root, "read-tree", "feat"], { env });
    const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: text, encoding: "utf-8" }).trim();
    execFileSync("git", ["-C", root, "update-index", "--add", "--cacheinfo", `100755,${blob},${file}`], { env });
    const tree = execFileSync("git", ["-C", root, "write-tree"], { env, encoding: "utf-8" }).trim();
    git(root, "update-ref", "refs/heads/feat", git(root, "commit-tree", tree, "-p", "feat", "-m", msg));
  };
  // Someone else lands on origin's main, by default in a file the change does not touch.
  const pushElsewhere = (file = "b.txt", text = "theirs\n") => {
    const other = path.join(base, "other");
    if (!fs.existsSync(other)) execFileSync("git", ["clone", "-q", origin, other], { env: { ...process.env, ...ENV } });
    git(other, "pull", "-q", "origin", "main");
    fs.writeFileSync(path.join(other, file), text);
    git(other, "add", "-A");
    git(other, "commit", "-qm", "someone else");
    git(other, "push", "-q", "origin", "HEAD:main");
  };
  // The session puts its change on origin's default branch itself: its branch, or its edits committed in the checkout.
  const pushMain = () => {
    if (!answers.own) return git(root, "push", "-q", "origin", "feat:main");
    git(root, "commit", "-qam", "the session lands it itself");
    git(root, "push", "-q", "origin", "main");
  };
  const calls = () => fs.readFileSync(path.join(state, "calls.log"), "utf-8").trim().split("\n").filter(Boolean).map((l) => l.split(" ").slice(0, 2).join(" "));
  const gh = () => (fs.existsSync(path.join(state, "gh.log")) ? fs.readFileSync(path.join(state, "gh.log"), "utf-8") : "");
  const runDir = lineRunDir(root, runSlug(parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.personal), { task_id: "ct-9" }, "run"));
  return {
    root, origin, wt, runDir, commit, edit, pushElsewhere, pushMain, calls, gh, branch, own: !!answers.own,
    find: answers.find, reviews: [...(answers.review ?? [])], deploys: [...(answers.deploy ?? [])],
    /** What the session does with a brief; by default it makes a.txt good. */
    fix: (_brief: string) => (answers.own ? edit("a.txt", "good\n") : commit("a.txt", "good\n", "make a.txt good")),
    log: [] as string[],
    /** Called when a reviewer is spawned, with how many have been. */
    onReview: (_n: number) => {},
    /** Called when Deploy is spawned. */
    onDeploy: () => {},
    /** Called when Find check is spawned, before Check runs. */
    onFind: () => {},
    originMain: () => execFileSync("git", ["-C", origin, "rev-parse", "main"], { encoding: "utf-8" }).trim(),
    onMain: (file: string) => execFileSync("git", ["-C", origin, "show", `main:${file}`], { encoding: "utf-8" }),
  };
}

/** How the run ends when the session's turn leaves nothing of the change above origin (before anything landed). */
const GONE = "The change left the run: nothing of it is above origin/main any more. This run landed and deployed nothing.";

/** A message that asks the session to work: not how the run ended. */
const isBrief = (body: string) => !/ is over: | stopped at /.test(body);

/** The server: Find check, each reviewer and Deploy pin the world's answers; the session fixes when a brief reaches it. */
function server(w: World) {
  const calls: Array<{ route: string; body: any }> = [];
  recording.push(calls);
  const spawned: Array<{ kind: "find" | "review" | "deploy"; prompt: string }> = [];
  const pins = new Map<string, object>();
  let messages = 10;
  globalThis.fetch = (async (url: any, init: any) => {
    const route = String(url).replace(/^https?:\/\/[^/]+/, "");
    const body = structuredClone(JSON.parse(init?.body || "{}"));
    calls.push({ route, body });
    const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (route === "/cli/work/get") return reply({ title: "Make a.txt good", status: "in_progress" });
    if (route === "/cli/spawn") {
      const prompt = String(body.prompt);
      const kind = prompt.includes("You are the Find check station") ? "find" : prompt.includes("You are the Deploy station") ? "deploy" : "review";
      spawned.push({ kind, prompt });
      const id = `conv_${kind}_${spawned.length}`;
      let result: object;
      if (kind === "find") { w.onFind(); result = w.find; }
      // Deploy pins the landed sha its prompt names, as the real one copies it, unless the answer says another.
      else if (kind === "deploy") { w.onDeploy(); result = { sha: /"sha": "([^"]+)"/.exec(prompt)?.[1], ...(w.deploys.shift() ?? LIVE) }; }
      else {
        w.onReview(spawned.filter((s) => s.kind === "review").length);
        // The reviewer pins the round and head its prompt names, as the real one copies them.
        const round = /"round": "([^"]+)"/.exec(prompt)?.[1];
        const head_sha = /"head_sha": "([^"]+)"/.exec(prompt)?.[1];
        const next = w.reviews.shift() ?? SHIP;
        // A stale pin carries another round's nonce, as one kept from an earlier round would.
        result = next === STALE ? { ...SHIP, round: "round0", head_sha } : { ...next, round, head_sha };
      }
      pins.set(id, { state: "Done", status: "done", result: JSON.stringify(result), at: Date.now() });
      return reply({ conversation_id: id, short_id: `${kind}${spawned.length}` });
    }
    if (route === "/cli/inbox") {
      const id = body.session_ids?.[0];
      return reply({ sessions: [{ id, work_state: "done", is_live: id === CONV, is_killed: false, message_count: id === CONV ? messages : 4 }] });
    }
    if (route === "/cli/sessions/state/get") return reply(pins.get(body.session) ?? null);
    if (route === "/cli/messages/send") {
      if (body.to === CONV && isBrief(body.body)) w.fix(body.body);
      messages += 3;
      return reply({ ok: true });
    }
    return reply({ ok: true });
  }) as typeof fetch;
  const sent = () => calls.filter((c) => c.route === "/cli/messages/send").map((c) => c.body);
  return {
    calls,
    spawned: (kind: "find" | "review" | "deploy") => spawned.filter((s) => s.kind === kind),
    sent,
    briefs: () => sent().filter((m) => isBrief(m.body)).map((m) => m.body as string),
    /** How often a station started, as the runner reports it. */
    ran: (node: string) => calls.filter((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_id === node && c.body.node_status === "running" && c.body.current_node_id === node).length,
    result: (node: string) => [...calls].reverse().find((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_id === node && c.body.result_preview)?.body.result_preview as string | undefined,
  };
}

async function run(w: World, tweak?: (graph: ReturnType<typeof parseWorkflowSource>) => void) {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.personal);
  tweak?.(graph);
  if (w.own) {
    // As `cast flow run change` freezes a session's own edits: a commit on fresh upstream, on the run's branch and tree.
    const change = await freezeSessionChange(w.root, CONV, { branch: w.branch, worktree: "change-ct-9" });
    git(w.root, "worktree", "add", "-q", w.wt, w.branch);
    writeFrozenChange(w.runDir, change);
  } else {
    const tip = git(w.root, "rev-parse", "feat");
    writeFrozenChange(w.runDir, { source: "branch", session: CONV.slice(0, 7), conversation: CONV, base: tip, tip, branch: "feat", worktree: "change-ct-9", paths: ["a.txt"], shared: [], held: [] });
  }
  // What the runner printed, so a test can read what it decided about the session the change came from.
  w.log.length = 0;
  console.log = (...a: unknown[]) => { w.log.push(a.join(" ")); if (process.env.SHOW_RUN) origLog(...a); };
  try {
    return await runWorkflow(graph, { cwd: w.root, taskId: "ct-9", runId: "run-9", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 });
  } finally {
    console.log = origLog;
  }
}

/** `cast workflow resume ct-9 --at <station>` as the runner sees it: the same run, picked up at the station as a new attempt. */
async function resumeAt(w: World, at: string) {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.personal);
  // The CLI first checks the station against the run's graph (resumeFailed.ts resumeStation).
  expect(resumeStation(graph, at, { runId: "run-9", projectPath: w.root, here: true }).at).toBe(at);
  w.log.length = 0;
  console.log = (...a: unknown[]) => { w.log.push(a.join(" ")); if (process.env.SHOW_RUN) origLog(...a); };
  try {
    return await runWorkflow(graph, { cwd: w.root, taskId: "ct-9", runId: "run-9", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, resume: { status: "failed", current_node_id: at, node_statuses: [], visits_reset_at: Date.now() + 5 } as any });
  } finally {
    console.log = origLog;
  }
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8"));

/** Landed: origin's main is the run's merge, carries the change, and the person's checkout caught up to it. */
function expectLanded(w: World) {
  const main = w.originMain();
  expect(readJson(path.join(w.runDir, "merge.json")).sha).toBe(main);
  expect(w.onMain("a.txt")).toBe("good\n");
  expect(git(w.root, "rev-parse", "HEAD")).toBe(main);
  expect(fs.readFileSync(path.join(w.root, "a.txt"), "utf-8")).toBe("good\n");
  // No pull request, no CI, no merge station, ever.
  expect(w.gh()).toBe("");
  expect(w.calls().filter((c) => /^flow (pr|ci|merge|verdicts|await-deploy)$/.test(c))).toEqual([]);
}

describe("the shipped personal flow", () => {
  test("the builtin reads the same as the template run from disk", () => {
    const onDisk = parseWorkflowFile(path.join(import.meta.dir, "templates", "personal.cast"));
    expect(graphHash(onDisk)).toBe(graphHash(parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.personal)));
  });

  test("a passing check and a ship verdict land on origin's main, with no pull request, and deploy from the landed sha", async () => {
    const w = world({ find: FOUND, review: [SHIP], deploy: [LIVE] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expectLanded(w);
    expect(s.briefs()).toEqual([]);
    expect(s.spawned("find")).toHaveLength(1);
    // The reviewer is told the round's nonce and the head it judges, which Land pushed.
    const round = readJson(path.join(w.runDir, "round.json"));
    expect(s.spawned("review")[0].prompt).toContain(`"round": "${round.round}"`);
    // Its node shows the verdict it pinned (output="json"), before Verdicts runs.
    expect(JSON.parse(s.result("review")!)).toEqual({ verdict: "ship", findings: [], round: round.round, head_sha: round.head_sha });
    expect(round.head_sha).toBe(w.originMain());
    // Check ran the documented command in the change's tree and recorded it.
    const check = readJson(path.join(w.runDir, "check.json"));
    expect(check).toMatchObject({ outcome: "pass", results: [{ run: CHECK, cwd: ".", source: "README.md:3", exit: 0 }] });
    // Land says what it did, and Deploy is told the landed sha.
    expect(JSON.parse(s.result("land")!)).toMatchObject({ outcome: "landed", sha: w.originMain() });
    expect(JSON.parse(s.result("land")!).note).toContain("caught up");
    // The checkout it catches up is named, as `cast land level --checkout` takes it.
    expect(fs.readFileSync(path.join(process.env.FAKE_STATE!, "calls.log"), "utf-8")).toContain(`land level --checkout ${w.root} --to ${w.originMain()}`);
    expect(s.spawned("deploy")[0].prompt).toContain(`The landed commit: ${w.originMain()}`);
    expect(s.sent().at(-1).body).toContain("The Ship run on ct-9 is over: Live.");
  }, 120_000);

  test("a red check goes back to the session as one brief; its fix comes round again and lands", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], content: "bad\n" });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const [brief, ...more] = s.briefs();
    expect(more).toEqual([]);
    expect(brief).toContain("check fail, review ship");
    expect(brief).toContain('"exit":1');
    expect(brief).toContain("README.md:3");
    expect(brief).toContain("a.txt says bad, expected good");
    expect(s.ran("round")).toBe(2);
    // The docs are read once a run; the second round runs the same check on the fix.
    expect(s.spawned("find")).toHaveLength(1);
    expect(s.spawned("review")).toHaveLength(2);
    expect(readJson(path.join(w.runDir, "check.json")).outcome).toBe("pass");
    expectLanded(w);
  }, 120_000);

  test("a check the docs do not name is Skipped with its note, and the change lands on the review alone", async () => {
    const w = world({ find: NOTHING, review: [SHIP] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    // Both Find check and Check show Skipped with the note, as the run view reads a station's result.
    expect(JSON.parse(s.result("find_check")!)).toMatchObject({ outcome: "skipped", note: NOTHING.note });
    expect(JSON.parse(s.result("check")!)).toEqual({ outcome: "skipped", note: NOTHING.note, results: [] });
    expect(s.briefs()).toEqual([]);
    expectLanded(w);
  }, 120_000);

  test("a failed deploy goes back to the session to fix the script, and the fix lands and deploys", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], deploy: [FAILED, LIVE] });
    w.fix = (brief) => {
      expect(brief).toContain("./deploy.sh exited 1: no such host");
      expect(brief).toContain("Work in your own checkout. Anything you leave in the run's worktree is carried into the change and lands on main.");
      w.commit("deploy.sh", "#!/bin/sh\nexit 0\n", "fix the deploy");
    };
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(1);
    expect(s.briefs()[0]).toContain("documented deploy failed");
    expect(s.ran("round")).toBe(2);
    expect(s.spawned("deploy")).toHaveLength(2);
    expect(w.onMain("deploy.sh")).toBe("#!/bin/sh\nexit 0\n");
    // The second deploy goes out from the fix's landed sha.
    expect(s.spawned("deploy")[1].prompt).toContain(`The landed commit: ${w.originMain()}`);
    expectLanded(w);
  }, 120_000);

  test("a deploy fix that leaves nothing new to land sends the run straight back to Deploy, which goes live", async () => {
    const w = world({ find: FOUND, review: [SHIP], deploy: [FAILED, LIVE] });
    // The session fixes what broke outside the repository: nothing on its branch changes.
    w.fix = (brief) => { expect(brief).toContain("documented deploy failed"); };
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(1);
    expect(s.spawned("deploy")).toHaveLength(2);
    // No new round: the same landed commit deploys again.
    expect(s.ran("round")).toBe(1);
    expect(s.ran("land")).toBe(1);
    expect(s.spawned("review")).toHaveLength(1);
    expect(s.spawned("deploy")[1].prompt).toContain(`The landed commit: ${w.originMain()}`);
    expect(s.sent().at(-1).body).toContain("is over: Live.");
    expectLanded(w);
  }, 120_000);

  test("a deploy that still fails after three fixes outside the repository stops the run failed, never Live", async () => {
    const w = world({ find: FOUND, review: [SHIP], deploy: [FAILED, FAILED, FAILED, FAILED] });
    w.fix = () => {};
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.briefs()).toHaveLength(3);
    expect(s.spawned("deploy")).toHaveLength(4);
    const end = s.sent().at(-1).body;
    expect(end).not.toContain("is over: Live");
    expect(end).toContain("stopped at");
    expect(end).toContain("sent the change back 3 times");
    expect(end).toContain("The change is on the default branch");
  }, 120_000);

  test("a briefed session that puts its change on main itself stops the run: it landed and deployed nothing", async () => {
    const w = world({ find: FOUND, review: [SHIP], content: "bad\n" });
    w.fix = () => { w.commit("a.txt", "good\n", "make a.txt good"); w.pushMain(); };
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.briefs()).toHaveLength(1);
    expect(s.ran("round")).toBe(2);
    expect(s.ran("land")).toBe(0);
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(s.sent().at(-1).body).toContain(`stopped at Left the run: ${GONE}`);
  }, 120_000);

  test("a deploy fix the session puts on main itself stops the run: the fix was not landed or deployed by it", async () => {
    const w = world({ find: FOUND, review: [SHIP], deploy: [FAILED, LIVE] });
    w.fix = () => { w.commit("deploy.sh", "#!/bin/sh\nexit 0\n", "fix the deploy"); w.pushMain(); };
    const s = server(w);
    expect(await run(w)).toBe("failed");
    const landed = /The landed commit: ([0-9a-f]{40})/.exec(s.spawned("deploy")[0].prompt)![1];
    expect(s.spawned("deploy")).toHaveLength(1);
    expect(s.ran("land")).toBe(1);
    const end = s.sent().at(-1).body;
    // The stop's words stand alone: nothing appended after them.
    expect(end).toEndWith(`stopped at Left the run: The fix left the run: nothing of it is above origin/main any more. This run landed ${landed} earlier and deployed nothing after it.`);
  }, 120_000);

  test("only a deploy that saw the landed sha running ends Live: the rest end Deployed, unverified or Landed", async () => {
    const ends: Array<[object, string]> = [
      [{ ...LIVE, outcome: "unverified", seen_live: null, note: "no version endpoint" }, "is over: Deployed, unverified."],
      [{ ...LIVE, sha: "0123456789abcdef0123456789abcdef01234567" }, "is over: Deployed, unverified."],
      [{ ...LIVE, seen_live: null }, "is over: Deployed, unverified."],
      [{ ...LIVE, outcome: "skipped", seen_live: null, commands: [], note: "No deploy documented: looked at README.md." }, "is over: Landed."],
    ];
    for (const [answer, end] of ends) {
      const w = world({ find: FOUND, review: [SHIP], deploy: [answer] });
      const s = server(w);
      expect(await run(w)).toBe("completed");
      expect(s.sent().at(-1).body).toContain(end);
      expectLanded(w);
    }
  }, 480_000);

  test("a check command that would run outside the change's tree is refused, never run", async () => {
    const w = world({ find: { ...FOUND, commands: [{ run: `touch ${sandbox}/escaped && ./check.sh`, cwd: "../..", source: "README.md:3" }] }, review: [SHIP] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(fs.existsSync(path.join(sandbox, "escaped"))).toBe(false);
    expect(s.sent().at(-1).body).toContain("stopped at Check did not run");
    expect(s.sent().at(-1).body).toContain("not inside the change's tree");
    expect(s.ran("land")).toBe(0);
  }, 120_000);

  test("a session that drops its change when briefed stops the run: old main is never deployed", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], content: "bad\n" });
    // It resets its branch to main: nothing of the change is left anywhere.
    w.fix = () => { git(w.root, "fetch", "-q", "origin"); git(w.root, "update-ref", "refs/heads/feat", git(w.root, "rev-parse", "origin/main")); };
    const s = server(w);
    const main = w.originMain();
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(w.originMain()).toBe(main);
    const end = s.sent().at(-1).body;
    // Its own words stand: no "not landed, run it again" after them.
    expect(end).toEndWith(`stopped at Left the run: ${GONE}`);
  }, 120_000);

  test("regression P1: a session that drops its change while someone else lands the same file stops, deploying nothing", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], content: "bad\n" });
    w.fix = () => { w.pushElsewhere("a.txt", "someone else's\n"); git(w.root, "fetch", "-q", "origin"); git(w.root, "update-ref", "refs/heads/feat", git(w.root, "rev-parse", "origin/main")); };
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(s.ran("land")).toBe(0);
    expect(s.sent().at(-1).body).toContain(`stopped at Left the run: ${GONE}`);
  }, 120_000);

  test("regression P2: a deploy fix committed in the repository comes round and lands while main moves elsewhere", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], deploy: [FAILED, LIVE] });
    w.fix = () => { w.pushElsewhere("b.txt", "x\n"); w.commit("deploy.sh", "#!/bin/sh\nexit 0\n", "fix the deploy"); };
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.ran("round")).toBe(2);
    expect(s.ran("land")).toBe(2);
    expect(s.spawned("review")).toHaveLength(2);
    expect(w.onMain("deploy.sh")).toBe("#!/bin/sh\nexit 0\n");
    expect(w.onMain("b.txt")).toBe("x\n");
    expect(s.spawned("deploy")[1].prompt).toContain(`The landed commit: ${w.originMain()}`);
    expect(s.sent().at(-1).body).toContain("is over: Live.");
  }, 120_000);

  test("regression P3: a session that lands a reworked change itself, in another file, stops: the run deployed nothing", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], content: "bad\n" });
    w.fix = () => { w.commit("a.txt", "base\n", "drop a.txt"); w.commit("c.txt", "the real change\n", "do it in c.txt"); w.pushMain(); };
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(w.onMain("c.txt")).toBe("the real change\n");
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(s.ran("land")).toBe(0);
    expect(s.sent().at(-1).body).toContain(`stopped at Left the run: ${GONE}`);
  }, 120_000);

  test("a deploy fix outside the repository deploys the run's own landing again, with its own note, after main moved", async () => {
    const w = world({ find: FOUND, review: [SHIP], deploy: [FAILED, LIVE] });
    w.pushElsewhere();
    w.fix = () => {};
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.ran("round")).toBe(1);
    expect(s.spawned("review")).toHaveLength(1);
    const [first, second] = s.spawned("deploy").map((d) => /The landed commit: ([0-9a-f]{40})/.exec(d.prompt)![1]);
    expect(second).toBe(first);
    expect(first).toBe(w.originMain());
    expect(JSON.parse(s.result("landed")!).note).toContain("pushed main");
    expect(JSON.parse(s.result("after_fix")!)).toMatchObject({ next: "deploy" });
    expect(s.sent().at(-1).body).toContain("is over: Live.");
    expectLanded(w);
  }, 120_000);

  test("a remote that refuses the push (a protected branch) stops at Not landed at once, never as main moving", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    fs.writeFileSync(path.join(w.origin, "hooks", "pre-receive"), "#!/bin/sh\necho protected branch >&2\nexit 1\n", { mode: 0o755 });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.ran("land")).toBe(1);
    expect(s.ran("round")).toBe(1);
    const end = s.sent().at(-1).body;
    // Land's own words, never its raw JSON.
    expect(end).toContain("stopped at Not landed: git push origin main failed:");
    expect(end).not.toContain('{"outcome"');
    expect(end).toContain("git push origin main failed");
    expect(end).toContain("remote rejected");
    // The push definitely failed: no marker says this run set out to push that head any more.
    expect(fs.existsSync(path.join(w.runDir, "land-pushing-run-9"))).toBe(false);
    // The personal Ship lands, and runs as change.
    expect(end).toContain("The change was not landed. Run it again with `cast flow run change` once it is ready.");
  }, 120_000);

  test("a push whose landing could not be recorded stops saying the push succeeded, never that nothing landed", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "landed-fails"), "");
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(w.onMain("a.txt")).toBe("good\n");
    const end = s.sent().at(-1).body;
    expect(end).toContain(`stopped at Landing not recorded: the push to origin/main succeeded at ${w.originMain().slice(0, 10)}, but recording it on the run failed: the server did not answer`);
    expect(end).toContain("The change is on the default branch");
    expect(end).not.toContain("not landed");
  }, 120_000);

  test("regression A: an own-edits deploy fix the session commits and pushes itself stops at Main moved, deploying nothing more", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], deploy: [FAILED, LIVE], own: true });
    w.fix = () => { w.edit("deploy.sh", "#!/bin/sh\nexit 0\n"); w.pushMain(); };
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(1);
    expect(s.ran("land")).toBe(1);
    expect(JSON.parse(s.result("after_fix")!).next).toBe("moved");
    const end = s.sent().at(-1).body;
    const landed = /The landed commit: ([0-9a-f]{40})/.exec(s.spawned("deploy")[0].prompt)![1];
    expect(end).toEndWith(`stopped at Main moved: A newer commit landed on top of ${landed.slice(0, 10)}, so this run deploys nothing rather than an older commit over it. Deploy the newest main the way the project deploys, or ship your next change, and its deploy will carry this one.`);
  }, 120_000);

  test("regression P: an own-edits deploy fix committed in the checkout but not pushed stops and says so, never dropped", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], deploy: [FAILED, LIVE], own: true });
    w.fix = () => { w.edit("deploy.sh", "#!/bin/sh\nexit 0\n"); git(w.root, "commit", "-qam", "fix deploy locally"); };
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(1);
    expect(JSON.parse(s.result("after_fix")!).next).toBe("unpushed");
    const end = s.sent().at(-1).body;
    expect(end).toContain("stopped at Fix not shipped");
    // The reset goes back to where the session's commit starts: the landing the checkout caught up to.
    expect(end).toEndWith(`stopped at Fix not shipped: 1 commit(s) made in your checkout since this run began that origin/main lacks. This run ships uncommitted edits only, so it can't take them, and it deployed nothing more. To ship them, turn them back into uncommitted edits (\`git reset --soft ${git(w.root, "rev-parse", "HEAD~1").slice(0, 12)}\`) and Ship again.`);
    expect(end).toContain("Ship again");
  }, 120_000);

  test("regression S: an own-edits session that commits its fix after a red check stops at Fix not shipped, saying so plainly", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], own: true, content: "bad\n" });
    w.fix = (brief) => {
      // The brief tells it to leave the fix uncommitted; this one commits anyway, as a global rule might tell it to.
      expect(brief).toContain("Leave the fix as uncommitted edits in this checkout, and do not commit or push it");
      w.edit("a.txt", "good\n");
      git(w.root, "commit", "-qam", "fix locally");
    };
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(s.ran("land")).toBe(0);
    expect(JSON.parse(s.result("committed")!).next).toBe("unpushed");
    const end = s.sent().at(-1).body;
    // The reset goes back to the run's baseline: the checkout as the run began.
    expect(end).toEndWith(`stopped at Fix not shipped: 1 commit(s) made in your checkout since this run began that origin/main lacks. This run ships uncommitted edits only, so it can't take them, and it landed and deployed nothing of them. To ship them, turn them back into uncommitted edits (\`git reset --soft ${fs.readFileSync(path.join(w.runDir, "checkout-run-9"), "utf-8").trim().slice(0, 12)}\`) and Ship again.`);
    expect(end).not.toContain("Could not freeze");
  }, 120_000);

  test("regression U2: Deploy runs in a worktree at the landed commit with nothing the Check left in it", async () => {
    const w = world({ find: { ...FOUND, commands: [{ run: "./check.sh && echo formatted >> README.md && echo junk > stray.txt", cwd: ".", source: "README.md:3" }] }, review: [SHIP] });
    const seen: string[] = [];
    w.onDeploy = () => seen.push(`${git(w.wt, "rev-parse", "HEAD")} ${git(w.wt, "status", "--porcelain")}`.trim());
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(seen).toEqual([w.originMain()]);
    expect(s.sent().at(-1).body).toContain("is over: Live.");
  }, 120_000);

  test("regression U3b: own edits rebased under Land, then a deploy fix outside the repository, deploys again by tree", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP, SHIP], deploy: [FAILED, LIVE], own: true });
    // m.txt joins main and origin; the session's edits (a.txt, and m.txt's line 2) stay uncommitted.
    fs.writeFileSync(path.join(w.root, "m.txt"), "1\n2\n3\n4\n5\n6\n7\n");
    gitOld(w.root, "add", "m.txt");
    gitOld(w.root, "commit", "-qm", "m");
    git(w.root, "push", "-q", "origin", "main");
    w.edit("m.txt", "1\nTWO\n3\n4\n5\n6\n7\n");
    // Main changes line 5 under Land: a clean rebase, a different patch.
    w.onReview = (n) => { if (n === 1) w.pushElsewhere("m.txt", "1\n2\n3\n4\nFIVE\n6\n7\n"); };
    w.fix = () => {};
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(JSON.parse(s.result("after_fix")!).next).toBe("deploy");
    const [first, second] = s.spawned("deploy").map((d) => /The landed commit: ([0-9a-f]{40})/.exec(d.prompt)![1]);
    expect(second).toBe(first);
    expect(w.onMain("m.txt")).toBe("1\nTWO\n3\n4\nFIVE\n6\n7\n");
    expect(s.sent().at(-1).body).toContain("is over: Live.");
  }, 180_000);

  test("regression U5: the person's own earlier unpushed commit is not taken for the session's fix", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], deploy: [FAILED, LIVE], own: true });
    fs.writeFileSync(path.join(w.root, "z.txt"), "mine\n");
    gitOld(w.root, "add", "z.txt");
    gitOld(w.root, "commit", "-qm", "local unpushed");
    w.pushElsewhere();
    w.fix = () => {};
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(JSON.parse(s.result("after_fix")!).next).toBe("deploy");
    expect(s.spawned("deploy")).toHaveLength(2);
    expect(s.sent().at(-1).body).toContain("is over: Live.");
  }, 180_000);

  test("Main keeps moving counts only the moves since the last landing", async () => {
    const w = world({ find: FOUND, review: Array(6).fill(SHIP), deploy: [FAILED, LIVE] });
    let pushes = 0;
    w.onReview = (n) => { if ([1, 3, 4, 5].includes(n)) w.pushElsewhere("b.txt", `theirs ${++pushes}\n`); };
    w.fix = () => w.commit("deploy.sh", "#!/bin/sh\nexit 0\n", "fix the deploy");
    const s = server(w);
    expect(await run(w)).toBe("completed");
    // Six visits to Land, four of them moves: one before the first landing, three after it.
    expect(s.ran("land")).toBe(6);
    expect(w.onMain("deploy.sh")).toBe("#!/bin/sh\nexit 0\n");
    expect(s.sent().at(-1).body).toContain("is over: Live.");
  }, 240_000);

  test("main that moves under Land four times in a row stops at Main keeps moving", async () => {
    const w = world({ find: FOUND, review: Array(4).fill(SHIP) });
    let pushes = 0;
    w.onReview = () => w.pushElsewhere("b.txt", `theirs ${++pushes}\n`);
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.ran("land")).toBe(4);
    expect(JSON.parse(s.result("land")!).moves).toBe(4);
    expect(s.sent().at(-1).body).toContain("stopped at Main keeps moving");
  }, 240_000);

  test("a Land run again on a head it set out to push, which origin already holds, goes straight to recording", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    // As a Land cut off after its push leaves it: origin at the round's head, and the pushing marker naming it.
    w.onReview = () => {
      git(w.wt, "push", "-q", "origin", "HEAD:main");
      fs.writeFileSync(path.join(w.runDir, "land-pushing-run-9"), `${git(w.wt, "rev-parse", "HEAD")}\n`);
    };
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.ran("land")).toBe(1);
    expect(s.ran("round")).toBe(1);
    expect(JSON.parse(s.result("land")!)).toMatchObject({ outcome: "landed", sha: w.originMain() });
    expectLanded(w);
  }, 120_000);

  test("regression H1: a push that lands on origin but loses its answer is a landing, recorded and deployed", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    // origin commits the ref, then the connection drops before the client hears it.
    const flag = path.join(w.origin, "hung-once");
    fs.writeFileSync(path.join(w.origin, "hooks", "reference-transaction"), `#!/bin/sh\n[ "$1" = committed ] || exit 0\n[ -e "${flag}" ] && exit 0\ngrep -q refs/heads/main || exit 0\ntouch "${flag}"\nkill -9 $PPID\nexit 0\n`, { mode: 0o755 });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(fs.existsSync(flag)).toBe(true);
    expect(s.ran("land")).toBe(1);
    expect(fs.readFileSync(path.join(w.runDir, "land-pushed-run-9"), "utf-8").trim()).toBe(w.originMain());
    expect(s.sent().at(-1).body).toContain("is over: Live.");
    expectLanded(w);
  }, 120_000);

  test("a newer commit landed on top before the first Deploy stops at Main moved, deploying nothing", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    const other = path.join(w.root, "..", "late");
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "after-land.sh"), `#!/bin/sh\nset -e\ngit clone -q "${w.origin}" "${other}"\ncd "${other}"\necho late > late.txt\ngit add late.txt\ngit -c user.name=t -c user.email=t@t commit -qm late\ngit push -q origin HEAD:main\n`, { mode: 0o755 });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(w.onMain("late.txt")).toBe("late\n");
    const end = s.sent().at(-1).body;
    const landed = JSON.parse(s.result("land")!).sha;
    expect(end).toEndWith(`stopped at Main moved: A newer commit landed on top of ${landed.slice(0, 10)}, so this run deploys nothing rather than an older commit over it. Deploy the newest main the way the project deploys, or ship your next change, and its deploy will carry this one.`);
  }, 120_000);

  test("r7 #3: a push whose answer is lost while origin cannot be read stops at Landing unknown, never Not landed", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    const flag = path.join(w.origin, "hung-once");
    fs.writeFileSync(path.join(w.origin, "hooks", "reference-transaction"), `#!/bin/sh\n[ "$1" = committed ] || exit 0\n[ -e "${flag}" ] && exit 0\ngrep -q refs/heads/main || exit 0\ntouch "${flag}"\ntouch "${process.env.FAKE_STATE}/fetch-fails"\nkill -9 $PPID\nexit 0\n`, { mode: 0o755 });
    const s = server(w);
    try {
      expect(await run(w)).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "fetch-fails"), { force: true });
    }
    const head = JSON.parse(fs.readFileSync(path.join(w.runDir, "round.json"), "utf-8")).head_sha;
    expect(w.originMain()).toBe(head);
    expect(s.spawned("deploy")).toHaveLength(0);
    // The marker stays, so a resume of this run takes the landing as its own.
    expect(fs.readFileSync(path.join(w.runDir, "land-pushing-run-9"), "utf-8").trim()).toBe(head);
    const end = s.sent().at(-1).body;
    expect(end).toContain(`stopped at Landing unknown: It is not known whether this run landed: the push of ${head.slice(0, 10)} to origin/main may have landed: its answer was lost (`);
    expect(end).toEndWith(`and origin could not be read to check. Check origin's main (\`git ls-remote origin main\`) once origin can be reached, then resume this run (\`cast workflow resume ct-9 --at land\`): it records the landing and carries on if ${head} landed, and pushes it again if not. Don't start a new Ship.`);
    expect(end).not.toContain("not landed");
    // The advice works: resumed at land, the run takes the landing as its own, records it, deploys it and ends Live.
    const s2 = server(w);
    expect(await resumeAt(w, "land")).toBe("completed");
    expect(s2.ran("round")).toBe(0);
    expect(JSON.parse(s2.result("land")!)).toMatchObject({ outcome: "landed", sha: head });
    expect(s2.spawned("deploy")[0].prompt).toContain(`The landed commit: ${head}`);
    expect(s2.sent().at(-1).body).toContain("is over: Live.");
    expectLanded(w);
  }, 180_000);

  test("r8 #1: a resumed Land that set out to push the head and still cannot read origin says Landing unknown again, never Not landed", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    const flag = path.join(w.origin, "hung-once");
    fs.writeFileSync(path.join(w.origin, "hooks", "reference-transaction"), `#!/bin/sh\n[ "$1" = committed ] || exit 0\n[ -e "${flag}" ] && exit 0\ngrep -q refs/heads/main || exit 0\ntouch "${flag}"\ntouch "${process.env.FAKE_STATE}/fetch-fails"\nkill -9 $PPID\nexit 0\n`, { mode: 0o755 });
    server(w);
    try {
      expect(await run(w)).toBe("failed");
      // Resumed while origin still cannot be read: it still cannot tell.
      const s2 = server(w);
      expect(await resumeAt(w, "land")).toBe("failed");
      const end = s2.sent().at(-1).body;
      expect(end).toContain("stopped at Landing unknown: It is not known whether this run landed: the push of ");
      expect(end).toContain("may have landed, and origin could not be read to check: fatal: unable to access origin");
      expect(end).not.toContain("Not landed");
      expect(JSON.parse(s2.result("land")!)).toMatchObject({ outcome: "unknown" });
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "fetch-fails"), { force: true });
    }
    // Once origin can be read, the same resume lands it.
    const s3 = server(w);
    expect(await resumeAt(w, "land")).toBe("completed");
    expect(s3.sent().at(-1).body).toContain("is over: Live.");
  }, 240_000);

  test("r7 #3: when the lost push never reached origin, resuming at land pushes it and lands", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    // origin refuses the ref before committing it and the connection drops; origin cannot be read either.
    const flag = path.join(w.origin, "dropped-once");
    fs.writeFileSync(path.join(w.origin, "hooks", "pre-receive"), `#!/bin/sh\n[ -e "${flag}" ] && exit 0\ntouch "${flag}"\ntouch "${process.env.FAKE_STATE}/fetch-fails"\nkill -9 $PPID\nexit 1\n`, { mode: 0o755 });
    const s = server(w);
    const main = w.originMain();
    try {
      expect(await run(w)).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "fetch-fails"), { force: true });
    }
    expect(w.originMain()).toBe(main);
    expect(s.sent().at(-1).body).toContain("stopped at Landing unknown");
    const head = JSON.parse(fs.readFileSync(path.join(w.runDir, "round.json"), "utf-8")).head_sha;
    const s2 = server(w);
    expect(await resumeAt(w, "land")).toBe("completed");
    expect(w.originMain()).toBe(head);
    expect(JSON.parse(s2.result("land")!)).toMatchObject({ outcome: "landed", sha: head });
    expect(s2.sent().at(-1).body).toContain("is over: Live.");
    expectLanded(w);
  }, 180_000);

  test("r6 #3: a change the session pushes itself during Check and Review left the run; it is never the run's landing", async () => {
    const w = world({ find: FOUND, review: [SHIP], deploy: [LIVE] });
    w.onReview = () => w.pushMain();
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(JSON.parse(s.result("land")!)).toMatchObject({ outcome: "left" });
    expect(s.sent().at(-1).body).toEndWith(`stopped at Left the run: ${GONE}`);
  }, 120_000);

  test("r6 #2: origin that cannot be read before Deploy stops the run, never deploying an older commit over a newer one", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    const other = path.join(w.root, "..", "late");
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "after-land.sh"), `#!/bin/sh\nset -e\ngit clone -q "${w.origin}" "${other}"\ncd "${other}"\necho late > late.txt\ngit add late.txt\ngit -c user.name=t -c user.email=t@t commit -qm late\ngit push -q origin HEAD:main\ntouch "$FAKE_STATE/fetch-fails"\n`, { mode: 0o755 });
    const s = server(w);
    try {
      expect(await run(w)).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "fetch-fails"), { force: true });
    }
    expect(s.spawned("deploy")).toHaveLength(0);
    const landed = JSON.parse(s.result("land")!).sha;
    expect(s.sent().at(-1).body).toEndWith(`stopped at Main unchecked: This run landed ${landed}, but could not check that origin/main still has it on top (git fetch origin main failed: fatal: unable to access origin), so it deploys nothing rather than risk an older commit over a newer one. Deploy the newest main the way the project deploys, or ship your next change, and its deploy will carry this one.`);
  }, 120_000);

  test("r6 #2: a Landed step that times out stops the run, never sending Deploy an empty sha", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "after-land.sh"), `#!/bin/sh\ntouch "$FAKE_STATE/fetch-hangs"\n`, { mode: 0o755 });
    const s = server(w);
    try {
      expect(await run(w, (g) => { g.nodes.get("landed")!.timeout = 3; })).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "fetch-hangs"), { force: true });
    }
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(s.sent().at(-1).body).toContain("stopped at Main unchecked: This run landed ");
  }, 120_000);

  test("r6 #1: a slow catch-up of the person's checkout is never cut off", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "level-slow"), "");
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(JSON.parse(s.result("land")!).note).toContain("caught up");
    expectLanded(w);
  }, 180_000);

  test("r8f: a catch-up that fails gives level's own reason and the one command that finishes it, once that is dealt with", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    // The person edited a file the landing changes, in a way that does not merge: level refuses and writes nothing.
    fs.writeFileSync(path.join(w.root, "a.txt"), "mine\n");
    fs.writeFileSync(path.join(w.root, "staged.txt"), "staged\n");
    git(w.root, "add", "staged.txt");
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const preview = s.result("land")!;
    const note = JSON.parse(preview).note as string;
    const sha = w.originMain();
    expect(preview.length).toBeLessThan(760);
    const command = /^Run `([^`]+)` to finish catching up the checkout once what level said is dealt with; it keeps every edit of yours\. /.exec(note)![1];
    expect(command).toBe(`cd ${w.root} && cast land level --checkout . --to ${sha.slice(0, 12)} --ref-last`);
    expect(note).toContain("was not caught up: Did not level ");
    expect(note).toContain("1 file(s) changed here and in");
    expect(note).toContain("without a clean merge a.txt");
    // HEAD never moved: nothing reads as undoing the landing.
    expect(git(w.root, "rev-parse", "HEAD")).not.toBe(sha);
    // Once the person deals with it (here, drops their edit), the command finishes it and keeps the rest of their work.
    git(w.root, "checkout", "--", "a.txt");
    execFileSync("bash", ["-c", command], { env: { ...process.env, ...ENV }, cwd: w.root });
    expect(git(w.root, "rev-parse", "HEAD")).toBe(sha);
    expect(fs.readFileSync(path.join(w.root, "a.txt"), "utf-8")).toBe("good\n");
    expect(execFileSync("git", ["-C", w.root, "status", "--porcelain"], { encoding: "utf-8" })).toBe("A  staged.txt\n");
  }, 120_000);

  test("r8f: a Land its station cuts off during the catch-up says the change landed, and resuming it finishes and deploys", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "level-slow"), "");
    const s = server(w);
    try {
      expect(await run(w, (g) => { g.nodes.get("land")!.timeout = 8; })).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "level-slow"), { force: true });
    }
    const head = JSON.parse(fs.readFileSync(path.join(w.runDir, "round.json"), "utf-8")).head_sha;
    expect(w.originMain()).toBe(head);
    const end = s.sent().at(-1).body;
    expect(end).toContain(`stopped at Land cut off: Land was cut off after it pushed ${head} to origin/main, so the change landed, but`);
    expect(end).not.toContain("may have landed");
    const s2 = server(w);
    expect(await resumeAt(w, "land")).toBe("completed");
    expect(JSON.parse(s2.result("land")!).note).toContain("caught up");
    expect(s2.sent().at(-1).body).toContain("is over: Live.");
    expectLanded(w);
  }, 180_000);

  test("r8f: a push cut off keeps the pushing marker and says Landing unknown, never Not landed", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "push-cut"), "");
    const s = server(w);
    try {
      expect(await run(w)).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "push-cut"), { force: true });
    }
    const head = JSON.parse(fs.readFileSync(path.join(w.runDir, "round.json"), "utf-8")).head_sha;
    expect(fs.readFileSync(path.join(w.runDir, "land-pushing-run-9"), "utf-8").trim()).toBe(head);
    const end = s.sent().at(-1).body;
    // Decided on its exit code: "did not finish" shows, whatever it printed.
    expect(end).toContain(`stopped at Landing unknown: It is not known whether this run landed: the push of ${head.slice(0, 10)} to origin/main was cut off (it did not finish in 180s) and is not on origin yet, but may still land.`);
    expect(end).not.toContain("Not landed");
  }, 120_000);

  test("r8c #3: a Land its station cuts off after it set out to push ends Landing unknown, never Not landed", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "push-hangs"), "");
    const s = server(w);
    try {
      expect(await run(w, (g) => { g.nodes.get("land")!.timeout = 4; })).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "push-hangs"), { force: true });
    }
    const head = JSON.parse(fs.readFileSync(path.join(w.runDir, "round.json"), "utf-8")).head_sha;
    const end = s.sent().at(-1).body;
    expect(end).toContain(`stopped at Landing unknown: It is not known whether this run landed: Land was cut off after it set out to push ${head} to origin/main, so the push may have landed.`);
    expect(end).not.toContain("Not landed");
  }, 120_000);

  test("r8c #4: a resumed Land that finds no worktree says so as the reason it cannot tell", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    const flag = path.join(w.origin, "hung-once");
    fs.writeFileSync(path.join(w.origin, "hooks", "reference-transaction"), `#!/bin/sh\n[ "$1" = committed ] || exit 0\n[ -e "${flag}" ] && exit 0\ngrep -q refs/heads/main || exit 0\ntouch "${flag}"\ntouch "${process.env.FAKE_STATE}/fetch-fails"\nkill -9 $PPID\nexit 0\n`, { mode: 0o755 });
    server(w);
    try {
      expect(await run(w)).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "fetch-fails"), { force: true });
    }
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "ws-gone"), "");
    const s2 = server(w);
    try {
      expect(await resumeAt(w, "land")).toBe("failed");
    } finally {
      fs.rmSync(path.join(process.env.FAKE_STATE!, "ws-gone"), { force: true });
    }
    const end = s2.sent().at(-1).body;
    expect(end).toContain("stopped at Landing unknown: It is not known whether this run landed: the push of ");
    expect(end).toContain("may have landed, and the run's worktree change-ct-9 is not on this machine to check.");
    expect(end).not.toContain("its answer was lost");
  }, 180_000);

  test("Check refuses a tree with changes of its own", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    w.onFind = () => fs.writeFileSync(path.join(w.wt, "stray.txt"), "x\n");
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.ran("land")).toBe(0);
    expect(s.sent().at(-1).body).toContain("stopped at Check did not run");
    expect(s.sent().at(-1).body).toContain("has changes of its own");
  }, 120_000);

  test("Check refuses a tree that is not at the round's head", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    w.onFind = () => git(w.wt, "commit", "-q", "--allow-empty", "-m", "a stray commit");
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.ran("land")).toBe(0);
    expect(s.sent().at(-1).body).toContain("stopped at Check did not run");
    expect(s.sent().at(-1).body).toContain("not the round's head");
  }, 120_000);

  test("the session the change came from is retired only from Live: never Deployed, unverified, Landed, or with a step left", async () => {
    const stays = /the session the change came from stays: the run ended at (.*)/;
    const ends: Array<[object, string | null]> = [
      [LIVE, null],
      [{ ...LIVE, outcome: "unverified", seen_live: null }, "the run ended at Deployed, unverified, which leaves something for a person"],
      [{ ...LIVE, outcome: "skipped", seen_live: null, commands: [] }, "the run ended at Landed, which leaves something for a person"],
      [{ ...LIVE, left_for_you: "Reload the extension." }, "the run ended at Live, past Left for you, which leaves something for a person"],
    ];
    for (const [answer, kept] of ends) {
      const w = world({ find: FOUND, review: [SHIP], deploy: [answer] });
      server(w);
      expect(await run(w)).toBe("completed");
      const said = w.log.find((l) => stays.test(l));
      if (kept) {
        expect(said).toContain(kept);
        expect(w.log.some((l) => /jx7ssss stays: /.test(l))).toBe(false);
      }
      else {
        expect(said).toBeUndefined();
        // From Live the runner goes on to ask whether it may retire it (here the harness's session stays, for its own reason).
        expect(w.log.some((l) => /jx7ssss stays: /.test(l))).toBe(true);
      }
    }
  }, 480_000);

  test("a deploy with one step left for the person ends Live, with that step on the task", async () => {
    const step = "Reload the extension at chrome://extensions.";
    const w = world({ find: FOUND, review: [SHIP], deploy: [{ ...LIVE, left_for_you: step }] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.sent().at(-1).body).toContain("is over: Live.");
    const log = fs.readFileSync(path.join(process.env.FAKE_STATE!, "calls.log"), "utf-8");
    expect(log).toContain(`task comment ct-9 One step left for you: ${step} -t review`);
    expect(JSON.parse(s.result("deploy")!)).toMatchObject({ outcome: "live", left_for_you: step });
    expectLanded(w);
  }, 120_000);

  test("main that moves under Land sends the change back to Round once, then it lands on the new main", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP] });
    w.onReview = (n) => { if (n === 1) w.pushElsewhere(); };
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.ran("round")).toBe(2);
    expect(s.ran("land")).toBe(2);
    expect(s.briefs()).toEqual([]);
    // What landed sits on the commit someone else pushed.
    expect(w.onMain("b.txt")).toBe("theirs\n");
    expectLanded(w);
  }, 120_000);

  test("a pin with another round's nonce asks the reviewer once more in that round, a second round included", async () => {
    const w = world({ find: FOUND, review: [SHIP, STALE, SHIP], content: "bad\n" });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(1);
    expect(s.spawned("review")).toHaveLength(3);
    expectLanded(w);
  }, 120_000);

  test("a reviewer that pins no verdict for the round twice stops the run, briefing nobody and landing nothing", async () => {
    const w = world({ find: FOUND, review: [STALE, STALE] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.briefs()).toEqual([]);
    expect(s.sent().at(-1).body).toContain("stopped at Review never finished");
    expect(w.originMain()).toBe(git(w.root, "rev-parse", "main"));
    expect(s.ran("land")).toBe(0);
  }, 120_000);

  test("a rejection ends the run at Rejected with the reviewer's reasons, and nothing lands", async () => {
    const w = world({ find: FOUND, review: [REJECTED] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.ran("land")).toBe(0);
    expect(s.sent().at(-1).body).toContain("stopped at Rejected");
    expect(s.sent().at(-1).body).toContain("the task should not be done at all");
  }, 120_000);

  test("a change that conflicts with main goes back to the session to resolve, then lands on the new main", async () => {
    const w = world({ find: FOUND, review: [SHIP] });
    w.pushElsewhere("a.txt", "theirs\n");
    // The session brings its change up to date: the change rebuilt on origin's main, keeping main's README.
    w.fix = (brief) => {
      expect(brief).toContain("conflicted in: a.txt");
      git(w.root, "fetch", "-q", "origin");
      const env = { ...process.env, ...ENV, GIT_INDEX_FILE: path.join(process.env.FAKE_STATE!, "index") };
      execFileSync("git", ["-C", w.root, "read-tree", "origin/main"], { env });
      const blob = execFileSync("git", ["-C", w.root, "hash-object", "-w", "--stdin"], { input: "good\n", encoding: "utf-8" }).trim();
      execFileSync("git", ["-C", w.root, "update-index", "--cacheinfo", `100644,${blob},a.txt`], { env });
      const tree = execFileSync("git", ["-C", w.root, "write-tree"], { env, encoding: "utf-8" }).trim();
      git(w.root, "update-ref", "refs/heads/feat", git(w.root, "commit-tree", tree, "-p", "origin/main", "-m", "the change, on main"));
    };
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(1);
    expect(s.ran("round")).toBe(2);
    expect(s.spawned("review")).toHaveLength(1);
    expectLanded(w);
  }, 120_000);

  test("a change to .codecast and .github lands with no card and no merge authority asked", async () => {
    const w = world({ find: FOUND, review: [SHIP], extra: { ".codecast/notes.md": "notes\n", ".github/workflows/ci.yml": "on: push\n" } });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.calls.filter((c) => /gate|decide|approval/.test(c.route))).toEqual([]);
    expect(w.onMain(".github/workflows/ci.yml")).toBe("on: push\n");
    expect(w.onMain(".codecast/notes.md")).toBe("notes\n");
    expectLanded(w);
  }, 120_000);
});

describe("the personal Check refuses what would leave the change's tree", () => {
  const tree = "/home/p/code/app/.codecast/worktrees/change-ct-9";
  const checkout = "/home/p/code/app";
  test("a directory outside the tree, by absolute path, ~ or .., is no directory to run in", () => {
    expect(commandDir(tree, ".")).toBe(tree);
    expect(commandDir(tree, "packages/cli")).toBe(`${tree}/packages/cli`);
    for (const cwd of [checkout, "/tmp", "~", "~/code/app", "..", "../..", "a/../../b"]) expect(commandDir(tree, cwd)).toBeNull();
  });
  test("a command that names the checkout or cds out of the tree is refused; one inside it is not", () => {
    expect(commandEscapes("bun test", tree, tree, checkout)).toBeNull();
    expect(commandEscapes(`bun test ${tree}/src`, tree, tree, checkout)).toBeNull();
    expect(commandEscapes("cd packages/cli && bun test", tree, tree, checkout)).toBeNull();
    expect(commandEscapes(`bash ${checkout}/check.sh`, tree, tree, checkout)).toContain("names the person's checkout");
    for (const run of ["cd .. && make", "cd /tmp; make", "cd && make", "cd ~/code/app && make", "pushd ../.. && make", "make; cd -"]) {
      expect(commandEscapes(run, tree, tree, checkout)).toContain("outside the change's tree");
    }
  });
  test("the home directory's spellings, a quoted cd, cd's flags and the checkout's path on its boundary", () => {
    // Under the real home directory, so ~ and $HOME name it.
    const home = os.homedir();
    const co = `${home}/code/app`;
    const t = `${co}/.codecast/worktrees/change-ct-9`;
    for (const run of [`"$HOME"/code/app/check.sh`, "${HOME}/code/app/check.sh", `cd "$HOME/code/app" && make`, `cd "\${HOME}/code/app"`, "bash ~/code/app/check.sh"]) {
      expect(commandEscapes(run, t, t, co)).toContain("names the person's checkout");
    }
    for (const run of [`bash -c "cd .. && make"`, `sh -c 'cd /tmp; make'`, "cd -- /tmp && make", "cd -P .. && make", "{ cd ..; make; }", "(cd ..; make)", "cd ..&&make", "cd\t..", "x=..; cd $x", "cd`echo ..`"]) {
      expect(commandEscapes(run, t, t, co)).toContain("outside the change's tree");
    }
    expect(commandEscapes(`bun test ${home}/code/app2/x`, t, t, co)).toBeNull();
    expect(commandEscapes(`cd ${t}/sub && make`, t, t, co)).toBeNull();
    expect(commandEscapes("cd -P sub && make", t, t, co)).toBeNull();
  });
  test("found with no command to run is an error, never Skipped; skipped stays Skipped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-check-"));
    try {
      expect(runCheck({ spec: JSON.stringify({ outcome: "found", note: "x", commands: [{ run: "  " }] }), tree: dir, dir })).toContain("named no command");
      expect(runCheck({ spec: JSON.stringify({ outcome: "skipped", note: "nothing documented", commands: [] }), tree: dir, dir })).toEqual({ outcome: "skipped", note: "nothing documented", results: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("which ends keep the session the change came from", () => {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.personal);
  const node = (id: string) => graph.nodes.get(id)!;
  test("Live keeps nothing; Deployed, unverified, Landed and a step left for the person keep it", () => {
    expect(subjectKept(graph, ["land", "landed", "deploy"], node("exit"))).toBeNull();
    expect(subjectKept(graph, ["land", "landed", "deploy"], node("unverified"))?.id).toBe("unverified");
    expect(subjectKept(graph, ["land", "landed", "deploy"], node("nodeploy"))?.id).toBe("nodeploy");
    expect(subjectKept(graph, ["land", "landed", "deploy", "left"], node("exit"))?.id).toBe("left");
    const change = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change);
    expect(subjectKept(change, ["merge", "landed"], change.nodes.get("exit")!)).toBeNull();
  });
});

describe("a session that lands its change itself", () => {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.personal);
  /** Where the runner goes from a station: the first conditional edge that holds, else its unconditional one. */
  const next = (from: string, context: Record<string, string>) => {
    const out = graph.edges.filter((e) => e.from === from);
    return (out.find((e) => e.condition && evalCondition(e.condition, context)) ?? out.find((e) => !e.condition))?.to;
  };
  test("a brief whose change left the run stops there; a deploy fix goes to After the fix; the runner never ends the run done", () => {
    for (const id of ["brief", "fix_conflict", "deploy_fix"]) expect(landedExitOf(graph, graph.nodes.get(id)!, { change_landed: "abc1234567" })).toBeNull();
    for (const id of ["brief", "fix_conflict"]) {
      expect(next(id, { change_landed: "abc1234567" })).toBe("leftrun");
      expect(next(id, {})).toBe("round");
    }
    expect(next("deploy_fix", { change_landed: "abc1234567" })).toBe("after_fix");
    expect(next("deploy_fix", {})).toBe("after_fix");
    expect(next("after_fix", { outcome: "success", "after_fix.json": '{"next":"deploy"}' })).toBe("deploy");
    expect(next("after_fix", { outcome: "success", "after_fix.json": '{"next":"round"}' })).toBe("round");
    // A reviewer asked again is bounded by verdicts_at, which a resume (Verdicts' visits start again) never strands.
    const noPin = { "check.json": '{"outcome":"pass"}', "round.json": '{"round":"r1","verdicts_at":5}', "review.json": '{"verdict":"ship","round":"r0"}' };
    expect(next("verdicts", { ...noPin, "verdicts.visits": "1" })).toBe("review");
    expect(next("verdicts", { ...noPin, "verdicts.visits": "6" })).toBe("unreviewed");
  });
  test("a flow whose fix station does not route it still ends done there", () => {
    const change = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change);
    expect(landedExitOf(change, change.nodes.get("brief")!, { change_landed: "abc1234567" })?.label).toBe("Live");
  });
});

describe("the session's own uncommitted edits, the Ship button's default", () => {
  test("are frozen onto origin's main, checked, reviewed, landed and deployed, and the checkout caught up", async () => {
    const w = world({ find: FOUND, review: [SHIP], own: true });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toEqual([]);
    expect(JSON.parse(s.result("land")!)).toMatchObject({ outcome: "landed", sha: w.originMain() });
    expect(s.sent().at(-1).body).toContain("is over: Live.");
    // The session's edit is on main and the checkout has nothing uncommitted left of it.
    expectLanded(w);
    expect(git(w.root, "status", "--porcelain", "--", "a.txt")).toBe("");
  }, 120_000);

  test("a red check goes back to the session, which fixes its own edits, and the fix lands", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], own: true, content: "bad\n" });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(1);
    expect(s.ran("round")).toBe(2);
    expect(s.spawned("review")).toHaveLength(2);
    expectLanded(w);
  }, 120_000);

  test("a session that commits and pushes its edits to main itself stops the run: it landed and deployed nothing", async () => {
    const w = world({ find: FOUND, review: [SHIP], own: true, content: "bad\n" });
    w.fix = () => { w.edit("a.txt", "good\n"); w.pushMain(); };
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.ran("land")).toBe(0);
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(s.sent().at(-1).body).toContain(`stopped at Left the run: ${GONE}`);
  }, 120_000);

  test("a deploy fix outside the repository deploys the run's own landing again, after main moved", async () => {
    const w = world({ find: FOUND, review: [SHIP], deploy: [FAILED, LIVE], own: true });
    w.pushElsewhere();
    w.fix = () => {};
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.ran("round")).toBe(1);
    const [first, second] = s.spawned("deploy").map((d) => /The landed commit: ([0-9a-f]{40})/.exec(d.prompt)![1]);
    expect(second).toBe(first);
    expect(JSON.parse(s.result("after_fix")!)).toMatchObject({ next: "deploy" });
    expect(s.sent().at(-1).body).toContain("is over: Live.");
    expectLanded(w);
  }, 120_000);

  test("a session that reverts its own edits when briefed never reaches Deploy", async () => {
    const w = world({ find: FOUND, review: [SHIP, SHIP], own: true, content: "bad\n" });
    w.fix = () => w.edit("a.txt", "base\n");
    const s = server(w);
    const main = w.originMain();
    expect(await run(w)).toBe("failed");
    expect(s.spawned("deploy")).toHaveLength(0);
    expect(w.originMain()).toBe(main);
    expect(s.sent().at(-1).body).toContain(`stopped at Left the run: ${GONE}`);
  }, 120_000);
});

describe("a person's checkout that is a linked worktree", () => {
  test("the run's baseline, its unpushed check and Land read that worktree, never the main one", async () => {
    const base = path.join(sandbox, "linked");
    const origin = path.join(base, "origin.git");
    const main = path.join(base, "main");
    const linked = path.join(base, "linked-wt");
    const state = path.join(base, "state");
    fs.mkdirSync(state, { recursive: true });
    process.env.FAKE_STATE = state;
    fs.writeFileSync(path.join(state, "calls.log"), "");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    fs.mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(main, "a.txt"), "base\n");
    fs.appendFileSync(path.join(main, ".git", "info", "exclude"), ".codecast/worktrees/\n");
    git(main, "add", "-A");
    git(main, "commit", "-qm", "base");
    git(main, "remote", "add", "origin", origin);
    git(main, "push", "-q", "-u", "origin", "main");
    // The person works in a linked worktree on its own branch; the run's tree hangs off it.
    git(main, "worktree", "add", "-q", "-b", "work", linked, "origin/main");
    git(main, "branch", "-q", "change", "origin/main");
    const wt = path.join(linked, ".codecast", "worktrees", "change-ct-9");
    git(main, "worktree", "add", "-q", wt, "change");
    fs.writeFileSync(path.join(wt, "a.txt"), "good\n");
    git(wt, "commit", "-qam", "the change");
    process.env.FAKE_WT = wt;
    const runDir = path.join(base, "run");
    fs.mkdirSync(runDir);
    writeFrozenChange(runDir, { source: "session", session: "s", conversation: CONV, base: "", tip: git(wt, "rev-parse", "HEAD"), branch: "change", worktree: "change-ct-9", paths: ["a.txt"], shared: [], held: [] });
    const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.personal);
    const ctx: Record<string, string> = { run_dir: runDir, run_id: "run-9", default_branch: "main", worktree: "change-ct-9", branch: "change" };
    const station = async (id: string) => {
      ctx["station_id"] = id;
      const log = console.log;
      console.log = () => {};
      try { return await executeCommand(graph.nodes.get(id)!, ctx, linked); } finally { console.log = log; }
    };
    expect(await station("round")).toBe("success");
    expect(fs.readFileSync(path.join(runDir, "checkout-run-9"), "utf-8").trim()).toBe(git(linked, "rev-parse", "HEAD"));
    // Land levels nothing in the main worktree and names the linked one, which is on its own branch.
    const mainHead = git(main, "rev-parse", "HEAD");
    expect(await station("land")).toBe("success");
    expect(JSON.parse(ctx["land.output"]).note).toContain(`${linked} is on work, not main`);
    expect(git(main, "rev-parse", "HEAD")).toBe(mainHead);
    // A commit the person's session makes in the linked worktree is what Fix not shipped counts; the main one's are not.
    fs.writeFileSync(path.join(main, "elsewhere.txt"), "x\n");
    git(main, "add", "elsewhere.txt");
    git(main, "commit", "-qm", "in the main worktree");
    ctx["last_error"] = "Could not freeze";
    expect(await station("committed")).toBe("failure");
    fs.writeFileSync(path.join(linked, "fix.txt"), "x\n");
    git(linked, "add", "fix.txt");
    git(linked, "commit", "-qm", "the session's fix");
    expect(await station("committed")).toBe("success");
    expect(JSON.parse(ctx["committed.output"])).toMatchObject({ next: "unpushed" });
    expect(JSON.parse(ctx["committed.output"]).note).toStartWith("1 commit(s) made in your checkout since this run began");
    expect(JSON.parse(ctx["committed.output"]).note).toContain(`(\`git reset --soft ${git(linked, "rev-parse", "HEAD~1").slice(0, 12)}\`)`);
    // With no baseline to name, the advice resets to origin's and says what else that uncommits.
    fs.rmSync(path.join(runDir, "checkout-run-9"));
    expect(await station("committed")).toBe("success");
    expect(JSON.parse(ctx["committed.output"]).note).toContain("(`git reset --soft origin/main`; this also uncommits any earlier unpushed commits)");
  }, 120_000);
});

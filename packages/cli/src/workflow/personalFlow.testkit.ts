// The harness of the personal flow's end to end tests (flows.md FL4): the shipped `personal` flow run by the real
// runner on real git, with a local bare repository as origin. Its stations' commands are a fake `cast` on PATH that
// runs the real pieces: Check runs the commands Find check pinned (personalCheck.ts), Land's record is the real
// `cast flow landed` and the checkout catches up through the real `cast land level`. The server is a fake that plays
// Find check, the reviewer (pinning the round's nonce as its prompt asks), Deploy, and the session the change came
// from, which commits its fix to the branch when a brief reaches it. A fake `gh` records any call: nothing in this
// flow may open a pull request. Each test file calls usePersonalSandbox() once.
import { afterAll, beforeAll, expect, test as bunTest } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { freezeSessionChange } from "./flowChange";
import { writeFrozenChange } from "./flowChangeFile";
import { parseWorkflowSource } from "./parser";
import { lineRunDir, runSlug, runWorkflow } from "./runner";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";
import { resumeStation } from "./resumeFailed";

export const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
export const CONV = "jx7ssssssssssssssssssssssssssss1";
const saved: Record<string, string | undefined> = {};
export let sandbox = "";
let origFetch: typeof fetch;
export let origLog: typeof console.log;

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

/** The sandbox every personal e2e file runs in: a fake `cast`, `gh` and `git` on PATH, HOME and CODECAST_DIR inside it,
 * and, under RECORD_PERSONAL_REPORTS, the reports its tests recorded written out once they all ran. */
export function usePersonalSandbox() {
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
  // Only a file whose tests recorded anything writes, so a file that records nothing never empties the recording.
  afterAll(() => { if (RECORD && Object.keys(recorded).length) fs.writeFileSync(RECORD, `${JSON.stringify(recorded, null, 1)}\n`); });
}

// RECORD_PERSONAL_REPORTS=<file>: each test's progress reports, as the runner sent them, written to that file for the
// web's journey, diagram and report tests to replay through the server's merge (web lib/ship/__tests__/replayReports.ts).
// `bun packages/web/scripts/record-personal-reports.ts` runs this suite with it.
const RECORD = process.env.RECORD_PERSONAL_REPORTS;
const recorded: Record<string, object[]> = {};
/** What the server merges of a progress report into the run (convex workflow_runs.ts updateProgress). */
const REPORT_FIELDS = ["current_node_id", "node_id", "node_status", "outcome", "session_id", "run_status", "fail_reason", "result_preview", "visits", "waiting_on_session"];
// One list of calls per run the test starts (each world's server), so a test of several runs records each.
let recording: Array<Array<{ route: string; body: any }>> = [];
export const test = (name: string, fn: () => unknown, timeout?: number) => bunTest(name, async () => {
  recording = [];
  await fn();
  if (!RECORD) return;
  const runs = recording.map((calls) => calls.filter((c) => c.route === "/cli/workflow-runs/progress")
    .map((c) => JSON.parse(JSON.stringify(Object.fromEntries(REPORT_FIELDS.filter((k) => k in c.body).map((k) => [k, c.body[k]]))).split(sandbox).join("<sandbox>"))))
    .filter((r) => r.length);
  runs.forEach((r, i) => { recorded[runs.length > 1 ? `${name} (run ${i + 1})` : name] = r; });
}, timeout);

export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV } }).trim();
// The world's own commits are an hour old, so a session's writes (seconds ago) read as uncommitted edits after them.
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
export const gitOld = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV, GIT_AUTHOR_DATE: HOUR_AGO, GIT_COMMITTER_DATE: HOUR_AGO } }).trim();

export const CHECK = "./check.sh";
export const FOUND = { outcome: "found", note: "README.md says ./check.sh is the gate", commands: [{ run: CHECK, cwd: ".", source: "README.md:3" }] };
export const NOTHING = { outcome: "skipped", note: "No check documented: looked at README.md and the repo root; nothing calls a script the gate.", commands: [] };
export const SHIP = { verdict: "ship", findings: [] };
export const STALE = { stale: true };
export const REJECTED = { verdict: "rejected", findings: ["blocker a.txt:1 the task should not be done at all"] };
export const LIVE = { outcome: "live", note: "ran ./deploy.sh and saw the commit live", seen_live: "deploy.log names it", commands: [{ run: "./deploy.sh", cwd: ".", source: "README.md:4", exit: 0 }], left_for_you: null };
export const FAILED = { ...LIVE, outcome: "failed", note: "./deploy.sh exited 1: no such host", seen_live: null, commands: [{ ...LIVE.commands[0], exit: 1 }] };

export type World = ReturnType<typeof world>;
let worlds = 0;
/**
 * A personal repo with a bare origin. The change is the session's: committed on `feat` and run with `--branch feat`,
 * or (`own`) its uncommitted edits in the person's checkout, the Ship button's default, which the run freezes onto
 * fresh upstream as `cast flow run change` does. `edit` writes a file as the session, its transcript and the sync
 * ledger saying so. `nobody`: a branch no session made, so the run has nobody to brief.
 */
export function world(answers: { find: object; review?: object[]; deploy?: object[]; content?: string; extra?: Record<string, string>; own?: boolean; base?: Record<string, string>; drop?: string[]; nobody?: boolean }) {
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
    root, origin, wt, runDir, commit, edit, pushElsewhere, pushMain, calls, gh, branch, own: !!answers.own, nobody: !!answers.nobody,
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
export const GONE = "The change left the run: nothing of it is above origin/main any more. This run landed and deployed nothing.";

/** A message that asks the session to work: not how the run ended. */
export const isBrief = (body: string) => !/ is over: | stopped at /.test(body);

/** The server: Find check, each reviewer and Deploy pin the world's answers; the session fixes when a brief reaches it. */
export function server(w: World) {
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

export async function run(w: World, tweak?: (graph: ReturnType<typeof parseWorkflowSource>) => void) {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.personal);
  tweak?.(graph);
  if (w.own) {
    // As `cast flow run change` freezes a session's own edits: a commit on fresh upstream, on the run's branch and tree.
    const change = await freezeSessionChange(w.root, CONV, { branch: w.branch, worktree: "change-ct-9" });
    git(w.root, "worktree", "add", "-q", w.wt, w.branch);
    writeFrozenChange(w.runDir, change);
  } else {
    const tip = git(w.root, "rev-parse", "feat");
    writeFrozenChange(w.runDir, { source: "branch", ...(w.nobody ? {} : { session: CONV.slice(0, 7), conversation: CONV }), base: tip, tip, branch: "feat", worktree: "change-ct-9", paths: ["a.txt"], shared: [], held: [] });
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
export async function resumeAt(w: World, at: string) {
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

export const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8"));

/** Landed: origin's main is the run's merge, carries the change, and the person's checkout caught up to it. */
export function expectLanded(w: World) {
  const main = w.originMain();
  expect(readJson(path.join(w.runDir, "merge.json")).sha).toBe(main);
  expect(w.onMain("a.txt")).toBe("good\n");
  expect(git(w.root, "rev-parse", "HEAD")).toBe(main);
  expect(fs.readFileSync(path.join(w.root, "a.txt"), "utf-8")).toBe("good\n");
  // No pull request, no CI, no merge station, ever.
  expect(w.gh()).toBe("");
  expect(w.calls().filter((c) => /^flow (pr|ci|merge|verdicts|await-deploy)$/.test(c))).toEqual([]);
}

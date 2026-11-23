// End to end (flows.md FL4): the shipped `change` flow, PR → CI ‖ Review →
// Verdicts → Merge → Deploy, run by the real runner on a real git branch. Its
// stations' commands are a fake `cast` on PATH: CI and Merge answer from a
// script of answers, PR does what the real station does to the run's files,
// and Verdicts is the real one. The server is a fake that plays the reviewer,
// which pins its verdict with the round's nonce as the real prompt asks, and
// the session the change came from, which commits its fix to the branch when a
// brief reaches it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFrozenChange } from "./flowChangeFile";
import { graphHash, parseWorkflowFile, parseWorkflowSource } from "./parser";
import { lineRunDir, runSlug, runWorkflow } from "./runner";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const CONV = "jx7ssssssssssssssssssssssssssss1";
const saved: Record<string, string | undefined> = {};
let sandbox = "";
let origFetch: typeof fetch;
let origLog: typeof console.log;

// Each station's command, logged. CI writes the next queued ci.json for the head it was told to wait for (@HEAD@).
// Verdicts and the retest refresh are the real ones; Merge clears a merge as the real station does, on the real
// rebase chain (rebaseRecord.ts), and records its rebases with the real recorder, as Onto main does. The commits are
// names, not objects, so the chain's merge-tree check is the one thing left out. origin-head is where origin's
// branch stands.
const FAKE_CAST = (verdicts: string, prStation: string, rebaseRecord: string) => `#!/bin/sh
echo "$*" >> "$FAKE_STATE/calls.log"
arg() { prev=""; for a in "$@"; do [ "$prev" = "$want" ] && { echo "$a"; return; }; prev="$a"; done; }
pop() { f="$FAKE_STATE/$1.queue"; head -n 1 "$f"; tail -n +2 "$f" > "$f.tmp"; mv "$f.tmp" "$f"; }
want=--dir; dir=$(arg "$@")
case "$1 $2" in
  "flow pr")
    case "$3" in
      --refresh)
        bun -e 'import { refreshPr } from "${prStation}"; const fs = require("fs"); const [dir, st] = process.argv.slice(1); const origin = fs.readFileSync(st + "/origin-head", "utf-8").trim(); const r = refreshPr({ cwd: ".", dir, exec: () => ({ status: 0, stdout: origin + "\\trefs/heads/feat\\n", stderr: "" }) }); console.log(r.ok ? JSON.stringify(r.pr) : r.reason); process.exit(r.ok ? 0 : r.new_round ? 4 : 1)' "$dir" "$FAKE_STATE"; exit $? ;;
      --rebase)
        bun -e 'import { recordRebase } from "${rebaseRecord}"; const fs = require("fs"); const [dir, st] = process.argv.slice(1); const pr = JSON.parse(fs.readFileSync(dir + "/pr.json", "utf-8")); const origin = fs.readFileSync(st + "/origin-head", "utf-8").trim(); if (origin !== pr.head_sha) { console.log("origin moved: a new round"); process.exit(4); } const to = "onmain" + Math.random().toString(36).slice(2, 8); for (const f of ["ci.json", "merge.json"]) fs.rmSync(dir + "/" + f, { force: true }); fs.writeFileSync(st + "/origin-head", to); await recordRebase({ post: async () => ({}), runId: "run-9", runDir: dir, from: pr.head_sha, to }); const next = { ...pr, head_sha: to, rebases: [...(pr.rebases ?? []), { from: pr.head_sha, to }] }; fs.writeFileSync(dir + "/pr.json", JSON.stringify(next)); console.log(JSON.stringify(next))' "$dir" "$FAKE_STATE"; exit $? ;;
      *)
        rm -f "$dir/ci.json" "$dir/review.json" "$dir/merge.json" "$dir/rebase.json"
        want=--branch; branch=$(arg "$@")
        sha=$(git -C "$FAKE_ROOT" rev-parse "$branch"); n=$(wc -l < "$FAKE_STATE/calls.log" | tr -d ' ')
        echo "$sha" > "$FAKE_STATE/origin-head"
        echo "{\\"url\\": \\"https://github.com/acme/app/pull/7\\", \\"number\\": 7, \\"head_sha\\": \\"$sha\\", \\"branch\\": \\"$branch\\", \\"round\\": \\"round$n\\"}" | tee "$dir/pr.json" ;;
    esac ;;
  "flow ci")
    want=--head; h=$(arg "$@")
    line=$(pop ci)
    if [ "$line" = '"pushed"' ]; then
      # Someone pushes while CI waits for the round's head: it never comes, and the station times out on it.
      echo stranger > "$FAKE_STATE/origin-head"
      echo '{"green":false,"head_sha":null,"timed_out":true,"pending":[],"failing":[{"job":"ci-station","test":null,"assertion":null,"file":null,"line":null,"excerpt":"CI did not finish within 60m: waiting on the head to be '"$h"' (it is stranger)."}]}' > "$dir/ci.json"
    else
      printf '%s\\n' "$line" | sed "s/@HEAD@/$h/" > "$dir/ci.json"
    fi
    echo "CI read on PR 7" ;;
  "flow verdicts")
    [ -e "$FAKE_STATE/verdicts-crash" ] && { echo "TypeError: cannot read the round" >&2; exit 1; }
    want=--review; review=$(arg "$@")
    bun -e 'import { changeVerdicts } from "${verdicts}"; const [dir, review, st] = process.argv.slice(1); console.log(JSON.stringify(changeVerdicts(dir, review, require("fs").readFileSync(st + "/origin-head", "utf-8").trim())))' "$dir" "$review" "$FAKE_STATE"; exit $? ;;
  "flow merge")
    # As the real station clears a merge: green CI, the review saying ship, and the reviewer having read the head CI
    # tested, or one the recorded chain of station rebases leads from.
    bun -e 'import { chainBetween, readRebaseChain } from "${rebaseRecord}"; const fs = require("fs"); const d = process.argv[1]; const read = (f) => { try { return JSON.parse(fs.readFileSync(d + "/" + f, "utf-8")); } catch { return null; } }; const ci = read("ci.json"), r = read("review.json"); const no = (s) => { console.log(s); process.exit(2); }; if (!ci) no("no ci.json"); if (ci.green !== true) no("ci.json says CI is not green"); if (!r || r.verdict !== "ship") no("review.json does not say ship"); if (!r.head_sha) no("review.json names no head"); if (r.head_sha !== ci.head_sha && !chainBetween(readRebaseChain(d), r.head_sha, ci.head_sha)) no("the reviewer read " + r.head_sha + ", not the head CI tested (" + ci.head_sha + ")");' "$dir" || exit $?
    answer=$(pop merge)
    case "$answer" in
      merged|merged-gone)
        echo '{"sha": "5ca1ab1e00000000000000000000000000000000", "pr": 7, "url": "https://github.com/acme/app/pull/7"}' > "$dir/merge.json"
        # gh 2.105's pr merge --delete-branch removes the worktree that has the branch checked out, then the branch.
        if [ "$answer" = merged-gone ]; then
          wt=$(git -C "$FAKE_ROOT" worktree list --porcelain | awk '/^worktree /{w=$2} /^branch refs\\/heads\\/feat$/{print w}')
          [ -n "$wt" ] && git -C "$FAKE_ROOT" worktree remove --force "$wt"
          git -C "$FAKE_ROOT" branch -q -D feat; touch "$FAKE_STATE/ws-gone"
        fi
        echo "rebased onto main"; echo 5ca1ab1e00000000000000000000000000000000 ;;
      nojson) echo "said merged, wrote nothing" ;;
      conflict) echo "feat conflicts with main in a.txt; main's commits that touched them: 1234abcd fix"; exit 1 ;;
      stale) echo "feat would set back what main changed after it was built: 1234abcd fix; rebuild the change on main"; exit 1 ;;
      refused) echo "the repository protects main from this merge"; exit 2 ;;
      crashed) echo "TypeError: undefined is not an object" >&2; exit 1 ;;
      retest|retest-pushed)
        # As the real station records it, with the real recorder: from the head CI tested to the rebase it pushed.
        to="rebased$(wc -l < "$FAKE_STATE/calls.log" | tr -d ' ')"
        bun -e 'import { recordRebase } from "${rebaseRecord}"; const fs = require("fs"); const [d, to] = process.argv.slice(1); await recordRebase({ post: async () => ({}), runId: "run-9", runDir: d, from: JSON.parse(fs.readFileSync(d + "/ci.json", "utf-8")).head_sha, to })' "$dir" "$to" || exit 2
        # Someone pushes to the branch right after Merge's rebase: origin no longer holds what Merge made.
        if [ "$answer" = retest-pushed ]; then echo stranger; else echo "$to"; fi > "$FAKE_STATE/origin-head"
        echo "main changed a.txt since CI tested; pushed feat rebased at $to to test again"; exit 3 ;;
    esac ;;
  "flow wait-main")
    case "$(pop wait)" in
      green) echo "Main CI is green at 0123456789." ;;
      *) echo "Main CI stayed red for 4h (red since 0123456789), at 0123456789: CI: test-cli."; exit 1 ;;
    esac ;;
  "ws path")
    [ -e "$FAKE_STATE/ws-gone" ] && { echo "Workspace '$3' not found in 1 checkouts of $FAKE_ROOT."; exit 1; }
    echo "$FAKE_ROOT" ;;
  "flow await-deploy")
    pwd -P > "$FAKE_STATE/deploy-cwd"
    [ -e "$FAKE_STATE/deploy-fails" ] && { echo "The deploy that carried 5ca1ab1e00 failed: web dp-13 (exit 1)."; exit 1; }
    echo "Live: 5ca1ab1e00 on web dp-12." ;;
esac
exit 0
`;

beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-change-flow-e2e-")));
  const bin = path.join(sandbox, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "cast"), FAKE_CAST(path.join(import.meta.dir, "changeVerdicts.ts"), path.join(import.meta.dir, "prStation.ts"), path.join(import.meta.dir, "rebaseRecord.ts")), { mode: 0o755 });
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

const GREEN = { green: true, head_sha: "@HEAD@", tested_main_sha: "aaa", failing: [], preexisting: [], pending: [], reran: false, timed_out: false };
const RED = {
  green: false, head_sha: "@HEAD@", tested_main_sha: "aaa", reran: true, timed_out: false, pending: [],
  failing: [{ job: "test-cli", test: "a reads good", assertion: "expected good, got bad", file: "src/a.test.ts", line: 12, excerpt: "expect(a).toBe('good')" }],
  preexisting: [{ job: "test-web", test: "flaky clock", assertion: "timed out", file: "web/clock.test.ts", line: 3, excerpt: "await tick()" }],
};
// As the CI station writes a timeout: its own entry in failing, the jobs still going in pending.
const STATION = { job: "ci-station", test: null, assertion: null, file: null, line: null, excerpt: "CI did not finish within 60m: test-cli still running." };
const SILENT = { ...GREEN, green: false, timed_out: true, pending: ["test-cli"], failing: [STATION] };
const SHIP = { verdict: "ship", findings: [] };
const CHANGES = { verdict: "changes", findings: ["high a.txt:1 says bad where the task asks for good, P2"] };
const REJECTED = { verdict: "rejected", findings: ["blocker a.txt:1 the task should not be done at all"] };
/**
 * What a reviewer pins: a verdict (with the round's nonce and head its prompt names), nothing, words that are not
 * JSON, a verdict with an old round's nonce, nothing while something else on the machine forges review.json saying
 * ship, or nothing at all because its session died before a turn.
 */
type Review = object | "none" | "garbage" | "stale" | "forged" | "dead";

let worlds = 0;
/** The session committed its change on branch `feat` and ran `cast flow run change --branch feat` from inside itself. */
function world(answers: { ci: Array<object | "pushed">; review: Review[]; merge?: string[]; wait?: string[]; gate?: string | string[] }) {
  const root = path.join(sandbox, `repo-${++worlds}`);
  const state = path.join(sandbox, `state-${worlds}`);
  fs.mkdirSync(root);
  fs.mkdirSync(state);
  process.env.CODECAST_DIR = path.join(sandbox, `.codecast-${worlds}`);
  process.env.FAKE_ROOT = root;
  process.env.FAKE_STATE = state;
  fs.writeFileSync(path.join(state, "ci.queue"), answers.ci.map((a) => JSON.stringify(a)).join("\n") + "\n");
  fs.writeFileSync(path.join(state, "merge.queue"), (answers.merge ?? []).join("\n") + "\n");
  fs.writeFileSync(path.join(state, "wait.queue"), (answers.wait ?? []).join("\n") + "\n");
  fs.writeFileSync(path.join(state, "calls.log"), "");
  git(root, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "a.txt"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-q", "-b", "feat");
  fs.writeFileSync(path.join(root, "a.txt"), "bad\n");
  git(root, "commit", "-qam", "the change");
  git(root, "checkout", "-q", "main");
  // The run's worktree holds the branch, so the session commits from elsewhere: here, with plumbing.
  let fixes = 0;
  const commit = () => {
    const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: `fix ${++fixes}\n`, encoding: "utf-8" }).trim();
    const tree = execFileSync("git", ["-C", root, "mktree"], { input: `100644 blob ${blob}\ta.txt\n`, encoding: "utf-8" }).trim();
    git(root, "update-ref", "refs/heads/feat", git(root, "commit-tree", tree, "-p", "feat", "-m", `fix ${fixes}`));
  };
  const calls = () => fs.readFileSync(path.join(state, "calls.log"), "utf-8").trim().split("\n").filter(Boolean).map((l) => l.split(" ").slice(0, /^flow pr --re(fresh|base)/.test(l) ? 3 : 2).join(" "));
  const runDir = lineRunDir(root, runSlug(parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change), { task_id: "ct-9" }, "run"));
  return { root, runDir, commit, calls, reviews: [...answers.review], gate: answers.gate };
}

/** A message that asks the session to work: not how the run ended, nor a gate's answer, which only inform. */
const isBrief = (body: string) => !/ is over: | stopped at |^Decide: /.test(body);

/** The server: each spawned reviewer pins the next queued review; the session commits a fix when a brief reaches it. */
function server(w: ReturnType<typeof world>) {
  const calls: Array<{ route: string; body: any }> = [];
  const spawned: any[] = [];
  const pins = new Map<string, object>();
  const dead = new Set<string>();
  let messages = 10;
  globalThis.fetch = (async (url: any, init: any) => {
    const route = String(url).replace(/^https?:\/\/[^/]+/, "");
    const body = structuredClone(JSON.parse(init?.body || "{}"));
    calls.push({ route, body });
    const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (route === "/cli/work/get") return reply({ title: "Make a.txt good", status: "in_progress" });
    // The person at the Ship card answers with the world's choice.
    // A list answers each posted gate in turn.
    if (route === "/cli/workflow-runs/poll-gate") {
      const gates = calls.filter((c) => c.route === "/cli/workflow-runs/gate").length;
      return reply({ status: "paused", gate_response: (Array.isArray(w.gate) ? w.gate[gates - 1] : w.gate) ?? null });
    }
    if (route === "/cli/spawn") {
      spawned.push(body);
      const id = `conv_review_${spawned.length}`;
      // The reviewer pins the round and head its prompt names, as the real one copies them.
      const round = /"round": "([^"]+)"/.exec(body.prompt)?.[1];
      const head_sha = /"head_sha": "([^"]+)"/.exec(body.prompt)?.[1];
      const review = w.reviews.shift() ?? SHIP;
      const pin = (result?: string) => pins.set(id, { state: "Reviewed", status: "done", ...(result !== undefined ? { result } : {}), at: Date.now() });
      if (review === "dead") dead.add(id);
      else if (review === "none") pin();
      else if (review === "garbage") pin("verdict: ship, I think");
      else if (review === "stale") pin(JSON.stringify({ ...SHIP, round: "round0", head_sha }));
      else if (review === "forged") {
        pin();
        fs.writeFileSync(path.join(w.runDir, "review.json"), JSON.stringify({ ...SHIP, round, head_sha }));
      } else pin(JSON.stringify({ ...review, round, head_sha }));
      return reply({ conversation_id: id, short_id: `rev${spawned.length}` });
    }
    if (route === "/cli/inbox") {
      const id = body.session_ids?.[0];
      return reply({ sessions: [{ id, work_state: "done", is_live: id === CONV, is_killed: false, message_count: id === CONV ? messages : dead.has(id) ? 0 : 4 }] });
    }
    if (route === "/cli/sessions/state/get") return reply(pins.get(body.session) ?? null);
    if (route === "/cli/messages/send") {
      if (body.to === CONV && isBrief(body.body)) w.commit();
      messages += 3;
      return reply({ ok: true });
    }
    return reply({ ok: true });
  }) as typeof fetch;
  const sent = () => calls.filter((c) => c.route === "/cli/messages/send").map((c) => c.body);
  return {
    spawned,
    sent,
    briefs: () => sent().filter((m) => isBrief(m.body)).map((m) => m.body as string),
    failReason: () => calls.find((c) => c.route === "/cli/workflow-runs/progress" && c.body.run_status === "failed")?.body.fail_reason as string | undefined,
  };
}

async function run(w: ReturnType<typeof world>, subject = true) {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change);
  const tip = git(w.root, "rev-parse", "feat");
  writeFrozenChange(w.runDir, { source: "branch", ...(subject ? { session: CONV.slice(0, 7), conversation: CONV } : {}), base: tip, tip, branch: "feat", worktree: "change-ct-9", paths: ["a.txt"], shared: [], held: [] });
  console.log = process.env.SHOW_RUN ? origLog : () => {};
  try {
    return await runWorkflow(graph, { cwd: w.root, taskId: "ct-9", runId: "run-9", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 });
  } finally {
    console.log = origLog;
  }
}

const count = (calls: string[], c: string) => calls.filter((x) => x === c).length;

describe("the shipped change flow", () => {
  test("the builtin reads the same as the template run from disk", () => {
    const onDisk = parseWorkflowFile(path.join(import.meta.dir, "templates", "change.cast"));
    expect(graphHash(onDisk)).toBe(graphHash(parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change)));
  });

  test("green CI and a ship verdict merge, and Deploy goes out from the merged sha", async () => {
    const w = world({ ci: [GREEN], review: [SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const calls = w.calls();
    expect(calls).toEqual(["flow pr", "flow ci", "flow verdicts", "flow merge", "flow await-deploy"]);
    expect(JSON.parse(fs.readFileSync(path.join(w.runDir, "merge.json"), "utf-8")).sha).toBe("5ca1ab1e00000000000000000000000000000000");
    expect(s.spawned).toHaveLength(1);
    // The reviewer is told the round's nonce to pin with its verdict.
    const round = JSON.parse(fs.readFileSync(path.join(w.runDir, "pr.json"), "utf-8")).round;
    expect(s.spawned[0].prompt).toContain(`"round": "${round}"`);
    // And to record its verdict with `cast flow review-verdict` (flowStations.ts), naming that head and round.
    const head = JSON.parse(fs.readFileSync(path.join(w.runDir, "pr.json"), "utf-8")).head_sha;
    expect(s.spawned[0].prompt).toContain(`cast flow review-verdict --verdict changes --head "${head}" --round "${round}"`);
    // CI posts its verdict to the run's own CI station, and waits for the head PR pushed.
    const ciCall = fs.readFileSync(path.join(process.env.FAKE_STATE!, "calls.log"), "utf-8").split("\n").find((l) => l.startsWith("flow ci "))!;
    const pushed = JSON.parse(fs.readFileSync(path.join(w.runDir, "pr.json"), "utf-8")).head_sha;
    expect(ciCall).toContain("--run run-9 --node ci");
    expect(ciCall).toContain(`--head ${pushed}`);
    expect(s.briefs()).toEqual([]);
    expect(s.sent().at(-1).body).toContain("The Ship run on ct-9 is over: Live.");
  }, 120_000);

  test("red CI goes back to the session as one brief with each failure's file, line and excerpt; the fix goes up as the PR again", async () => {
    const w = world({ ci: [RED, GREEN], review: [SHIP, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const [brief, ...more] = s.briefs();
    expect(more).toEqual([]);
    expect(brief).toContain("https://github.com/acme/app/pull/7");
    expect(brief).toContain("CI is red: 1 failure this change causes");
    expect(brief).toContain('"file":"src/a.test.ts","line":12');
    expect(brief).toContain("expect(a).toBe('good')");
    expect(brief).toContain("under `preexisting` also fails on the default branch");
    expect(count(w.calls(), "flow pr")).toBe(2);
    expect(count(w.calls(), "flow ci")).toBe(2);
    expect(s.spawned).toHaveLength(2);
    // The second PR push carries the session's fix.
    expect(JSON.parse(fs.readFileSync(path.join(w.runDir, "pr.json"), "utf-8")).head_sha).toBe(git(w.root, "rev-parse", "feat"));
    expect(git(w.root, "show", "feat:a.txt")).toBe("fix 1");
  }, 120_000);

  test("a changes verdict goes back with the reviewer's findings, even with CI green", async () => {
    const w = world({ ci: [GREEN, GREEN], review: [CHANGES, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const [brief, ...more] = s.briefs();
    expect(more).toEqual([]);
    expect(brief).toContain("the reviewer asked for changes: high a.txt:1 says bad where the task asks for good, P2");
    expect(count(w.calls(), "flow pr")).toBe(2);
  }, 120_000);

  test("a reviewer that pins nothing is asked once more, with CI left alone, then the session is briefed", async () => {
    const w = world({ ci: [GREEN, GREEN], review: ["none", "none", SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.spawned).toHaveLength(3);
    expect(count(w.calls(), "flow ci")).toBe(2);
    expect(s.briefs()).toHaveLength(1);
    expect(s.briefs()[0]).toContain("the reviewer pinned no verdict");
    expect(count(w.calls(), "flow merge")).toBe(1);
  }, 120_000);

  test("a verdict word outside ship, changes and rejected is asked once more, then briefed; approve is never read as ship", async () => {
    const approve = { verdict: "approve", findings: [] };
    const w = world({ ci: [GREEN, GREEN], review: [approve, approve, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.spawned).toHaveLength(3);
    expect(s.briefs()).toHaveLength(1);
    expect(s.briefs()[0]).toContain(`the reviewer's verdict "approve" is not ship, changes or rejected`);
    expect(count(w.calls().slice(0, w.calls().indexOf("flow merge")), "flow pr")).toBe(2);
  }, 120_000);

  test("a pin from an earlier round, which the fan-out keeps when a reviewer pins words that are not JSON, never merges", async () => {
    // Round 2's reviewer pins words: the runner keeps round 1's ship pin in its place, with round 1's nonce.
    const w = world({ ci: [RED, GREEN, GREEN], review: [SHIP, "garbage", "garbage", SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const calls = w.calls();
    expect(count(calls, "flow merge")).toBe(1);
    expect(s.spawned).toHaveLength(4);
    expect(count(calls.slice(0, calls.indexOf("flow merge")), "flow pr")).toBe(3);
    expect(s.briefs()).toHaveLength(2);
  }, 120_000);

  test("a pin carrying another round's nonce does not count", async () => {
    const w = world({ ci: [GREEN, GREEN], review: ["stale", "stale", SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.spawned).toHaveLength(3);
    expect(s.briefs()[0]).toContain("the reviewer's verdict is not this round's");
  }, 120_000);

  test("a review.json written by anything but the reviewer's pin, with this round's nonce, is ignored and replaced", async () => {
    const w = world({ ci: [GREEN, GREEN], review: ["forged", "forged", SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    // Both forged ships were ignored: the merge waited for the third reviewer's own pin.
    expect(s.spawned).toHaveLength(3);
    expect(s.briefs()).toHaveLength(1);
    expect(count(w.calls(), "flow merge")).toBe(1);
    // What Merge read is the accepted pin, with this round's nonce.
    const round = JSON.parse(fs.readFileSync(path.join(w.runDir, "pr.json"), "utf-8")).round;
    expect(JSON.parse(fs.readFileSync(path.join(w.runDir, "review.json"), "utf-8"))).toMatchObject({ verdict: "ship", findings: [], round });
  }, 120_000);

  test("CI that judged another head than the pushed one runs again, never briefing the session", async () => {
    const w = world({ ci: [{ ...GREEN, head_sha: "0ddba11" }, GREEN], review: [SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toEqual([]);
    expect(count(w.calls(), "flow ci")).toBe(2);
    expect(count(w.calls(), "flow merge")).toBe(1);
  }, 120_000);

  test("CI's one extra run is each round's: a second round gets its own", async () => {
    const w = world({ ci: [SILENT, GREEN, SILENT, GREEN], review: [CHANGES, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(1);
    expect(count(w.calls(), "flow ci")).toBe(4);
  }, 120_000);

  test("CI that never reports runs once more, with nothing sent to the session, then stops at CI never reported", async () => {
    const w = world({ ci: [SILENT, SILENT], review: [SHIP] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(count(w.calls(), "flow ci")).toBe(2);
    expect(w.calls()).not.toContain("flow merge");
    expect(s.briefs()).toEqual([]);
    expect(s.sent().at(-1).body).toContain("stopped at CI never reported");
    expect(s.sent().at(-1).body).toContain("CI did not finish: test-cli still running");
  }, 120_000);

  test("CI that reports on its second try merges", async () => {
    const w = world({ ci: [SILENT, GREEN], review: [SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toEqual([]);
    expect(count(w.calls(), "flow ci")).toBe(2);
  }, 120_000);

  test("a merge conflict goes back to the session with what Merge said, then the change goes up as the PR again", async () => {
    const w = world({ ci: [GREEN, GREEN], review: [SHIP, SHIP], merge: ["conflict", "merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const [brief, ...more] = s.briefs();
    expect(more).toEqual([]);
    expect(brief).toContain("Merge could not put this session's change (ct-9)");
    expect(brief).toContain("feat conflicts with main in a.txt");
    expect(count(w.calls(), "flow pr")).toBe(2);
    expect(count(w.calls(), "flow merge")).toBe(2);
  }, 120_000);

  test("a merge that crashes is no conflict: it stops at Not merged with the crash, and the session is not briefed", async () => {
    const w = world({ ci: [GREEN], review: [SHIP], merge: ["crashed"] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.briefs()).toEqual([]);
    expect(s.sent().at(-1).body).toContain("stopped at Not merged");
    expect(s.sent().at(-1).body).toContain("TypeError: undefined is not an object");
  }, 120_000);

  test("a merge that needs a retest takes origin's rebased head and runs CI on it again, with no new review and no new push", async () => {
    const w = world({ ci: [GREEN, GREEN], review: [SHIP], merge: ["retest", "merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toEqual([]);
    expect(count(w.calls(), "flow ci")).toBe(2);
    expect(count(w.calls(), "flow pr")).toBe(1);
    expect(count(w.calls(), "flow pr --refresh")).toBe(1);
    expect(s.spawned).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(w.runDir, "pr.json"), "utf-8")).head_sha).toMatch(/^rebased/);
  }, 120_000);

  test("main that keeps moving is retested three times, then the run stops and says why", async () => {
    const w = world({ ci: [GREEN, GREEN, GREEN, GREEN], review: [SHIP], merge: ["retest", "retest", "retest", "retest"] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(count(w.calls(), "flow merge")).toBe(4);
    expect(count(w.calls(), "flow ci")).toBe(4);
    expect(w.calls()).not.toContain("flow await-deploy");
    expect(s.sent().at(-1).body).toContain("stopped at Main keeps moving");
    expect(s.sent().at(-1).body).toContain("CI ran again 3 times");
  }, 120_000);

  test("a rejection ends the run at Rejected with the reviewer's reasons, and nothing merges", async () => {
    const w = world({ ci: [GREEN], review: [REJECTED] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(w.calls()).not.toContain("flow merge");
    expect(s.sent().at(-1).body).toContain("stopped at Rejected");
    expect(s.sent().at(-1).body).toContain("the task should not be done at all");
  }, 120_000);

  test("Deploy is reached only through a merge with a sha: a refusal, and a success that wrote no merge.json, stop at Not merged", async () => {
    for (const answer of ["refused", "nojson"]) {
      const w = world({ ci: [GREEN], review: [SHIP], merge: [answer] });
      const s = server(w);
      expect(await run(w)).toBe("failed");
      expect(w.calls()).not.toContain("flow await-deploy");
      expect(s.sent().at(-1).body).toContain("stopped at Not merged");
    }
  }, 240_000);

  test("Deploy sends and waits from the run's checkout when Merge took the run's worktree and branch away", async () => {
    const w = world({ ci: [GREEN], review: [SHIP], merge: ["merged-gone"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(fs.existsSync(path.join(process.env.FAKE_STATE!, "ws-gone"))).toBe(true);
    expect(w.calls()).toEqual(["flow pr", "flow ci", "flow verdicts", "flow merge", "flow await-deploy"]);
    expect(fs.readFileSync(path.join(process.env.FAKE_STATE!, "deploy-cwd"), "utf-8").trim()).toBe(w.root);
    const deploy = fs.readFileSync(path.join(process.env.FAKE_STATE!, "calls.log"), "utf-8").split("\n").find((l) => l.startsWith("flow await-deploy "))!;
    expect(deploy).toContain(`--merge ${w.runDir}/merge.json`);
    expect(s.sent().at(-1).body).toContain("The Ship run on ct-9 is over: Live.");
  }, 120_000);

  test("a deploy that fails after the merge tells the session its change landed but did not go live", async () => {
    const w = world({ ci: [GREEN], review: [SHIP], merge: ["merged"] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "deploy-fails"), "");
    const s = server(w);
    expect(await run(w)).toBe("failed");
    const end = s.sent().at(-1).body;
    expect(end).toContain("stopped at Deploy failed");
    expect(end).toContain("The change is on the default branch; nothing after this stage ran.");
    expect(end).not.toContain("was not shipped");
  }, 120_000);

  test("a session whose fix never turns CI green is briefed three times, then the run stops and says why", async () => {
    const w = world({ ci: [RED, RED, RED, RED], review: [SHIP, SHIP, SHIP, SHIP] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.briefs()).toHaveLength(3);
    expect(w.calls()).not.toContain("flow merge");
    expect(s.sent().at(-1).body).toContain("sent the change back 3 times");
  }, 120_000);

  test("with no session behind the run, the first finding stops it, saying what CI and the reviewer found", async () => {
    const w = world({ ci: [RED], review: [CHANGES] });
    const s = server(w);
    expect(await run(w, false)).toBe("failed");
    expect(s.sent()).toEqual([]);
    expect(s.failReason()).toContain("no session made this change to fix it");
    expect(s.failReason()).toContain("CI is red: 1 failure this change causes");
    expect(s.failReason()).toContain("high a.txt:1 says bad");
  }, 120_000);
});

const BLOCKED = { ...RED, blocked_by_main: true };
const CI_CHANGED = { ...GREEN, ci_changed: true };

describe("when main is red under the change", () => {
  test("it waits for main, puts the change onto the new main and runs CI again, briefing nobody", async () => {
    const w = world({ ci: [BLOCKED, GREEN], review: [SHIP], wait: ["green"], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const calls = w.calls();
    expect(calls.indexOf("flow wait-main")).toBeGreaterThan(calls.indexOf("flow verdicts"));
    expect(calls.indexOf("flow pr --rebase")).toBeGreaterThan(calls.indexOf("flow wait-main"));
    // The rebase is recorded on the run, so Merge's check and the server's both find it.
    expect(fs.readFileSync(path.join(process.env.FAKE_STATE!, "calls.log"), "utf-8")).toMatch(/^flow pr --rebase .* --run run-9$/m);
    expect(count(calls, "flow ci")).toBe(2);
    expect(s.briefs()).toEqual([]);
    expect(s.spawned).toHaveLength(1);
    // CI ran on the head put onto main, which is what pr.json names now, under the review of the head before it.
    expect(JSON.parse(fs.readFileSync(path.join(w.runDir, "pr.json"), "utf-8")).head_sha).toMatch(/^onmain/);
  }, 120_000);

  test("main that stays red past the wait's deadline stops the run naming main's red jobs, briefing nobody", async () => {
    const w = world({ ci: [BLOCKED], review: [SHIP], wait: ["red"] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.briefs()).toEqual([]);
    expect(w.calls()).not.toContain("flow merge");
    expect(s.sent().at(-1).body).toContain("stopped at Main stayed red");
    expect(s.sent().at(-1).body).toContain("CI: test-cli");
  }, 120_000);

  test("the run waits for main at most twice", async () => {
    const w = world({ ci: [BLOCKED, BLOCKED, BLOCKED], review: [SHIP], wait: ["green", "green"] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(count(w.calls(), "flow wait-main")).toBe(2);
    expect(s.sent().at(-1).body).toContain("stopped at Main stayed red");
    expect(s.sent().at(-1).body).toContain("after two waits");
  }, 120_000);
});

describe("a change that edits CI", () => {
  test("goes to a person's Ship card once the reviewer says ship, with why on the task, and merges on Ship", async () => {
    const w = world({ ci: [CI_CHANGED], review: [SHIP], gate: "S", merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(w.calls()).toContain("task comment");
    expect(w.calls().indexOf("flow merge")).toBeGreaterThan(w.calls().indexOf("task comment"));
    expect(s.briefs()).toEqual([]);
  }, 120_000);

  test("Revise briefs the session with the person's note, and the next round goes on as usual", async () => {
    const w = world({ ci: [CI_CHANGED, GREEN], review: [SHIP, SHIP], gate: "R: Keep the old job name", merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const [brief, ...more] = s.briefs();
    expect(more).toEqual([]);
    expect(brief).toContain("This change edits CI, so CI can't vouch for it");
    expect(brief).toContain("Keep the old job name");
    expect(count(w.calls(), "flow pr")).toBe(2);
  }, 120_000);

  test("a question typed at the Ship card goes to the reviewer, and the card asks again", async () => {
    const w = world({ ci: [CI_CHANGED], review: [SHIP, SHIP], gate: ["does this rename the deploy job?", "S"], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    // The reviewer's session hears the question, not the subject session, and no brief goes out.
    expect(s.sent().filter((m) => String(m.body).includes("does this rename the deploy job?"))).toEqual([]);
    const asked = s.spawned.filter((x) => String(x.prompt).includes("does this rename the deploy job?"));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ title: "Review · ct-9", review_for_task: "ct-9" });
    expect(asked[0].prompt).toContain("The person's question at the card");
    expect(s.briefs()).toEqual([]);
    expect(w.calls()).toContain("flow merge");
  }, 120_000);

  test("Drop ends the run unmerged", async () => {
    const w = world({ ci: [CI_CHANGED], review: [SHIP], gate: "D: Not now" });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(w.calls()).not.toContain("flow merge");
    expect(s.sent().at(-1).body).toContain("stopped at Dropped");
  }, 120_000);

  test("with no session behind the run it stops, since there is nobody to take it to a person", async () => {
    const w = world({ ci: [CI_CHANGED], review: [SHIP], gate: "S" });
    const s = server(w);
    expect(await run(w, false)).toBe("failed");
    expect(w.calls()).not.toContain("flow merge");
    expect(s.failReason()).toContain("This change edits CI, so CI can't vouch for it");
  }, 120_000);

  test("one that CI finds red goes back to the session like any red, with no Ship card", async () => {
    const w = world({ ci: [{ ...CI_CHANGED, green: false, failing: RED.failing }, GREEN], review: [SHIP, SHIP], gate: "S", merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(1);
    expect(s.briefs()[0]).toContain("CI is red: 1 failure this change causes");
    expect(w.calls()).not.toContain("task comment");
  }, 120_000);
});

describe("what only the machine can fix never reaches the session", () => {
  test("a push to the branch after the review needs a new review before anything merges", async () => {
    const w = world({ ci: [GREEN, GREEN], review: [SHIP, SHIP], merge: ["retest-pushed", "merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const calls = w.calls();
    expect(count(calls, "flow pr --refresh")).toBe(1);
    expect(count(calls, "flow pr")).toBe(2);
    expect(s.spawned).toHaveLength(2);
    expect(count(calls.slice(calls.indexOf("flow pr --refresh")), "flow merge")).toBe(1);
    expect(s.briefs()).toEqual([]);
  }, 120_000);

  test("a reviewer whose session dies in the fan-out is asked once more on its own", async () => {
    const w = world({ ci: [GREEN], review: ["dead", SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.spawned).toHaveLength(2);
    expect(count(w.calls(), "flow ci")).toBe(1);
    expect(s.briefs()).toEqual([]);
  }, 120_000);

  test("a reviewer that dies again stops the run at Review never finished, briefing nobody", async () => {
    const w = world({ ci: [GREEN], review: ["dead", "dead"] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.briefs()).toEqual([]);
    expect(s.sent().at(-1).body).toContain("stopped at Review never finished");
  }, 120_000);

  test("a Verdicts station that fails stops at a machine end, briefing nobody", async () => {
    const w = world({ ci: [RED], review: [CHANGES] });
    fs.writeFileSync(path.join(process.env.FAKE_STATE!, "verdicts-crash"), "");
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(s.briefs()).toEqual([]);
    expect(s.sent().at(-1).body).toContain("stopped at No verdicts");
  }, 120_000);

  test("the CI station's own failure beside real ones runs CI again, then briefs only the real ones", async () => {
    const mixed = { ...RED, timed_out: true, failing: [STATION, ...RED.failing] };
    const w = world({ ci: [mixed, mixed, GREEN], review: [SHIP, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(count(w.calls(), "flow ci")).toBe(3);
    expect(s.briefs()).toHaveLength(1);
    expect(s.briefs()[0]).toContain("CI is red: 1 failure this change causes");
    expect(s.briefs()[0]).not.toContain("ci-station");
  }, 120_000);

  test("Merge's word that the change would set back main is a conflict the session rebuilds", async () => {
    const w = world({ ci: [GREEN, GREEN], review: [SHIP, SHIP], merge: ["stale", "merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(s.briefs()).toHaveLength(1);
    expect(s.briefs()[0]).toContain("rebuild the change on main");
  }, 120_000);

  test("a pull request CI reports as conflicting with main goes to the session to bring up to date", async () => {
    const conflicting = { ...GREEN, green: false, failing: [{ ...STATION, excerpt: "#7 has a merge conflict with main, so GitHub runs no CI on it. Rebase it and push." }] };
    const w = world({ ci: [conflicting, GREEN], review: [SHIP, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(count(w.calls(), "flow ci")).toBe(2);
    expect(s.briefs()).toHaveLength(1);
    expect(s.briefs()[0]).toContain("conflicts with the default branch, so GitHub runs no CI on it");
    expect(s.briefs()[0]).toContain("has a merge conflict with main");
  }, 120_000);

  test("a push to the branch while CI waits starts a new round, so the new head is reviewed", async () => {
    const w = world({ ci: ["pushed", GREEN], review: [SHIP, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(count(w.calls(), "flow pr")).toBe(2);
    expect(s.spawned).toHaveLength(2);
    expect(s.briefs()).toEqual([]);
  }, 120_000);

  test("a branch someone pushes to during every round's CI gets three new rounds, then the run stops and names the head", async () => {
    const w = world({ ci: ["pushed", "pushed", "pushed", "pushed"], review: [SHIP, SHIP, SHIP, SHIP] });
    const s = server(w);
    expect(await run(w)).toBe("failed");
    expect(count(w.calls(), "flow pr")).toBe(4);
    expect(w.calls()).not.toContain("flow merge");
    expect(s.briefs()).toEqual([]);
    const end = s.sent().at(-1).body;
    expect(end).toContain("stopped at Branch keeps moving");
    expect(end).toContain("the branch moved to stranger");
  }, 120_000);

  test("a second retest in the round keeps the review: each station rebase is of the head the reviewer read", async () => {
    const w = world({ ci: [GREEN, GREEN, GREEN], review: [SHIP], merge: ["retest", "retest", "merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    expect(count(w.calls(), "flow pr --refresh")).toBe(2);
    expect(count(w.calls(), "flow pr")).toBe(1);
    expect(s.spawned).toHaveLength(1);
  }, 120_000);

  test("a red CI too big to print in full still briefs the session, from a short list and the whole ci.json", async () => {
    const failures = Array.from({ length: 20 }, (_, i) => ({ job: "test-cli", test: `t${i}`, assertion: "expected good", file: `src/t${i}.test.ts`, line: i + 1, excerpt: "x".repeat(4096) }));
    const w = world({ ci: [{ ...GREEN, green: false, failing: failures }, GREEN], review: [SHIP, SHIP], merge: ["merged"] });
    const s = server(w);
    expect(await run(w)).toBe("completed");
    const [brief] = s.briefs();
    expect(brief).toContain("CI is red: 20 failures this change causes");
    expect(brief).toContain('"failing_count":20');
    expect(brief).toContain(`${w.runDir}/ci.json`);
    expect(brief.length).toBeLessThan(64_000);
  }, 120_000);
});

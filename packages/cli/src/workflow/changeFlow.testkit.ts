// The harness of the change flow's end to end tests (flows.md FL4): the shipped `change` flow, PR → CI ‖ Review →
// Verdicts → Merge → Deploy, run by the real runner on a real git branch. Its stations' commands are a fake `cast` on
// PATH: CI and Merge answer from a script of answers, PR does what the real station does to the run's files, and
// Verdicts is the real one. The server is a fake that plays the reviewer, which pins its verdict with the round's
// nonce as the real prompt asks, and the session the change came from, which commits its fix to the branch when a
// brief reaches it. Each test file calls useChangeFlowSandbox() once.
import { afterAll, beforeAll } from "bun:test";
import { execFileSync } from "../proc.js";
import { pointCodecastDir } from "../test-helpers/codecastDir.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFrozenChange } from "./flowChangeFile";
import { parseWorkflowSource } from "./parser";
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
        bun -e 'import { recordRebase } from "${rebaseRecord}"; const fs = require("fs"); const [dir, st] = process.argv.slice(1); const pr = JSON.parse(fs.readFileSync(dir + "/pr.json", "utf-8")); const origin = fs.readFileSync(st + "/origin-head", "utf-8").trim(); if (origin !== pr.head_sha) { console.log("origin moved: a new round"); process.exit(4); } const to = "onmain" + Math.random().toString(36).slice(2, 8); for (const f of ["ci.json", "merge.json"]) fs.rmSync(dir + "/" + f, { force: true }); fs.writeFileSync(st + "/origin-head", to); await recordRebase({ post: async () => ({}), runId: "run-9", runDir: dir, from: pr.head_sha, to }); const next = { ...pr, head_sha: to, rebases: [...(pr.rebases ?? []), { from: pr.head_sha, to }] }; (await import("${prStation}")).writePr(dir, next); console.log(JSON.stringify(next))' "$dir" "$FAKE_STATE"; exit $? ;;
      *)
        want=--branch; branch=$(arg "$@")
        sha=$(git -C "$FAKE_ROOT" rev-parse "$branch"); n=$(wc -l < "$FAKE_STATE/calls.log" | tr -d ' ')
        # A head someone else pushed is never overwritten: with nothing new here, the round takes origin's.
        case "$(cat "$FAKE_STATE/origin-head" 2>/dev/null)" in stranger*|outsider) sha=$(cat "$FAKE_STATE/origin-head") ;; esac
        echo "$sha" > "$FAKE_STATE/origin-head"
        # As the real station starts a round: the ship the server holds for the head stands (standingReview), and
        # pr.json is written as the real one writes it.
        bun -e 'import { standingReview, writePr } from "${prStation}"; const fs = require("fs"); const [dir, sha, branch, round, st] = process.argv.slice(1); let proof = null; try { proof = JSON.parse(fs.readFileSync(st + "/proof.json", "utf-8")); } catch {} for (const f of ["ci.json", "review.json", "merge.json", "rebase.json"]) fs.rmSync(dir + "/" + f, { force: true }); const pr = writePr(dir, { url: "https://github.com/acme/app/pull/7", number: 7, head_sha: sha, branch, round, ...standingReview(proof, sha) }); console.log(JSON.stringify(pr))' "$dir" "$sha" "$branch" "round$n" "$FAKE_STATE"; exit $? ;;
    esac ;;
  "flow ci")
    # The head to judge as the real command takes it: --head as written, or with --pushed pr.json's on disk.
    want=--head; h=$(arg "$@")
    case " $* " in *" --pushed "*) [ -n "$h" ] || h=$(bun -e 'import { readPr } from "${prStation}"; console.log(readPr(process.argv[1])?.head_sha ?? "")' "$dir") ;; esac
    line=$(pop ci)
    if [ "$line" = '"pushed"' ]; then
      # Someone pushes while CI waits for the round's head: it never comes, and the station times out on it.
      s="stranger$(wc -l < "$FAKE_STATE/calls.log" | tr -d ' ')"; echo "$s" > "$FAKE_STATE/origin-head"
      echo '{"green":false,"head_sha":null,"timed_out":true,"pending":[],"failing":[{"job":"ci-station","test":null,"assertion":null,"file":null,"line":null,"excerpt":"CI did not finish within 60m: waiting on the head to be '"$h"' (it is '"$s"')."}]}' > "$dir/ci.json"
    else
      printf '%s\\n' "$line" | sed "s/@HEAD@/$h/" > "$dir/ci.json"
    fi
    echo "CI read on PR 7" ;;
  "flow verdicts")
    [ -e "$FAKE_STATE/verdicts-crash" ] && { echo "TypeError: cannot read the round" >&2; exit 1; }
    want=--review; review=$(arg "$@")
    bun -e 'import { changeVerdicts } from "${verdicts}"; const fs = require("fs"); const [dir, review, st] = process.argv.slice(1); let proof = null; try { proof = JSON.parse(fs.readFileSync(st + "/proof.json", "utf-8")); } catch {} console.log(JSON.stringify(changeVerdicts(dir, review, fs.readFileSync(st + "/origin-head", "utf-8").trim(), proof)))' "$dir" "$review" "$FAKE_STATE"; exit $? ;;
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
      inline) echo "still waiting for the lease after 40m: 2nd in line behind the merge of PR #9 on host-2; nothing was done, and the run asks again in the same place"; exit 4 ;;
      crashed) echo "TypeError: undefined is not an object" >&2; exit 1 ;;
      retest|retest-pushed)
        # As the real station records it, with the real recorder: from the head CI tested to the rebase it pushed.
        to="rebased$(wc -l < "$FAKE_STATE/calls.log" | tr -d ' ')"
        bun -e 'import { recordRebase } from "${rebaseRecord}"; const fs = require("fs"); const [d, to] = process.argv.slice(1); await recordRebase({ post: async () => ({}), runId: "run-9", runDir: d, from: JSON.parse(fs.readFileSync(d + "/ci.json", "utf-8")).head_sha, to })' "$dir" "$to" || exit 2
        # Someone pushes to the branch right after Merge's rebase: origin no longer holds what Merge made.
        if [ "$answer" = retest-pushed ]; then echo outsider; else echo "$to"; fi > "$FAKE_STATE/origin-head"
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

export function useChangeFlowSandbox(): void {
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
}

export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV } }).trim();

export const GREEN = { green: true, head_sha: "@HEAD@", tested_main_sha: "aaa", failing: [], preexisting: [], pending: [], reran: false, timed_out: false };
export const RED = {
  green: false, head_sha: "@HEAD@", tested_main_sha: "aaa", reran: true, timed_out: false, pending: [],
  failing: [{ job: "test-cli", test: "a reads good", assertion: "expected good, got bad", file: "src/a.test.ts", line: 12, excerpt: "expect(a).toBe('good')" }],
  preexisting: [{ job: "test-web", test: "flaky clock", assertion: "timed out", file: "web/clock.test.ts", line: 3, excerpt: "await tick()" }],
};
// As the CI station writes a timeout: its own entry in failing, the jobs still going in pending.
export const STATION = { job: "ci-station", test: null, assertion: null, file: null, line: null, excerpt: "CI did not finish within 60m: test-cli still running." };
export const SILENT = { ...GREEN, green: false, timed_out: true, pending: ["test-cli"], failing: [STATION] };
export const SHIP = { verdict: "ship", findings: [] };
export const CHANGES = { verdict: "changes", findings: ["high a.txt:1 says bad where the task asks for good, P2"] };
export const REJECTED = { verdict: "rejected", findings: ["blocker a.txt:1 the task should not be done at all"] };
/**
 * What a reviewer pins: a verdict (with the round's nonce and head its prompt names), nothing, words that are not
 * JSON, a verdict with an old round's nonce, nothing while something else on the machine forges review.json saying
 * ship, or nothing at all because its session died before a turn.
 */
type Review = object | "none" | "garbage" | "stale" | "forged" | "dead";

let worlds = 0;
/** The session committed its change on branch `feat` and ran `cast flow run change --branch feat` from inside itself. */
/** `fixes`: whether the session commits a fix for each brief in turn (it does, past the list); false leaves the head as it was. */
export function world(answers: { ci: Array<object | "pushed">; review: Review[]; merge?: string[]; wait?: string[]; gate?: string | string[]; fixes?: boolean[] }) {
  const root = path.join(sandbox, `repo-${++worlds}`);
  const state = path.join(sandbox, `state-${worlds}`);
  fs.mkdirSync(root);
  fs.mkdirSync(state);
  pointCodecastDir(path.join(sandbox, `.codecast-${worlds}`));
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
  return { root, runDir, commit, calls, reviews: [...answers.review], gate: answers.gate, fixes: [...(answers.fixes ?? [])] };
}

/** A message that asks the session to work: not how the run ended, nor a gate's answer, which only inform. */
const isBrief = (body: string) => !/ is over: | stopped at |^Decide: /.test(body);

/** The server: each spawned reviewer pins the next queued review; the session commits a fix when a brief reaches it. */
export function server(w: ReturnType<typeof world>) {
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
    // The person at the approval card answers with the world's choice.
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
      } else {
        pin(JSON.stringify({ ...review, round, head_sha }));
        // And records it on the run (`cast flow review-verdict`): what the server holds for the attempt, merge-proof.
        const verdict = (review as { verdict?: string }).verdict;
        if (verdict && ["ship", "changes", "rejected"].includes(verdict)) fs.writeFileSync(path.join(process.env.FAKE_STATE!, "proof.json"), JSON.stringify({ review: { verdict, head_sha }, rebases: [] }));
      }
      return reply({ conversation_id: id, short_id: `rev${spawned.length}` });
    }
    if (route === "/cli/inbox") {
      const id = body.session_ids?.[0];
      return reply({ sessions: [{ id, work_state: "done", is_live: id === CONV, is_killed: false, message_count: id === CONV ? messages : dead.has(id) ? 0 : 4 }] });
    }
    if (route === "/cli/sessions/state/get") return reply(pins.get(body.session) ?? null);
    if (route === "/cli/messages/send") {
      if (body.to === CONV && isBrief(body.body) && w.fixes.shift() !== false) w.commit();
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
    /** The round counter the run card reads: Fix findings' visits as each entry into it reported them. */
    briefRounds: () => calls.filter((c) => c.route === "/cli/workflow-runs/progress" && c.body.node_id === "brief" && c.body.node_status === "running" && c.body.visits !== undefined).map((c) => c.body.visits as number),
  };
}

/** `at`: `cast workflow resume ct-9 --at <station>` as the runner sees it, the same run picked up there as a new attempt. */
export async function run(w: ReturnType<typeof world>, subject = true, at?: string) {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change);
  const tip = git(w.root, "rev-parse", "feat");
  writeFrozenChange(w.runDir, { source: "branch", ...(subject ? { session: CONV.slice(0, 7), conversation: CONV } : {}), base: tip, tip, branch: "feat", worktree: "change-ct-9", paths: ["a.txt"], shared: [], held: [] });
  console.log = process.env.SHOW_RUN ? origLog : () => {};
  try {
    return await runWorkflow(graph, { cwd: w.root, taskId: "ct-9", runId: "run-9", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1, ...(at ? { resume: { status: "failed", current_node_id: at, node_statuses: [], visits_reset_at: Date.now() + 5 } as any } : {}) });
  } finally {
    console.log = origLog;
  }
}

export const count = (calls: string[], c: string) => calls.filter((x) => x === c).length;

// One change in every state the lifecycle draws (changes.md CH2), built at a
// given `now`, for the tests that pin each state's word, tone and track.
import type { DeployReach, TargetReach } from "@codecast/shared/contracts/deployReach";
import type { ChangeFacts } from "./lifecycle";

const MIN = 60_000;

const target = (name: string, state: TargetReach["state"], at: number, short = "dp-1"): TargetReach => ({
  target: name,
  state,
  deploy: state === "waiting" ? null : { short_id: short, status: state === "live" || state === "rolled_back" ? "live" : state === "going_out" ? "running" : state === "queued" ? "requested" : "failed", sha: "a1b2c3d4e5", at, url: null },
  now: null,
});

const reach = (state: DeployReach["state"], targets: TargetReach[]): DeployReach => ({ state, sha: "a1b2c3d4e5", targets });

export type ChangeExample = { id: string; caption: string; facts: ChangeFacts };

export function changeExamples(now: number): ChangeExample[] {
  const ago = (m: number) => now - m * MIN;
  const writer = (title: string, state: "working" | "idle" | "finished" = "working") => ({ conversation_id: null, title, state });
  return [
    {
      id: "editing",
      caption: "A session is writing it in a worktree",
      facts: { vehicle: { kind: "branch", name: "evals/budget-checks", worktree: "~/code/codecast/.codecast/worktrees/budget-checks" }, work: { uncommitted: 6, ahead: 2, pushed: false, writers: [writer("Regrowth checks")], since: ago(14) } },
    },
    {
      id: "edits-shared",
      caption: "One session's edits in the shared main checkout",
      facts: { vehicle: { kind: "edits", title: "Deploy pill words", files: 4 }, work: { uncommitted: 4, ahead: 0, pushed: false, writers: [writer("Deploy pill words", "idle")], since: ago(8) } },
    },
    {
      id: "not-shipped",
      caption: "Committed in a worktree; nothing ships it yet",
      facts: { vehicle: { kind: "branch", name: "evals/entry-prune", worktree: "~/code/union-mobile/worktrees/entry-prune" }, work: { uncommitted: 0, ahead: 3, pushed: false, writers: [] } },
    },
    {
      id: "pass",
      caption: "The shared checkout's work, bundled for one pass",
      facts: { vehicle: { kind: "pass", folder: "~/code/codecast", sessions: 4, files: 23 }, work: { uncommitted: 23, ahead: 0, pushed: false, writers: [writer("Deploy pill words", "finished"), writer("PR deploy band", "finished"), writer("Live needs evidence", "finished"), writer("Deploys queue", "finished")] } },
    },
    {
      id: "checking",
      caption: "CI and review running on the pushed branch",
      facts: { vehicle: { kind: "branch", name: "evals/family-prune" }, flow: true, work: { uncommitted: 0, ahead: 4, pushed: true, writers: [writer("Family cut", "finished")] }, check: { ci: "pending", review: "pending", since: ago(4) } },
    },
    {
      id: "fixing",
      caption: "Review sent findings back; the session is fixing",
      facts: { vehicle: { kind: "pr", number: 4486, branch: "line/fix-readout", title: "Fix-flow ship readout" }, flow: true, work: { uncommitted: 0, ahead: 1, pushed: true, writers: [writer("Fix-flow readout", "working")] }, check: { ci: "success", passed: 14, review: "changes", back: { round: 2, max: 3, note: "Count only real merges", since: ago(6) } } },
    },
    {
      id: "checks-failed",
      caption: "CI failed on its head",
      facts: { vehicle: { kind: "branch", name: "ship/ct-98647", pr: 4490 }, work: { uncommitted: 0, ahead: 2, pushed: true, writers: [writer("Deploys queue", "finished")] }, check: { ci: "failure", failing: ["test-web (2/4)"], review: "approved" } },
    },
    {
      id: "your-call",
      caption: "Checks passed; a person decides whether it lands",
      facts: { vehicle: { kind: "pr", number: 4485, branch: "evals/check-in-clause" }, flow: true, work: { uncommitted: 0, ahead: 1, pushed: true, writers: [] }, check: { ci: "success", passed: 14, review: "approved" }, land: { state: "you", since: ago(22), decision_id: "sd-4235" } },
    },
    {
      id: "conflicts",
      caption: "Main moved under it and the merge conflicts",
      facts: { vehicle: { kind: "branch", name: "pl-1074-ship-model" }, flow: true, work: { uncommitted: 0, ahead: 7, pushed: true, writers: [] }, check: { ci: "success", review: "approved" }, land: { state: "conflict", since: ago(3) } },
    },
    {
      id: "merging",
      caption: "Landing the exact commit CI tested",
      facts: { vehicle: { kind: "branch", name: "default-flow-run" }, flow: true, work: { uncommitted: 0, ahead: 1, pushed: true, writers: [] }, check: { ci: "success", passed: 12, review: "approved" }, land: { state: "merging", since: ago(1) } },
    },
    {
      id: "not-live",
      caption: "On main; no deploy has picked it up",
      facts: { vehicle: { kind: "commit", sha: "5caaa346ac91" }, check: { ci: "success", review: "approved" }, land: { state: "landed", how: "merged", sha: "5caaa346ac91", at: ago(40) }, reach: reach("waiting", [target("backend", "waiting", 0), target("web", "waiting", 0)]) },
    },
    {
      id: "deploy-queued",
      caption: "A deploy holding it is asked for",
      facts: { vehicle: { kind: "pr", number: 4481 }, check: { ci: "success", review: "approved" }, land: { state: "landed", how: "merged", sha: "28b0d6bf03", at: ago(55) }, reach: reach("queued", [target("backend", "queued", ago(3), "dp-2041")]) },
    },
    {
      id: "deploying",
      caption: "Going out; one of its two targets is already live",
      facts: { vehicle: { kind: "branch", name: "evals/family-prune" }, check: { ci: "success", review: "approved" }, land: { state: "landed", how: "merged", sha: "107b95d1b8", at: ago(30) }, reach: reach("going_out", [target("backend", "going_out", ago(6), "dp-2043"), target("web", "live", ago(20), "dp-2042")]) },
    },
    {
      id: "deploy-failed",
      caption: "The deploy carrying it failed",
      facts: { vehicle: { kind: "commit", sha: "e39a737a27aa" }, check: { ci: "success", review: "approved" }, land: { state: "landed", how: "pushed", sha: "e39a737a27aa", at: ago(80) }, reach: reach("failed", [target("backend", "failed", ago(12), "dp-2039")]) },
    },
    {
      id: "live",
      caption: "Live on every target it touches",
      facts: { vehicle: { kind: "branch", name: "evals/entry-prune" }, check: { ci: "success", review: "approved" }, land: { state: "landed", how: "merged", sha: "545d0edf77", at: ago(190) }, reach: reach("live", [target("backend", "live", ago(150), "dp-2031"), target("web", "live", ago(160), "dp-2030")]) },
    },
    {
      id: "rolled-back",
      caption: "Was live; the target was rolled back past it",
      facts: { vehicle: { kind: "pr", number: 4461 }, check: { ci: "success", review: "approved" }, land: { state: "landed", how: "merged", sha: "545d0edf77", at: ago(300) }, reach: reach("rolled_back", [target("backend", "rolled_back", ago(200), "dp-2020")]) },
    },
    {
      id: "red-main",
      caption: "Pushed straight to main, then CI went red there",
      facts: { vehicle: { kind: "pass", folder: "~/code/union-mobile", sessions: 3, files: 11 }, check: { ci: "failure", failing: ["unit (3/8)"], review: "none", after_land: true }, land: { state: "landed", how: "pass", sha: "9f8e7d6c5b", at: ago(18) }, reach: reach("waiting", [target("backend", "waiting", 0)]) },
    },
    {
      id: "landed",
      caption: "On main in a repository that deploys nothing",
      facts: { vehicle: { kind: "branch", name: "docs/pipeline" }, deploys: false, check: { ci: "success", review: "none" }, land: { state: "landed", how: "merged", sha: "82d5b576b0", at: ago(9) }, reach: null },
    },
    {
      id: "closed",
      caption: "Closed without landing",
      facts: { vehicle: { kind: "pr", number: 4477, branch: "ship/ct-98502" }, closed: { at: ago(60) }, work: { uncommitted: 0, ahead: 2, pushed: true, writers: [] }, check: { ci: "failure", review: "none" } },
    },
  ];
}

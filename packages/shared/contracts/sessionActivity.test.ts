import { describe, expect, test } from "bun:test";
import { DORMANT_CLAIM_TTL_MS } from "./agentStatus";
import { PARKED_WAKE_TTL_MS } from "./inboxPlacement";
import type { DormantTriggerRow } from "./dormantWake";
import { childrenRunningOf, sessionActivity, shipStageOfCommand, type SessionActivityInput } from "./sessionActivity";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const timed = (id: string, run_at: number, status = "scheduled") => ({ id, task: { status, run_at, schedule_type: "recurring" } });
const event = (event_type: string, pr_number?: number, status = "scheduled") => ({ id: event_type, task: { status, schedule_type: "event", event_filter: { event_type, pr_number } } });

type Row = { id: string } & DormantTriggerRow;
const act = (over: Partial<SessionActivityInput<Row>> & { row?: SessionActivityInput<Row>["row"] }) =>
  sessionActivity<Row>({ row: { updated_at: NOW - 60_000 }, triggers: [], now: NOW, ...over });

const agent = (description: string) => ({ kind: "agent", description });
const shell = (command: string, description?: string) => ({ kind: "background", command, description });

describe("working: the row's own work runs", () => {
  test("background subagents, named by what most of them do", () => {
    expect(act({ row: { open_tasks: [agent("Round 7 verifier: UI"), agent("Review the store diff"), agent("Critic sweep")] } })).toEqual({
      state: "working", kind: "subagents", verb: "reviewing", count: 3, words: "3 subagents · reviewing",
    });
    expect(act({ row: { open_tasks: [agent("Implement the rail"), agent("Wire the header chip"), agent("Verify UI")] } })).toMatchObject({ verb: "building", words: "3 subagents · building" });
    expect(act({ row: { open_tasks: [agent("Explore the sync log")] } })).toMatchObject({ verb: "researching", words: "1 subagent · researching" });
    expect(act({ row: { open_tasks: [agent("Mine the transcripts"), agent("Map the callers")] } })).toMatchObject({ verb: "researching" });
    expect(act({ row: { open_tasks: [agent("Fix failing tests"), agent("Run the typecheck")] } })).toMatchObject({ verb: "building" });
    expect(act({ row: { open_tasks: [agent("General help")] } })).toEqual({ state: "working", kind: "subagents", verb: null, count: 1, words: "1 subagent" });
  });

  test("a subagent still producing with no report reads working too", () => {
    expect(act({ row: { producing_until: NOW + 1 } })).toEqual({ state: "working", kind: "subagents", verb: null, count: 0, words: "subagents working" });
    expect(act({ row: { producing_until: NOW - 1 } }).state).toBe("sleeping");
  });

  test("subagents that all draw evals read as eval draws", () => {
    const draws = Array.from({ length: 6 }, (_, i) => agent(`eval draw ${i + 1}`));
    expect(act({ row: { open_tasks: draws } })).toEqual({ state: "working", kind: "evals", verb: "measuring", count: 6, words: "measuring · 6 eval draws" });
    expect(act({ row: { open_tasks: [shell("./evals check guidance --draws 6"), shell("./evals replay freeze-12")] } })).toEqual({
      state: "working", kind: "evals", verb: "measuring", count: 2, words: "measuring · 2 eval draws",
    });
  });

  test("running child sessions are workers, with the verb their titles share", () => {
    expect(act({ childrenRunning: 2, childWork: ["B1: build the waiting_on field", "Implement the rail"] })).toEqual({
      state: "working", kind: "workers", verb: "building", count: 2, words: "building · 2 workers",
    });
    expect(act({ childrenRunning: 1 })).toEqual({ state: "working", kind: "workers", verb: null, count: 1, words: "1 worker" });
  });

  test("a workflow in the session, or one the turn ended on", () => {
    expect(act({ row: { workflow_run_id: "r", workflow_run_status: "running", workflow_run_name: "audit" } })).toEqual({
      state: "working", kind: "workflow", verb: "reviewing", count: 1, words: "workflow · audit",
    });
    expect(act({ row: { open_tasks: [{ kind: "workflow", description: "replay the freezes" }] } })).toMatchObject({ kind: "workflow", verb: "measuring", words: "workflow · replay the freezes" });
    expect(act({ row: { open_tasks: [{ kind: "workflow" }] } })).toMatchObject({ kind: "workflow", words: "workflow · workflow run" });
    // A workflow sub-session's run is its parent's, not its own work.
    expect(act({ row: { workflow_run_id: "r", workflow_run_status: "running", is_workflow_sub: true } }).state).toBe("sleeping");
  });

  test("a live run it started that does not ship reads working", () => {
    expect(act({ row: { parked_wake_kind: "run", updated_at: NOW - HOUR, last_heartbeat: NOW - 5_000 } })).toEqual({
      state: "working", kind: "workflow", verb: null, count: 1, words: "workflow · a run it started",
    });
  });

  test("long background commands, by what they run", () => {
    expect(act({ row: { open_tasks: [shell("bun test packages/web")] } })).toEqual({ state: "working", kind: "command", verb: "testing", count: 1, words: "running tests" });
    expect(act({ row: { open_tasks: [shell("cast check --all")] } })).toMatchObject({ verb: "testing", words: "running tests" });
    expect(act({ row: { open_tasks: [shell("npx tsc -p packages/cli")] } })).toMatchObject({ verb: "testing" });
    expect(act({ row: { open_tasks: [shell("bun test packages/evals/climb.test.ts")] } })).toMatchObject({ verb: "testing" });
    expect(act({ row: { open_tasks: [shell("bun run build")] } })).toMatchObject({ verb: "building", words: "building" });
    expect(act({ row: { open_tasks: [shell("bun run dev", "dev server")] } })).toEqual({ state: "working", kind: "command", verb: null, count: 1, words: "dev server" });
    expect(act({ row: { open_tasks: [shell("bun run dev"), shell("tail -f log")] } })).toMatchObject({ words: "2 background commands" });
    // A test that mentions deploy or CI is still a test.
    expect(act({ row: { open_tasks: [shell("bun test convex/deploy.test.ts")] } })).toMatchObject({ state: "working", words: "running tests" });
    expect(act({ row: { open_tasks: [shell("CI=1 bun test")] } })).toMatchObject({ state: "working", words: "running tests" });
  });

  test("a described shell is read by what it runs: deploy and CI tests are tests", () => {
    expect(act({ row: { open_tasks: [shell("bun test convex/deploy.test.ts", "Run deploy tests")] } })).toEqual({ state: "working", kind: "command", verb: "testing", count: 1, words: "running tests" });
    expect(act({ row: { open_tasks: [shell("bun run ci", "Run the CI checks locally")] } })).toEqual({ state: "working", kind: "command", verb: "testing", count: 1, words: "running tests" });
    expect(act({ row: { open_tasks: [shell("cast flow run change --dry-run", "Dry-run the change flow")] } })).toMatchObject({ state: "working", kind: "command" });
    expect(act({ row: { open_tasks: [shell("./deploy.sh --actor Jason --backend", "Deploy backend")] } })).toEqual({ state: "shipping", stage: "deploy", failed: false, words: "Deploying backend", target: "backend" });
  });

  test("eval words only for the evals harness", () => {
    expect(act({ row: { open_tasks: [agent("Evaluate the three options")] } })).toEqual({ state: "working", kind: "subagents", verb: null, count: 1, words: "1 subagent" });
    expect(act({ row: { open_tasks: [agent("Sweep the repo for callers")] } })).toMatchObject({ kind: "subagents", verb: null });
    expect(act({ row: { open_tasks: [agent("Seal the freeze"), agent("xrun guidance")] } })).toMatchObject({ kind: "evals", words: "measuring · 2 eval draws" });
    expect(act({ row: { open_tasks: [shell("rm -rf /tmp/x; find . -name '*.seal'")] } })).toMatchObject({ kind: "command", verb: null });
  });

  test("a command with no verb and no description never shows its command line", () => {
    expect(act({ row: { open_tasks: [shell("bun packages/cli/scripts/prompt-dry-run.ts --model opus")] } })).toEqual({ state: "working", kind: "command", verb: null, count: 1, words: "running a command" });
  });

  test("a command that only waits out a clock is a timed wake, not work", () => {
    expect(act({ row: { open_tasks: [shell("sleep 1800 && echo done", "Wait 30 minutes")] } })).toEqual({
      state: "sleeping", flavor: "scheduled", wake: { kind: "background", count: 1, what: "Wait 30 minutes" }, hibernated: false,
    });
    expect(act({ row: { open_tasks: [shell("until [ -f /tmp/out ]; do sleep 5; done")] } })).toMatchObject({ flavor: "scheduled", wake: { kind: "background", what: "a timed wait" } });
    // A poll of the pipeline is shipping; a poll that runs work is working.
    expect(act({ row: { open_tasks: [shell('until [ "$(gh run view 4488 --json status -q .status)" = completed ]; do sleep 20; done')] } }).state).toBe("shipping");
    expect(act({ row: { open_tasks: [shell("while true; do bun test; sleep 60; done")] } })).toMatchObject({ state: "working", words: "running tests" });
    // What the agent named still outranks it.
    expect(act({ row: { waiting_on: { kind: "person", ref: "@ashot" }, open_tasks: [shell("sleep 600")] } })).toMatchObject({ flavor: "waiting" });
  });

  test("a surface's live watch rows stand in for the row's shells", () => {
    expect(act({ row: { open_tasks: [shell("bun run dev")] }, watches: [{ command: "bun test" }] })).toMatchObject({ words: "running tests" });
  });
});

describe("shipping: the change is between CI and live", () => {
  test("the caller's ship stage, with the words for each", () => {
    expect(act({ ship: { stage: "ci", pr: "#263" } })).toEqual({ state: "shipping", stage: "ci", failed: false, words: "CI running · #263", pr: "#263" });
    expect(act({ ship: { stage: "review" } })).toEqual({ state: "shipping", stage: "review", failed: false, words: "In review" });
    expect(act({ ship: { stage: "merge" } })).toMatchObject({ words: "Merging" });
    expect(act({ ship: { stage: "deploy", target: "web" } })).toEqual({ state: "shipping", stage: "deploy", failed: false, words: "Deploying web", target: "web" });
    expect(act({ ship: { stage: "live" } })).toMatchObject({ words: "Checking it's live" });
    expect(act({ ship: { stage: "ci", failed: true, pr: "#263" } })).toMatchObject({ failed: true, words: "CI failed · fixing" });
    expect(act({ ship: { stage: "deploy", failed: true } })).toMatchObject({ words: "Deploy failed · fixing" });
  });

  test("a background command watching CI or a deploy", () => {
    const cmd = 'until [ "$(gh run view 4488 --json status -q .status)" = completed ]; do sleep 20; done';
    expect(act({ row: { open_tasks: [shell(cmd)] } })).toEqual({ state: "shipping", stage: "ci", failed: false, words: "CI running" });
    expect(act({ row: { open_tasks: [shell("gh pr checks 263 --watch")] } })).toMatchObject({ stage: "ci", words: "CI running · #263", pr: "#263" });
    expect(act({ row: { open_tasks: [shell("gh run watch 99")] } })).toMatchObject({ stage: "ci" });
    expect(act({ row: { open_tasks: [shell("gh pr merge 263 --squash --auto")] } })).toMatchObject({ stage: "merge", pr: "#263" });
    expect(act({ row: { open_tasks: [shell("cast deploy web --wait")] } })).toMatchObject({ stage: "deploy", words: "Deploying web", target: "web" });
    expect(act({ row: { open_tasks: [shell("packages/convex/deploy.sh")] } })).toMatchObject({ words: "Deploying convex" });
    expect(act({ row: { open_tasks: [shell("./deploy.sh --backend")] } })).toMatchObject({ words: "Deploying backend" });
    expect(act({ row: { open_tasks: [shell("gh run watch $(gh run list --workflow deploy.yml -L1 --json databaseId -q '.[0].databaseId')")] } })).toMatchObject({ stage: "deploy", words: "Deploying" });
    expect(act({ row: { open_tasks: [shell("gh workflow run cut-cli-release.yml -R codecast-sh/codecast")] } })).toMatchObject({ stage: "deploy" });
    expect(act({ row: { open_tasks: [shell("cast flow run change --task ct-9")] } })).toMatchObject({ stage: "ci" });
    // A Monitor says what it watches in its description.
    expect(act({ row: { open_tasks: [{ kind: "monitor", description: "Watch CI on main" }] } })).toMatchObject({ stage: "ci" });
    expect(act({ row: { open_tasks: [{ kind: "monitor", description: "Wait for the deploy to go live" }] } })).toMatchObject({ stage: "deploy" });
  });

  test("an armed event trigger on one PR waits on its stage, the earliest when several", () => {
    const stage = (type: string) => (act({ triggers: [event(type, 263)] }) as { stage?: string }).stage;
    expect(stage("pr_checks_green")).toBe("ci");
    expect(stage("pr_review_requested")).toBe("review");
    expect(stage("pr_review")).toBe("review");
    expect(stage("pr_approved")).toBe("review");
    expect(stage("pr_changes_requested")).toBe("review");
    expect(stage("pr_merged")).toBe("merge");
    expect(act({ triggers: [event("pr_merged", 263), event("pr_checks_green", 263)] })).toEqual({ state: "shipping", stage: "ci", failed: false, words: "CI running · #263", pr: "#263" });
    expect(act({ triggers: [event("deploy_live"), event("pr_merged", 263)] })).toEqual({ state: "shipping", stage: "merge", failed: false, words: "Merging", pr: "#263" });
  });

  test("an event trigger not narrowed to this change, or waiting only for a failure, is a schedule", () => {
    const flavor = (...triggers: ReturnType<typeof event>[]) => act({ triggers });
    // Repo-wide PR watchers.
    expect(flavor(event("pr_merged"))).toMatchObject({ state: "sleeping", flavor: "scheduled" });
    expect(flavor(event("pr_review_requested"))).toMatchObject({ state: "sleeping", flavor: "scheduled" });
    // Failure-only guards.
    expect(flavor(event("pr_check_failed", 263))).toMatchObject({ state: "sleeping", flavor: "scheduled" });
    expect(flavor(event("deploy_failed"))).toMatchObject({ state: "sleeping", flavor: "scheduled" });
    // No filter narrows a deploy event to one change, and the trigger row does
    // not say it fires once: a monitor verifying every deploy reads scheduled.
    expect(flavor(event("deploy_live"))).toMatchObject({ state: "sleeping", flavor: "scheduled" });
    expect(flavor(event("deploy"))).toMatchObject({ state: "sleeping", flavor: "scheduled" });
    // A paused trigger waits on nothing; an event that is not the pipeline's is a schedule.
    expect(act({ triggers: [event("pr_merged", 263, "paused")] }).state).toBe("sleeping");
    expect(flavor(event("pr_comment"))).toMatchObject({ state: "sleeping", flavor: "scheduled" });
  });

  test("a run it started reads shipping when the caller says the run ships", () => {
    const run = { parked_wake_kind: "run", updated_at: NOW - HOUR, last_heartbeat: NOW - 5_000 };
    expect(act({ row: run, runShips: true })).toEqual({ state: "shipping", stage: "ci", failed: false, words: "CI running" });
    expect(act({ row: run, runShips: true, ship: { stage: "review" } })).toMatchObject({ words: "In review" });
    expect(act({ row: { workflow_run_id: "r", workflow_run_status: "running", workflow_run_name: "change" }, runShips: true })).toMatchObject({ state: "shipping", stage: "ci" });
  });
});

describe("precedence: working > shipping > sleeping", () => {
  test("its own workers keep it Working while its change ships", () => {
    expect(act({ row: { open_tasks: [agent("Round 2 verifier"), shell("gh pr checks 263 --watch")] }, triggers: [event("pr_merged")] })).toMatchObject({ state: "working", kind: "subagents", count: 1 });
    expect(act({ childrenRunning: 2, ship: { stage: "deploy" } })).toMatchObject({ state: "working", kind: "workers" });
    expect(act({ row: { open_tasks: [shell("bun test"), shell("gh run watch 4")] } })).toMatchObject({ state: "working", count: 1, words: "running tests" });
  });

  test("shipping outranks every wait", () => {
    expect(act({ row: { waiting_on: { kind: "session", ref: "jx7abc" } }, ship: { stage: "ci" } }).state).toBe("shipping");
    expect(act({ triggers: [timed("t", NOW + 60_000), event("pr_merged", 263)] })).toMatchObject({ state: "shipping", stage: "merge" });
  });

  test("the person's own park or snooze outranks every activity", () => {
    const busy = { open_tasks: [agent("Review the diff"), shell("gh pr checks 263 --watch")] };
    expect(act({ row: { user_rest: "dormant", ...busy }, triggers: [event("pr_merged", 263)] })).toEqual({ state: "sleeping", flavor: "parked", wake: { kind: "parked" }, hibernated: false });
    expect(act({ row: { user_rest: "dormant" }, ship: { stage: "ci" } })).toMatchObject({ flavor: "parked" });
    expect(act({ row: { user_rest: "dormant" }, childrenRunning: 3 })).toMatchObject({ flavor: "parked" });
    expect(act({ row: { inbox_snoozed_until: NOW + 5, ...busy } })).toEqual({ state: "sleeping", flavor: "snoozed", wake: { kind: "snoozed", at: NOW + 5 }, hibernated: false });
    // A snooze that ran out no longer speaks.
    expect(act({ row: { inbox_snoozed_until: NOW - 5, ...busy } })).toMatchObject({ state: "working" });
  });
});

describe("sleeping: only a wait stands", () => {
  test("waiting on a person, session, task or PR, from the row", () => {
    for (const kind of ["person", "session", "task", "pr"] as const) {
      expect(act({ row: { waiting_on: { kind, ref: "x", at: NOW - 10 } } })).toEqual({
        state: "sleeping", flavor: "waiting", on: { kind, ref: "x" }, since: NOW - 10, wake: null, hibernated: false,
      });
    }
    expect(act({ row: { waiting_on: { kind: "pr", ref: "#263" } } })).toMatchObject({ since: null });
    // What the agent names outranks a timed poll it also armed.
    expect(act({ row: { waiting_on: { kind: "session", ref: "jx7abc" } }, triggers: [timed("t", NOW + 1)] })).toMatchObject({ flavor: "waiting" });
  });

  test("a task blocker or wait reads waiting on that task when the caller names it", () => {
    expect(act({ row: { parked_wake_kind: "blocker" }, waitTask: "ct-102313" })).toEqual({
      state: "sleeping", flavor: "waiting", on: { kind: "task", ref: "ct-102313" }, since: null, wake: { kind: "blocker" }, hibernated: false,
    });
    expect(act({ row: { parked_wake_kind: "wait", updated_at: NOW - HOUR } })).toEqual({
      state: "sleeping", flavor: "waiting", on: null, since: null, wake: { kind: "wait" }, hibernated: false,
    });
  });

  test("a timed trigger is scheduled, with the soonest one", () => {
    const a = act({ triggers: [timed("late", NOW + 9e6), timed("soon", NOW + 6e4), timed("paused", NOW + 1, "paused")] });
    expect(a.state === "sleeping" && a.flavor === "scheduled" && a.wake.kind === "trigger" && [a.wake.row.id, a.wake.others]).toEqual(["soon", 1]);
    expect(act({ row: { armed_trigger_kind: "standing" } })).toMatchObject({ flavor: "scheduled", wake: { kind: "trigger_unloaded" } });
  });

  test("nothing visible: stalled, back to the person after the claim's lifetime", () => {
    expect(act({ row: { updated_at: NOW - 1000, thread_state: "Waiting on review\nNext: jx7abc reports back" } })).toEqual({
      state: "sleeping", flavor: "stalled", wake: { kind: "claim", what: "jx7abc reports back", back: NOW - 1000 + DORMANT_CLAIM_TTL_MS }, hibernated: false,
    });
    // A row with nothing at all.
    expect(sessionActivity({ row: {}, triggers: [], now: NOW })).toEqual({
      state: "sleeping", flavor: "stalled", wake: { kind: "claim", what: null, back: NOW + DORMANT_CLAIM_TTL_MS }, hibernated: false,
    });
  });

  test("a wake the server dropped is unconfirmed", () => {
    expect(act({ row: { parked_wake_kind: "wait", updated_at: NOW - PARKED_WAKE_TTL_MS - HOUR } })).toMatchObject({ flavor: "unconfirmed", wake: { kind: "unconfirmed", wake: "wait" } });
    expect(act({ row: { parked_wake_kind: "run", updated_at: NOW - HOUR, last_heartbeat: NOW - 3 * HOUR }, runShips: true })).toMatchObject({ flavor: "unconfirmed", wake: { kind: "run_unreported" } });
  });

  test("the person's own park and snooze", () => {
    expect(act({ row: { user_rest: "dormant", waiting_on: { kind: "pr", ref: "#1" } } })).toMatchObject({ flavor: "parked", wake: { kind: "parked" } });
    expect(act({ row: { inbox_snoozed_until: NOW + 5 } })).toMatchObject({ flavor: "snoozed", wake: { kind: "snoozed", at: NOW + 5 } });
  });

  test("a hibernated session keeps its flavor and says so", () => {
    expect(act({ row: { hibernated_at: NOW - HOUR, waiting_on: { kind: "person", ref: "@ashot" } } })).toMatchObject({ flavor: "waiting", hibernated: true });
    expect(act({ row: { agent_status: "hibernated" }, triggers: [timed("t", NOW + 1)] })).toMatchObject({ flavor: "scheduled", hibernated: true });
    expect(act({ row: { hibernated_at: NOW - HOUR } })).toMatchObject({ flavor: "stalled", hibernated: true });
  });
});

describe("childrenRunningOf", () => {
  test("counts children with an active status or still producing", () => {
    expect(childrenRunningOf([
      { agent_status: "working" },
      { agent_status: "compacting" },
      { agent_status: "idle", producing_until: NOW + 1 },
      { agent_status: "idle", producing_until: NOW - 1 },
      { agent_status: "stopped" },
      {},
    ], NOW)).toBe(3);
  });
});

describe("shipStageOfCommand", () => {
  test("only an invocation of a pipeline tool counts, never a mention of one", () => {
    for (const command of [
      "bun test", "gh pr view 12", "sleep 300", "gh pr view 263 --json state",
      "cast flow run change --dry-run", "cast flow run build --task ct-1", "cast flow runs",
      "cast deploy --help", "bun test deploy.test.ts", "bun test deploy.sh.test.ts", "CI=1 bun test",
      "bun test packages/cli/src/__tests__/cast-deploy.test.ts", "vim deploy.sh", "cat packages/convex/deploy.sh",
      "grep -r deploy.sh .", "gh run list --workflow deploy.yml", "gh run view 12 --log-failed", "gh workflow run ci.yml",
    ]) expect([command, shipStageOfCommand({ command })]).toEqual([command, null]);
  });

  test("invocations, wherever they sit in the line", () => {
    expect(shipStageOfCommand({ command: "git push && gh pr checks 263 --watch" })).toEqual({ stage: "ci", pr: "#263" });
    expect(shipStageOfCommand({ command: "until gh run view 12 --json status; do sleep 5; done" })).toEqual({ stage: "ci" });
    expect(shipStageOfCommand({ command: "cast flow run flows/ship.cast --task ct-9" })).toEqual({ stage: "ci" });
    expect(shipStageOfCommand({ command: "cast deploy" })).toEqual({ stage: "deploy", target: null });
    expect(shipStageOfCommand({ command: "bash packages/convex/deploy.sh" })).toEqual({ stage: "deploy", target: "convex" });
    expect(shipStageOfCommand({ command: "./scripts/release.sh" })).toEqual({ stage: "deploy", target: null });
    expect(shipStageOfCommand({ command: "fly deploy -a foo" })).toEqual({ stage: "deploy" });
    expect(shipStageOfCommand({ command: "railway up" })).toEqual({ stage: "deploy" });
  });

  test("a deploy script's target is a target flag, never a flag's value", () => {
    expect(shipStageOfCommand({ command: "./deploy.sh --actor Jason --backend" })).toEqual({ stage: "deploy", target: "backend" });
    expect(shipStageOfCommand({ command: "./deploy.sh --actor Jason" })).toEqual({ stage: "deploy", target: null });
    expect(shipStageOfCommand({ command: "./deploy.sh --yes --electric" })).toEqual({ stage: "deploy", target: "electric" });
  });

  test("only a Monitor's description says what it watches", () => {
    expect(shipStageOfCommand({ kind: "monitor", description: "Tail the deploy logs" })).toEqual({ stage: "deploy" });
    expect(shipStageOfCommand({ kind: "monitor", description: "Watch CI" })).toEqual({ stage: "ci" });
    expect(shipStageOfCommand({ kind: "background", command: "bun test convex/deploy.test.ts", description: "Run deploy tests" })).toBeNull();
    expect(shipStageOfCommand({ kind: "background", command: "bun run ci", description: "Run the CI checks locally" })).toBeNull();
    expect(shipStageOfCommand({ description: "Watch CI", command: "bun test" })).toBeNull();
  });
});

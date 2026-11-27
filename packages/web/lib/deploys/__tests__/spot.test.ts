// Where a linked change stands on one target (ct-98574): the deploy that holds it, its place among what waits and what
// holds it there, or its Ship run off main; which targets it is on; and whether an open deploy takes it.
import { describe, expect, test } from "bun:test";
import { changeSpot, focusTargets, openTakes, runWord, type SpotInput } from "../spot";
import { queueCommits } from "../board";

const H = 60 * 60_000;
const NOW = 1_800_000_000_000;

const commit = (sha: string, at: number, extra: any = {}) => ({ sha, subject: `c ${sha}`, at, main_at: at, author: null, session: null, tasks: [], ci: "none", ci_url: null, ...extra });
const deploy = (short_id: string, status: string, sha: string | null, created_at: number, extra: any = {}) => ({
  _id: short_id, workspace: "team:t", target: "cli", repository: "o/r", short_id, status, action: "deploy", rollback_of: null, sha, previous_sha: null,
  version: null, url: null, started_by: null, note: null, commits: 0, sessions: [], created_at, live_at: status === "live" ? created_at : null, finished_at: null, ...extra,
}) as any;

// Live at 1111111 (dp-1); three commits since, oldest first: aaaaaaa, bbbbbbb, ccccccc.
const COMMITS = [commit("ccccccc0", NOW - 1 * H), commit("bbbbbbb0", NOW - 2 * H), commit("aaaaaaa0", NOW - 3 * H)];
const target = (over: any = {}) => ({
  name: "cli", repository: "o/r", policy: "press", runs: "here", can_deploy: true,
  queue: { known: true, truncated: false, commits: 3, untouched: 0, head_sha: "ccccccc0", head_ci: "passed", head_ci_url: "https://ci/1", shown: 3, groups: [{ key: "none", session: null, commits: COMMITS, ci: "passed" }], ...over },
}) as any;
const LIVE = deploy("dp-1", "live", "11111110", NOW - 10 * H);

function input(over: Partial<SpotInput> & { t?: any } = {}): SpotInput {
  const t = over.t ?? target();
  const history = over.history ?? [LIVE];
  return {
    focus: { kind: "sha", sha: "bbbbbbb" }, target: t, queue: queueCommits(t.queue.groups), history, live: LIVE, focusDeploys: [], reach: null,
    paused: false, shipping: { moving: [], dropped: [] }, ...over,
  };
}

describe("a change waiting on main", () => {
  test("says its place among the commits since the live deploy, and that it waits on a press", () => {
    expect(changeSpot(input())).toEqual({ kind: "waiting", place: 2, of: 3, since: "dp-1", held: { kind: "press" } });
  });

  test("counts the older commits the queue did not list ahead of it", () => {
    const t = target({ commits: 40, shown: 3 });
    expect(changeSpot(input({ t }))).toMatchObject({ place: 39, of: 40 });
  });

  test("the failed try that carried it is what holds it, ahead of CI or a press", () => {
    const failed = deploy("dp-3", "failed", "ccccccc0", NOW - 0.5 * H);
    expect(changeSpot(input({ history: [failed, LIVE], reach: { short_id: "dp-3", state: "failed" } })).held).toEqual({ kind: "failed", deploy: "dp-3" });
    // Without reach, a failed deploy whose records list the commit says the same.
    const listed = deploy("dp-4", "failed", "ccccccc0", NOW - 0.5 * H, { commit_rows: [{ sha: "bbbbbbb0", subject: "x" }] });
    expect(changeSpot(input({ history: [listed, LIVE] })).held).toEqual({ kind: "failed", deploy: "dp-4" });
  });

  test("red main CI holds it; running CI holds it only where green CI sends it", () => {
    expect(changeSpot(input({ t: target({ head_ci: "failed" }) })).held).toEqual({ kind: "ci", ci: "failed", url: "https://ci/1" });
    expect(changeSpot(input({ t: target({ head_ci: "running" }) })).held).toEqual({ kind: "press" });
    expect(changeSpot(input({ t: { ...target({ head_ci: "running" }), policy: "auto" } })).held).toEqual({ kind: "ci", ci: "running", url: "https://ci/1" });
    expect(changeSpot(input({ t: { ...target(), policy: "auto" } })).held).toBeNull();
  });

  test("a pause holds it before anything else", () => {
    expect(changeSpot(input({ paused: true, t: target({ head_ci: "failed" }) })).held).toEqual({ kind: "paused" });
  });

  test("a deploy of older commits going out first puts it behind that deploy", () => {
    const going = deploy("dp-5", "running", "aaaaaaa0", NOW - 0.2 * H);
    expect(changeSpot(input({ history: [going, LIVE] }))).toMatchObject({ kind: "waiting", held: { kind: "behind", deploy: "dp-5" } });
  });

  test("an open deploy the queue cannot place holds it by name, never as going out with it", () => {
    // A rollback, a redeploy of the live commit and a commit past a truncated queue: still waiting, held by that deploy.
    for (const d of [deploy("dp-5", "requested", "00000000", NOW - 0.1 * H, { action: "rollback" }), deploy("dp-6", "running", "11111110", NOW - 0.1 * H, { action: "redeploy" }), deploy("dp-7", "running", "99999990", NOW - 0.1 * H)]) {
      expect(changeSpot(input({ history: [d, LIVE] }))).toMatchObject({ kind: "waiting", held: { kind: "open", deploy: d.short_id, going: true } });
    }
    // A press with no commit yet is asked for: it holds the press, and says so, not "waits on Deploy".
    const asked = deploy("dp-8", "requested", null, NOW);
    expect(changeSpot(input({ history: [asked, LIVE], reach: { short_id: "dp-3", state: "failed" } })).held).toEqual({ kind: "open", deploy: "dp-8", going: false });
  });

  test("an open request from before the live deploy is stale: it holds nothing", () => {
    const stale = deploy("dp-1969", "requested", null, NOW - 20 * H);
    expect(changeSpot(input({ history: [LIVE, stale] })).held).toEqual({ kind: "press" });
  });

  test("reach that says it waits, on a commit the queue does not list, still waits (with no place)", () => {
    const spot = changeSpot(input({ focus: { kind: "sha", sha: "9999999" }, reach: { short_id: "", state: "waiting" } }));
    expect(spot).toMatchObject({ kind: "waiting", place: null, of: 3, since: "dp-1" });
  });
});

describe("a change a deploy holds", () => {
  test("a deploy going out at its commit or a newer one is taking it", () => {
    const going = deploy("dp-6", "running", "ccccccc0", NOW - 0.2 * H);
    expect(changeSpot(input({ history: [going, LIVE] }))).toEqual({ kind: "deploy", deploy: "dp-6", word: "going" });
  });

  test("reach names the deploy and how it holds it", () => {
    expect(changeSpot(input({ reach: { short_id: "dp-1", state: "live" } }))).toEqual({ kind: "deploy", deploy: "dp-1", word: "live" });
    expect(changeSpot(input({ reach: { short_id: "dp-9", state: "queued" } }))).toEqual({ kind: "deploy", deploy: "dp-9", word: "asked" });
    expect(changeSpot(input({ reach: { short_id: "dp-8", state: "rolled_back" } }))).toEqual({ kind: "deploy", deploy: "dp-8", word: "rolled_back" });
  });

  test("off the queue, the deploy whose records carry it", () => {
    const old = deploy("dp-0", "live", "0000000a", NOW - 20 * H);
    expect(changeSpot(input({ focus: { kind: "sha", sha: "0000000" }, focusDeploys: [old] }))).toEqual({ kind: "deploy", deploy: "dp-0", word: "went_out" });
    expect(changeSpot(input({ focus: { kind: "deploy", id: "dp-1" }, focusDeploys: [LIVE] }))).toEqual({ kind: "deploy", deploy: "dp-1", word: "live" });
    // An open deploy asked for before the live one never went out, whatever its status says.
    const stale = deploy("dp-2406", "running", "2dc5ee90", NOW - 20 * H);
    expect(changeSpot(input({ focus: { kind: "deploy", id: "dp-2406" }, focusDeploys: [stale] }))).toEqual({ kind: "deploy", deploy: "dp-2406", word: "superseded" });
  });
});

describe("a change not on main", () => {
  const run = (over: any = {}) => ({
    _id: "r1", status: "failed", task_id: null, task_short_id: "ct-7", task_title: "T", workflow_slug: "change", workflow_label: null, current_node_id: "merge", current_node_label: "Not merged",
    node_statuses: [{ node_id: "pr", status: "completed" }, { node_id: "ci", status: "completed" }, { node_id: "review", status: "completed" }, { node_id: "merge", status: "failed" }],
    pr: null, fail_reason: "Stopped: git rebase failed", gate_prompt: null, gate_decision_short_id: null, gate_decision_status: null, spawner_conversation_id: "conv1",
    primary_conversation_id: null, project_path: null, user_id: "u", created_at: NOW - H, updated_at: NOW - H, ...over,
  }) as any;

  test("says where its Ship run stopped, never that it is absent", () => {
    const spot = changeSpot(input({ focus: { kind: "session", id: "conv1" }, shipping: { moving: [run()], dropped: [] } }));
    expect(spot).toMatchObject({ kind: "run", word: "Stopped at Merge", dropped: false });
  });

  test("the session a run ran in finds it as well as the one that pressed Ship", () => {
    expect(changeSpot(input({ focus: { kind: "session", id: "ranin01" }, shipping: { moving: [run({ primary_conversation_id: "ranin01" })], dropped: [] } }))).toMatchObject({ kind: "run" });
  });

  test("a run with no movement for a week reads as parked; one still moving says its state", () => {
    expect(changeSpot(input({ focus: { kind: "task", id: "ct-7" }, shipping: { moving: [], dropped: [run()] } }))).toMatchObject({ kind: "run", dropped: true });
    expect(runWord(run({ status: "paused", gate_decision_short_id: "sd-1" }))).toBe("Waiting on a decision");
  });

  test("while Shipping is read it is looking; once read and nowhere, it is not on this target", () => {
    expect(changeSpot(input({ focus: { kind: "session", id: "nobody" }, shipping: null }))).toEqual({ kind: "reading" });
    expect(changeSpot(input({ focus: { kind: "session", id: "nobody" } }))).toEqual({ kind: "absent" });
    expect(changeSpot(input({ focus: { kind: "session", id: "nobody" }, shipping: null, shippingError: true }))).toEqual({ kind: "absent" });
  });
});

test("the targets a change is on: by reach when it has answered, else by what each target holds", () => {
  const cli = target();
  const web = { ...target({ groups: [] }), name: "web" };
  expect([...focusTargets([cli, web], [], { kind: "sha", sha: "bbbbbbb" }, null)]).toEqual(["cli"]);
  expect([...focusTargets([cli, web], [], { kind: "sha", sha: "bbbbbbb" }, { targets: [{ target: "web" }] })]).toEqual(["web"]);
  expect([...focusTargets([cli, web], [deploy("dp-2", "live", "x", NOW, { target: "web" })], { kind: "deploy", id: "dp-2" }, null)]).toEqual(["web"]);
  expect(focusTargets([cli, web], [], null, null).size).toBe(0);
});

describe("an open deploy takes a waiting change", () => {
  const queue = queueCommits([{ key: "none", session: null, commits: COMMITS, ci: "passed" } as any]);
  const b = [queue[1]];
  test("only when it names a commit: a stale request with none takes nothing", () => {
    expect(openTakes(deploy("dp-1969", "requested", null, NOW), queue, b)).toBe(false);
  });
  test("at a listed commit, it takes that one and older", () => {
    expect(openTakes(deploy("dp-7", "running", "ccccccc0", NOW), queue, b)).toBe(true);
    expect(openTakes(deploy("dp-7", "running", "aaaaaaa0", NOW), queue, b)).toBe(false);
  });
  test("at a commit the queue does not list, nobody knows: it claims nothing, however recently it was asked for", () => {
    // A rollback to an older commit, a redeploy of the live one, a commit past a truncated queue, main's head.
    expect(openTakes(deploy("dp-5", "requested", "00000000", NOW, { action: "rollback" }), queue, b)).toBe(false);
    expect(openTakes(deploy("dp-6", "running", "11111110", NOW, { action: "redeploy" }), queue, b)).toBe(false);
    expect(openTakes(deploy("dp-7", "running", "fffffff0", NOW), queue, b)).toBe(false);
  });
  test("a finished deploy takes nothing", () => {
    expect(openTakes(deploy("dp-7", "live", "ccccccc0", NOW), queue, b)).toBe(false);
  });
});

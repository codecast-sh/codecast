import { describe, expect, test } from "bun:test";
import { pressLedger, rollBackHere } from "../press";
import type { DeployTargetRow, TeamDeployRow } from "../targets";

const target = (over: Partial<DeployTargetRow> = {}): DeployTargetRow => ({
  _id: "r#web", workspace: "team:t", team_id: "t", name: "web", repository: "o/r", runs: "here", policy: "press", command: "x", rollback: null, paths: [],
  can_deploy: true, can_redeploy_sha: true, can_rollback: false, device_id: "d", publisher_user_id: "u",
  queue: { known: true, truncated: false, commits: 0, untouched: 0, head_sha: "h", head_ci: "passed", head_ci_url: null, shown: 0, groups: [] },
  ...over,
});
const dp = (id: string, status: TeamDeployRow["status"], at: number, over: Partial<TeamDeployRow> = {}): TeamDeployRow => ({
  _id: id, workspace: "team:t", target: "web", repository: "o/r", short_id: id, status, action: "deploy", rollback_of: null, sha: `${id.slice(3)}000000`, previous_sha: null,
  version: null, url: null, started_by: null, note: null, commits: 0, sessions: [], created_at: at, live_at: status === "live" ? at : null, finished_at: null, ...over,
});

describe("roll back here", () => {
  const d = [dp("dp-1", "live", 1), dp("dp-2", "live", 2)];
  test("a replaced live deploy offers its sha back, by redeploy where the target can send any sha", () => {
    expect(rollBackHere(d[0], target(), d)).toMatchObject({ action: "redeploy", of: { _id: "dp-1" } });
    expect(rollBackHere(d[0], target({ can_redeploy_sha: false, can_rollback: true }), d)?.action).toBe("rollback");
  });
  test("never for what is live now, the same sha, a target that cannot go back, or while a deploy is going out", () => {
    expect(rollBackHere(d[1], target(), d)).toBeNull();
    expect(rollBackHere(dp("dp-0", "live", 0, { sha: "2000000" }), target(), [...d, dp("dp-0", "live", 0, { sha: "2000000" })])).toBeNull();
    expect(rollBackHere(d[0], target({ can_redeploy_sha: false }), d)).toBeNull();
    expect(rollBackHere(d[0], target(), [...d, dp("dp-3", "running", 3)])).toBeNull();
    expect(rollBackHere(d[0], undefined, d)).toBeNull();
  });
  test("over a dev watcher's push, the real deploy of the same sha is the way back", () => {
    const real = dp("dp-1", "live", 1, { sha: "aaa0000" });
    const watcher = dp("dp-2", "live", 2, { sha: "aaa0000", pushed_via: "dev watcher", dirty: 3 });
    expect(rollBackHere(real, target(), [real, watcher])).toMatchObject({ action: "redeploy", of: { _id: "dp-1" } });
  });
  test("never for a dev watcher's push: it ran files no sha holds", () => {
    const watcher = dp("dp-1", "live", 1, { pushed_via: "dev watcher", dirty: 2 });
    expect(rollBackHere(watcher, target(), [watcher, d[1]])).toBeNull();
  });
  test("its ledger says what goes back live and from what", () => {
    const l = pressLedger(rollBackHere(d[0], target(), d)!, d);
    expect(l.shift).toEqual(["2000000", "1000000"]);
    expect(l.confirm).toBe("Redeploy");
    expect(l.rows.find((r) => r.k === "To undo")?.v).toBe("Deploy 2000000 again");
  });
});

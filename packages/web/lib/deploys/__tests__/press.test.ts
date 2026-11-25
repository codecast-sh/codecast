import { describe, expect, test } from "bun:test";
import { SAY_WHY, pauseLedger, pressLedger, rollBackHere, rollbackLedger, rollbackOffer } from "../press";
import { productionOf, type DeployProductionRow, type DeployTargetRow, type TeamDeployRow } from "../targets";

const target = (over: Partial<DeployTargetRow> = {}): DeployTargetRow => ({
  _id: "r#web", workspace: "team:t", team_id: "t", name: "web", repository: "o/r", runs: "here", policy: "press", command: "x", rollback: null, paths: [],
  can_deploy: true, can_redeploy_sha: true, can_rollback: false, device_id: "d", publisher_user_id: "u",
  queue: { known: true, truncated: false, commits: 0, untouched: 0, head_sha: "h", head_ci: "passed", head_ci_url: null, shown: 0, groups: [] },
  ...over,
});
const production = (over: Partial<DeployProductionRow> = {}): DeployProductionRow => ({ _id: "o/r", workspace: "team:t", team_id: "t", repository: "o/r", pause: null, can_pause: true, can_lift: false, ...over });
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
  test("its ledger says what goes back live and from what", () => {
    const l = pressLedger(rollBackHere(d[0], target(), d)!, d, production());
    expect(l.shift).toEqual(["2000000", "1000000"]);
    expect(l.confirm).toBe("Redeploy");
    expect(l.rows.find((r) => r.k === "To undo")?.v).toBe("Deploy 2000000 again");
  });
});

describe("pause and the paused roll back (DP17, DP19)", () => {
  const d = [dp("dp-1", "live", 1), dp("dp-2", "live", 2)];
  const wf = (over: Partial<DeployTargetRow> = {}) => target({ workflow: "deploy.yml", rollback_inputs: { components: "backend-web" }, ...over });
  const holds = production();

  test("a workflow target goes back only through codecast's rollback, offered to a viewer who holds the pause", () => {
    expect(rollBackHere(d[0], wf(), d)).toBeNull();
    expect(rollbackOffer(d[0], wf(), holds, d)).toMatchObject({ of: { _id: "dp-1" } });
    expect(rollbackOffer(d[0], wf(), production({ can_pause: false }), d)).toBeNull();
    expect(rollbackOffer(d[0], wf(), undefined, d)).toBeNull();
    expect(rollbackOffer(d[0], target(), holds, d)).toBeNull();
    expect(rollbackOffer(d[1], wf(), holds, d)).toBeNull();
    // It queues behind a deploy going out instead of waiting for it.
    expect(rollbackOffer(d[0], wf(), holds, [...d, dp("dp-3", "running", 3)])).toMatchObject({ of: { _id: "dp-1" } });
  });

  test("pause and roll back confirm only with a reason; a rollback needs its workflow's rollback inputs", () => {
    const t = wf();
    const all = [t, target({ _id: "r#api", name: "api" }), target({ _id: "x#web", repository: "o/other" })];
    const going = [...d, dp("dp-3", "requested", 3)];
    expect(pauseLedger(t, all, going, " ").blocked).toBe(SAY_WHY);
    const l = pauseLedger(t, all, going, "errors spiking");
    expect(l.blocked).toBeUndefined();
    expect(l.rows.find((r) => r.k === "Stops")?.list).toEqual(["web", "api"]);
    expect(l.rows.find((r) => r.k === "Cancels")?.list).toEqual(["dp-3 to web"]);
    const p = rollbackOffer(d[0], t, holds, d)!;
    expect(rollbackLedger(p, d, "").blocked).toBe(SAY_WHY);
    expect(rollbackLedger(p, d, "bad deploy")).toMatchObject({ confirm: "Roll back", shift: ["2000000", "1000000"] });
    expect(rollbackLedger(p, d, "bad deploy").blocked).toBeUndefined();
    expect(rollbackLedger({ ...p, target: wf({ rollback_inputs: null }) }, d, "bad deploy").blocked).toBe("deploy.yml names no rollback_inputs");
  });

  test("while its repository is paused only a rollback confirms", () => {
    const paused = production({ pause: { repository: "o/r", by: "Ana", reason: "x", at: 1, lifts: "", rollback: null, until: null } });
    const t = target();
    expect(pressLedger({ target: t, action: "deploy", of: null }, d, paused).blocked).toBe("Production is paused");
    expect(pressLedger({ target: t, action: "redeploy", of: d[0] }, d, paused).blocked).toBe("Production is paused");
    expect(pressLedger({ target: t, action: "rollback", of: d[0] }, d, paused).blocked).toBeUndefined();
    expect(pressLedger({ target: t, action: "deploy", of: null }, d, production()).blocked).toBeUndefined();
  });

  test("a target reads its repository's production in its own workspace", () => {
    const rows = [production(), production({ _id: "o/other", repository: "o/other" }), production({ workspace: "team:u", team_id: "u" })];
    expect(productionOf(rows, target())).toBe(rows[0]);
    expect(productionOf(rows, target({ repository: "o/other" }))).toBe(rows[1]);
    expect(productionOf(rows, target({ workspace: "team:v" }))).toBeUndefined();
  });
});

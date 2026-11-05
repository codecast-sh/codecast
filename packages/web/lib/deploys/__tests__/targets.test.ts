import { describe, expect, test } from "bun:test";
import { orderTargets, rollbackTarget, sessionTargets, targetNow, targetTone, type DeployTargetRow, type TeamDeployRow } from "../targets";

const target = (name: string, over: Partial<DeployTargetRow> = {}, groups: DeployTargetRow["queue"]["groups"] = []): DeployTargetRow => ({
  _id: `r#${name}`, workspace: "team:t", team_id: "t", name, repository: "o/r", runs: "here", policy: "press", command: "x", rollback: null, paths: [],
  can_deploy: true, can_redeploy_sha: false, can_rollback: false, device_id: "d", publisher_user_id: "u",
  queue: { known: true, truncated: false, commits: groups.reduce((n, g) => n + g.commits.length, 0), untouched: 0, head_sha: "h", head_ci: "passed", head_ci_url: null, shown: 0, groups },
  ...over,
});
const dp = (id: string, t: string, status: TeamDeployRow["status"], at: number, over: Partial<TeamDeployRow> = {}): TeamDeployRow => ({
  _id: id, workspace: "team:t", target: t, repository: "o/r", short_id: id, status, action: "deploy", rollback_of: null, sha: `sha-${id}`, previous_sha: null,
  version: null, url: null, started_by: null, note: null, commits: 0, sessions: [], created_at: at, live_at: status === "live" ? at : null, finished_at: null, ...over,
});
const group = (conv: string | null, n: number) => ({ key: conv ? `s:${conv}` : "none", session: conv ? { conversation_id: conv, short_id: conv.slice(0, 7), title: conv } : null, ci: "passed" as const, commits: Array.from({ length: n }, (_, i) => ({ sha: `${conv}${i}`, subject: "s", at: i, author: null, session: null, tasks: [], ci: "passed" as const, ci_url: null })) });

describe("targetNow", () => {
  test("live is the newest live deploy; open is the one going out; a failed newest is flagged", () => {
    const d = [dp("dp-1", "web", "live", 1), dp("dp-2", "web", "live", 2), dp("dp-3", "web", "failed", 3), dp("dp-9", "backend", "live", 9)];
    const n = targetNow(target("web"), d);
    expect(n.live?._id).toBe("dp-2");
    expect(n.failed?._id).toBe("dp-3");
    expect(n.open).toBeNull();
    expect(n.history.map((x) => x._id)).toEqual(["dp-3", "dp-2", "dp-1"]);
  });
  test("roll back goes to the newest earlier live deploy on another sha", () => {
    const d = [dp("dp-1", "web", "live", 1), dp("dp-2", "web", "live", 2, { sha: "sha-dp-1" }), dp("dp-3", "web", "live", 3)];
    const n = targetNow(target("web"), d);
    expect(rollbackTarget(n.history, n.live)?._id).toBe("dp-2");
  });
});

describe("tones and order", () => {
  test("going out, then failed, then waiting by size, then up to date", () => {
    const ts = [target("a"), target("b", {}, [group("c1", 3)]), target("c", {}, [group("c2", 9)]), target("d"), target("e")];
    const d = [dp("x1", "a", "live", 1), dp("x2", "d", "running", 2), dp("x3", "e", "failed", 3), dp("x4", "b", "live", 1), dp("x5", "c", "live", 1)];
    expect(orderTargets(ts, d).map((t) => t.name)).toEqual(["d", "e", "c", "b", "a"]);
    expect(targetTone(ts[0], targetNow(ts[0], d))).toBe("current");
  });
});

describe("sessionTargets", () => {
  test("a session's change is waiting where its commits wait, going out where a deploy carries it, live where a live one did", () => {
    const ts = [target("web", {}, [group("conv1", 2)]), target("backend"), target("cli")];
    const d = [dp("dp-5", "backend", "running", 5, { sessions: [{ conversation_id: "conv1", title: "One" }] }), dp("dp-4", "cli", "live", 4, { sessions: ["conv1"] as any })];
    expect(sessionTargets("conv1", ts, d)).toEqual([
      { name: "web", state: "waiting" },
      { name: "backend", state: "deploying", deploy: "dp-5", at: 5 },
      { name: "cli", state: "live", deploy: "dp-4", at: 4 },
    ]);
    expect(sessionTargets("other", ts, d)).toEqual([]);
  });
});

describe("dp-N is a reference", () => {
  test("it reads as a deploy and opens on the Deploys page at that deploy", () => {
    const { entityRoute, entityTypeFromId } = require("../../entityLinks");
    expect(entityTypeFromId("dp-12")).toBe("deploy");
    expect(entityTypeFromId("dp-x")).toBeNull();
    expect(entityRoute("deploy", "dp-12")).toBe("/deploys?deploy=dp-12");
  });
});

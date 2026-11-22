import { describe, expect, test } from "bun:test";
import { isMineCommit, mineOnly, orderTargets, prOfSubject, rebuiltOnly, rollbackTarget, sessionTargets, targetNow, targetTone, teamRowOfView, type DeployTargetRow, type TeamDeployRow } from "../targets";

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
  test("a deploy asked for before the live one is not going out: a newer deploy superseded it", () => {
    const d = [dp("dp-1969", "web", "requested", 1), dp("dp-2299", "web", "live", 5)];
    expect(targetNow(target("web"), d).open).toBeNull();
    const after = [...d, dp("dp-2400", "web", "running", 9)];
    expect(targetNow(target("web"), after).open?._id).toBe("dp-2400");
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

describe("a deploy alone", () => {
  const view = {
    _id: "d1", short_id: "dp-28", project_id: null, target: "web", status: "live" as const, trigger: "manual" as any,
    started_by: { kind: "person" as const, name: "Ada" }, source: "cast", repository: "acme/app", sha: "bbb", previous_sha: "aaa",
    version: null, url: null, note: null, action: null, created_at: 1, live_at: 2, finished_at: 2,
    commits: [{ sha: "c1", subject: "fix", conversation_id: "conv1" }, { sha: "c2", subject: "more", conversation_id: "conv1" }, { sha: "c3", subject: "by hand" }],
    carries: [{ task_id: "t1", how: "merged" as any, task_short_id: "ct-1", task_title: "Fix it", decision_short_id: null }],
  };
  test("reads as the row the Deploys page lists", () => {
    const row = teamRowOfView(view as any, "team:x");
    expect(row).toMatchObject({ workspace: "team:x", short_id: "dp-28", action: "deploy", started_by: "Ada", commits: 3, sessions: [{ conversation_id: "conv1" }], tasks: [{ short_id: "ct-1", title: "Fix it" }] });
    expect(row.commit_rows?.map((c) => c.sha)).toEqual(["c1", "c2", "c3"]);
    // A view without a push record reads as a clean row.
    expect(row).toMatchObject({ dirty: null, machine: null, pushed_via: null, adds_count: 0, drops_count: 0 });
  });
  test("carries how the push got there as counts, never the names", () => {
    const row = teamRowOfView({ ...view, dirty: 3, machine: "ana-mac", pushed_via: "dev watcher", adds: ["fn:a:b"], drops: ["index:t.i", "table:t"] } as any, "team:x");
    expect(row).toMatchObject({ dirty: 3, machine: "ana-mac", pushed_via: "dev watcher", adds_count: 1, drops_count: 2 });
    expect(row).not.toHaveProperty("drops");
  });
  test("is a rebuild only when it sent the sha already live", () => {
    const base = { status: "live" as const, action: "deploy" as const, commits: 0 };
    expect(rebuiltOnly({ ...base, sha: "a", previous_sha: "a" })).toBe(true);
    expect(rebuiltOnly({ ...base, sha: "b", previous_sha: null })).toBe(true);
    expect(rebuiltOnly({ ...base, sha: "b", previous_sha: "a" })).toBe(false);
    expect(rebuiltOnly({ ...base, commits: 2, sha: "a", previous_sha: "a" })).toBe(false);
  });
});

describe("the viewer's pull requests in the queue", () => {
  test("a squash merge's trailing (#N) becomes the PR number and leaves the subject", () => {
    expect(prOfSubject("Gate reuses a floor pass (sd-4131) (#4431)")).toEqual({ pr: 4431, subject: "Gate reuses a floor pass (sd-4131)" });
    expect(prOfSubject("Give the production broker web search")).toEqual({ pr: null, subject: "Give the production broker web search" });
    expect(prOfSubject("Fix (#12) in the middle")).toEqual({ pr: null, subject: "Fix (#12) in the middle" });
    expect(prOfSubject("Merge pull request #12 from a/b")).toEqual({ pr: 12, subject: "Merge pull request #12 from a/b" });
  });
  test("a commit is mine by GitHub login or name, ignoring case", () => {
    const me = { login: "JasonBenn", name: "Jason Benn" };
    expect(isMineCommit("jasonbenn", me)).toBe(true);
    expect(isMineCommit("Jason Benn", me)).toBe(true);
    expect(isMineCommit("Ashot Petrosian", me)).toBe(false);
    expect(isMineCommit(null, me)).toBe(false);
    expect(isMineCommit("x", { login: null, name: null })).toBe(false);
  });
  test("mine keeps only my commits, drops groups without any, and recomputes the group's CI", () => {
    const c = (sha: string, author: string, ci: "passed" | "failed") => ({ sha, subject: "s", at: 1, author, session: null, tasks: [], ci, ci_url: null });
    const groups = [
      { key: "s:a", session: null, ci: "failed" as const, commits: [c("1", "JasonBenn", "passed"), c("2", "Ashot", "failed")] },
      { key: "s:b", session: null, ci: "passed" as const, commits: [c("3", "Ashot", "passed")] },
    ];
    const out = mineOnly(groups, { login: "JasonBenn", name: null });
    expect(out.map((g: any) => [g.key, g.commits.map((x: any) => x.sha), g.ci])).toEqual([["s:a", ["1"], "passed"]]);
  });
});

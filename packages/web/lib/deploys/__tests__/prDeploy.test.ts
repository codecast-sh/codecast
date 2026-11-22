import { describe, expect, test } from "bun:test";
import type { DeployReach, TargetReach } from "@codecast/shared/contracts/deployReach";
import { isDormant, prDeployRows, prReachHeadline, prRowLine, prRowParts, prShipsTo } from "../prDeploy";
import type { DeployTargetRow, TeamDeployRow } from "../targets";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const SHA = "e34194b317bf96ec5b4a9f3859356891b1f90e69";

const commit = (sha: string) => ({ sha, subject: "s", at: 1, author: null, session: null, tasks: [], ci: "passed" as const, ci_url: null });
const target = (name: string, over: Partial<DeployTargetRow> = {}, shas: string[] = []): DeployTargetRow => ({
  _id: `o/r#${name}`, workspace: "team:t", team_id: "t", name, repository: "o/r", runs: "here", policy: "press", command: "x", rollback: null, paths: [],
  can_deploy: true, can_redeploy_sha: false, can_rollback: false, device_id: "d", publisher_user_id: "u",
  queue: { known: true, truncated: false, commits: shas.length, untouched: 0, head_sha: shas[0] ?? null, head_ci: "running", head_ci_url: "https://ci", shown: shas.length, groups: shas.length ? [{ key: "none", session: null, ci: "passed", commits: shas.map(commit) }] : [] },
  ...over,
});
const ref = (short_id: string, at: number, status: "live" | "running" | "requested" | "failed" = "live") => ({ short_id, status, sha: `${short_id}-sha`, at, url: null });
const tr = (target: string, state: TargetReach["state"], over: Partial<TargetReach> = {}): TargetReach => ({ target, state, deploy: null, now: null, ...over });
const reach = (targets: TargetReach[]): DeployReach => ({ state: "waiting", sha: SHA, targets });
const dp = (short_id: string, target: string, status: TeamDeployRow["status"], over: Partial<TeamDeployRow> = {}): TeamDeployRow => ({
  _id: short_id, workspace: "team:t", target, repository: "o/r", short_id, status, action: "deploy", rollback_of: null, sha: null, previous_sha: null,
  version: null, url: null, started_by: null, note: null, commits: 0, sessions: [], created_at: NOW - DAY, live_at: null, finished_at: null, ...over,
});

describe("prDeployRows", () => {
  test("a waiting change counts the commits waiting with it and offers the press that sends them all", () => {
    const t = target("production", {}, ["47f600b0", SHA.slice(0, 9), "4b0da90d"]);
    const { rows } = prDeployRows(reach([tr("production", "waiting", { now: ref("dp-2240", NOW - DAY / 3) })]), [t], [], "o/r", NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].queue).toEqual({ others: 2, atLeast: false, ci: "running", ciUrl: "https://ci" });
    expect(rows[0].press?.name).toBe("production");
    expect(rows[0].pressWords).toBe("Deploy 3 commits");
  });

  test("past the listed queue the count is unknown, not wrong", () => {
    const t = target("production", { queue: { ...target("x", {}, ["aaaaaaa1"]).queue, commits: 80, shown: 1 } });
    const { rows } = prDeployRows(reach([tr("production", "waiting")]), [t], [], "o/r", NOW);
    expect(rows[0].queue?.others).toBeNull();
  });

  test("a change missing from a queue shown whole claims no place in it", () => {
    const t = target("production", {}, ["aaaaaaa1", "bbbbbbb2", "ccccccc3"]);
    const { rows } = prDeployRows(reach([tr("production", "waiting")]), [t], [], "o/r", NOW);
    expect(rows[0].queue).toBeNull();
  });

  test("a scan cut short counts at least, and the press says so", () => {
    const base = target("production", {}, [SHA]);
    const t = { ...base, queue: { ...base.queue, commits: 200, shown: 50, truncated: true } };
    const { rows } = prDeployRows(reach([tr("production", "waiting")]), [t], [], "o/r", NOW);
    expect(rows[0].queue).toMatchObject({ others: 199, atLeast: true });
    expect(rows[0].pressWords).toBe("Deploy 200+ commits");
  });

  test("an empty known queue offers no press, as the Deploys page", () => {
    const { rows } = prDeployRows(reach([tr("production", "waiting")]), [target("production")], [], "o/r", NOW);
    expect(rows[0].press).toBeNull();
    expect(rows[0].blocked).toBe("Nothing waiting");
  });

  test("the repository matches whatever its case", () => {
    const { rows } = prDeployRows(reach([tr("production", "waiting")]), [target("production", {}, [SHA])], [], "O/R", NOW);
    expect(rows[0].press?.name).toBe("production");
  });

  test("no press while a deploy is going out, on a push target, or with no publisher", () => {
    const going = prDeployRows(reach([tr("production", "waiting")]), [target("production", {}, [SHA])], [dp("dp-9", "production", "running")], "o/r", NOW).rows[0];
    expect(going.press).toBeNull();
    expect(going.blocked).toBe("dp-9 is going out");
    expect(prDeployRows(reach([tr("web", "waiting")]), [target("web", { runs: "push" })], [], "o/r", NOW).rows[0].blocked).toBe("Goes out when main moves");
    expect(prDeployRows(reach([tr("web", "waiting")]), [target("web", { can_deploy: false })], [], "o/r", NOW).rows[0].blocked).toBe("No machine publishes it");
  });

  test("a live row has no queue and no press; a failed row carries its deploy's note and a press to try again", () => {
    const failed = dp("dp-7", "api", "failed", { note: "health check timed out" });
    const { rows } = prDeployRows(
      reach([tr("web", "live", { deploy: ref("dp-5", NOW - 3600_000) }), tr("api", "failed", { deploy: ref("dp-7", NOW - 60_000, "failed") })]),
      [target("web"), target("api", {}, [SHA])],
      [failed],
      "o/r",
      NOW,
    );
    expect(rows.map((r) => r.target)).toEqual(["api", "web"]);
    expect(rows[0].note).toBe("health check timed out");
    expect(rows[0].pressWords).toBe("Deploy 1 commit");
    expect(rows[1].press).toBeNull();
    expect(rows[1].queue).toBeNull();
  });

  test("a target the viewer's team does not declare keeps its row, without a queue or press", () => {
    const { rows } = prDeployRows(reach([tr("elsewhere", "waiting")]), [], [], "o/r", NOW);
    expect(rows[0]).toMatchObject({ target: "elsewhere", queue: null, press: null });
  });

  test("a dormant target leaves the rows and is named apart", () => {
    const { rows, dormant } = prDeployRows(
      reach([{ ...tr("aivery-operator", "waiting", { now: ref("dp-310", NOW - 16 * DAY) }), dormant: true }, tr("production", "live", { deploy: ref("dp-1", NOW) })]),
      [],
      [],
      "o/r",
      NOW,
    );
    expect(rows.map((r) => r.target)).toEqual(["production"]);
    expect(dormant).toEqual([{ target: "aivery-operator", at: NOW - 16 * DAY }]);
  });
});

describe("isDormant", () => {
  const op = target("aivery-operator");
  test("the server's mark wins", () => {
    expect(isDormant({ ...tr("aivery-operator", "live", { deploy: ref("a", NOW) }), dormant: true }, undefined, [], NOW)).toBe(true);
  });
  test("without a mark, the team's deploys of the target decide by the server's rule", () => {
    const old = dp("dp-310", "aivery-operator", "live", { live_at: NOW - 16 * DAY, created_at: NOW - 16 * DAY });
    expect(isDormant(tr("aivery-operator", "waiting"), op, [old], NOW)).toBe(true);
    // A deploy asked for, running, or failed within the week keeps it speaking, whatever its live deploy's age.
    expect(isDormant(tr("aivery-operator", "waiting"), op, [old, dp("dp-400", "aivery-operator", "running", { created_at: NOW - 60_000 })], NOW)).toBe(false);
    expect(isDormant(tr("aivery-operator", "waiting"), op, [old, dp("dp-401", "aivery-operator", "failed", { created_at: NOW - DAY, finished_at: NOW - DAY })], NOW)).toBe(false);
    // No deploys in hand: unknown, so it keeps its row.
    expect(isDormant(tr("aivery-operator", "waiting"), op, [], NOW)).toBe(false);
    expect(isDormant(tr("aivery-operator", "waiting"), undefined, [old], NOW)).toBe(false);
  });
});

describe("prReachHeadline", () => {
  const row = (target: string, state: TargetReach["state"]) => ({ target, state, deploy: null, now: null, note: null, queue: null, press: null, pressWords: null, blocked: null });
  test("names the target when it is one, counts when they are many", () => {
    expect(prReachHeadline("waiting", [row("production", "waiting")])?.words).toBe("Not live yet on production");
    expect(prReachHeadline("going_out", [row("production", "going_out")])?.words).toBe("Deploying to production");
    expect(prReachHeadline("live", [row("a", "live"), row("b", "live")])?.words).toBe("Live on a and b");
    expect(prReachHeadline("live", [row("a", "live"), row("b", "live"), row("c", "live")])?.words).toBe("Live on all 3 targets");
    expect(prReachHeadline("failed", [row("api", "failed"), row("web", "live")])?.words).toBe("Deploy failed on api · live on 1 of 2");
    expect(prReachHeadline("waiting", [row("a", "waiting"), row("b", "waiting")])?.words).toBe("Not live yet");
    expect(prReachHeadline("queued", [row("a", "queued")])?.words).toBe("Deploy queued on a");
    expect(prReachHeadline(null, [])).toBeNull();
  });
  test("the server's verdict leads, even when every target is idle", () => {
    expect(prReachHeadline("waiting", [])?.words).toBe("Not live yet");
    expect(prReachHeadline("live", [])?.words).toBe("Live");
  });
});

describe("prShipsTo", () => {
  const names = (r: ReturnType<typeof prShipsTo>) => (r ?? []).map((x) => x.target.name);
  test("targets whose paths the files touch; a pathless target speaks only where none names paths", () => {
    const ts = [target("production", { paths: ["outreach/backend/**"] }), target("dashboard", { paths: ["outreach/landing/**"] }), target("all", { paths: [] })];
    expect(names(prShipsTo(ts, [], "o/r", ["outreach/backend/x.ts"], NOW))).toEqual(["production"]);
    expect(prShipsTo(ts, [], "o/r", ["docs/x.md"], NOW)).toEqual([]);
    expect(names(prShipsTo([target("all")], [], "o/r", ["docs/x.md"], NOW))).toEqual(["all"]);
    expect(prShipsTo(ts, [], "other/repo", ["outreach/backend/x.ts"], NOW)).toEqual([]);
    expect(prShipsTo(ts, [], "o/r", undefined, NOW)).toBeNull();
    expect(names(prShipsTo(ts, [], "O/R", ["outreach/backend/x.ts"], NOW))).toEqual(["production"]);
  });
  test("a target idle for a week comes last, marked", () => {
    const ts = [target("aivery-operator", { paths: ["b/**"] }), target("production", { paths: ["b/**"] })];
    const d = [dp("dp-310", "aivery-operator", "live", { live_at: NOW - 16 * DAY }), dp("dp-2240", "production", "live", { live_at: NOW - DAY / 3 })];
    expect(prShipsTo(ts, d, "o/r", ["b/x.ts"], NOW)!.map((x) => [x.target.name, x.idle])).toEqual([["production", false], ["aivery-operator", true]]);
  });
});

describe("prRowParts and prRowLine", () => {
  const HOUR = 3600_000;
  const row = (over: Partial<import("../prDeploy").PrDeployRow>) => ({ target: "production", state: "waiting" as const, deploy: null, now: null, note: null, queue: null, press: null, pressWords: null, blocked: null, ...over });
  // A deploy whose sha is not known reads as its dp-N.
  const bare = (short_id: string, at: number, status: "live" | "failed" = "live") => ({ ...ref(short_id, at, status), sha: null });
  const live = bare("dp-2240", NOW - 7 * HOUR);
  test("a live row names its deploy, when, and how long after merge", () => {
    const parts = prRowParts(row({ state: "live", deploy: live }), NOW, NOW - 9 * HOUR);
    expect(parts.map((p) => p.key)).toEqual(["d", "t", "lag"]);
    expect(prRowLine(parts)).toBe("in dp-2240 · went live 7h ago · 2h after merge");
  });
  test("a waiting row says how long, what waits with it, CI, and what is live instead", () => {
    const parts = prRowParts(row({ now: live, queue: { others: 16, atLeast: false, ci: "running", ciUrl: null } }), NOW, NOW - 7 * HOUR);
    expect(prRowLine(parts)).toBe("waiting 7h · with 16 other commits · CI running · live now dp-2240");
  });
  test("a failed row says what is live now too", () => {
    const parts = prRowParts(row({ state: "failed", deploy: bare("dp-9", NOW - HOUR, "failed"), now: live }), NOW, null);
    expect(prRowLine(parts)).toBe("in dp-9 · failed 1h ago · live now dp-2240");
  });
  test("a rolled-back row names both deploys", () => {
    const parts = prRowParts(row({ state: "rolled_back", deploy: bare("dp-5", NOW - 2 * HOUR), now: bare("dp-4", NOW - HOUR) }), NOW, null);
    expect(prRowLine(parts)).toBe("was live in dp-5 · rolled back to dp-4 1h ago");
  });
  test("a deploy reads as its short sha when it has one; no CI part when none ran", () => {
    const parts = prRowParts(row({ now: { ...live, sha: "ca5afca75" }, queue: { others: 0, atLeast: false, ci: "none", ciUrl: null } }), NOW, null);
    expect(prRowLine(parts)).toBe("the only commit waiting · live now ca5afca");
  });
});

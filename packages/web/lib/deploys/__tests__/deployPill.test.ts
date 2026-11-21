import { describe, expect, test } from "bun:test";
import { REACH_LOOK, deployAgo, deployElapsed, deployHeadline, deployMatchesRef, deployPillState, deployPillSuffix, deployStepLabel, deployTone, reachTime, replacedLine, runRefKey, DEPLOY_PILL_TONE } from "../deployPill";
import { deployTitle } from "../../line/deployWords";

const MIN = 60_000;
const now = 1_790_000_000_000;
const clock = (ts: number) => `@${(now - ts) / MIN}m`;

describe("deploy pill words", () => {
  test("elapsed reads as precise as is worth reading: minutes, hours and minutes under 10h, hours, then days and hours", () => {
    expect(deployElapsed(0)).toBe("<1m");
    expect(deployElapsed(59_999)).toBe("<1m");
    expect(deployElapsed(12 * MIN + 30_000)).toBe("12m");
    expect(deployElapsed(82 * MIN)).toBe("1h 22m");
    expect(deployElapsed(120 * MIN)).toBe("2h");
    expect(deployElapsed(9 * 60 * MIN + 59 * MIN)).toBe("9h 59m");
    expect(deployElapsed(10 * 60 * MIN + 3 * MIN)).toBe("10h");
    expect(deployElapsed(20 * 60 * MIN + 3 * MIN)).toBe("20h");
    expect(deployElapsed(23 * 60 * MIN + 59 * MIN)).toBe("23h");
    expect(deployElapsed(24 * 60 * MIN)).toBe("1d");
    expect(deployElapsed((3 * 24 + 2) * 60 * MIN + 40 * MIN)).toBe("3d 2h");
    expect(deployElapsed(-5 * MIN)).toBe("<1m");
  });

  test("ago reads in its largest unit, and just now under a minute", () => {
    expect(deployAgo(now - 30_000, now)).toBe("just now");
    expect(deployAgo(now - 11 * MIN, now)).toBe("11m ago");
    expect(deployAgo(now - 5 * 60 * MIN - 3 * MIN, now)).toBe("5h ago");
    expect(deployAgo(now - 50 * 60 * MIN, now)).toBe("2d ago");
  });

  test("each status has its own state, and a live deploy a newer one replaced reads as replaced", () => {
    expect(deployPillState({ status: "requested" })).toBe("waiting");
    expect(deployPillState({ status: "running" })).toBe("going_out");
    expect(deployPillState({ status: "live" })).toBe("live");
    expect(deployPillState({ status: "live", after: { open: true } })).toBe("live");
    expect(deployPillState({ status: "live", after: { open: false } })).toBe("replaced");
    expect(deployPillState({ status: "failed" })).toBe("failed");
    expect(deployPillState({ status: "cancelled" })).toBe("cancelled");
  });

  test("the suffix carries a time only while it waits or deploys", () => {
    expect(deployPillSuffix({ status: "requested", created_at: now - 3 * MIN }, now)).toBe("waiting 3m");
    expect(deployPillSuffix({ status: "requested", created_at: now - 20 * 60 * MIN - 3 * MIN }, now)).toBe("waiting 20h");
    expect(deployPillSuffix({ status: "running", created_at: now - 12 * MIN }, now)).toBe("deploying 12m");
    expect(deployPillSuffix({ status: "running", created_at: now - 82 * MIN }, now)).toBe("deploying 1h 22m");
    expect(deployPillSuffix({ status: "running", created_at: now - 74 * 60 * MIN }, now)).toBe("deploying 3d 2h");
    expect(deployPillSuffix({ status: "live", created_at: now - 90 * MIN }, now)).toBe("live");
    expect(deployPillSuffix({ status: "live", after: { open: false } }, now)).toBe("replaced");
    expect(deployPillSuffix({ status: "failed", created_at: now - 60 * MIN, finished_at: now }, now)).toBe("failed");
    expect(deployPillSuffix({ status: "cancelled" }, now)).toBe("cancelled");
  });

  test("the hover's headline says the state and since when", () => {
    expect(deployHeadline({ status: "running", created_at: now - 82 * MIN }, now, clock)).toBe("Deploying for 1h 22m");
    expect(deployHeadline({ status: "live", created_at: now - 140 * MIN, live_at: now - 128 * MIN }, now, clock)).toBe("Live since @128m");
    expect(deployHeadline({ status: "failed", created_at: now - 60 * MIN, finished_at: now - 8 * MIN }, now, clock)).toBe("Failed after 52m");
    expect(deployHeadline({ status: "failed", created_at: now - 60 * MIN }, now, clock)).toBe("Failed");
    expect(deployHeadline({ status: "live", after: { open: false } }, now, clock)).toBe("Replaced by a newer deploy");
    expect(deployHeadline({ status: "requested", created_at: now - 20 * MIN }, now, clock)).toBe("Waiting to start");
    expect(deployHeadline({ status: "requested", created_at: now - 22 * 60 * MIN }, now, clock)).toBe("No machine has started it");
    expect(deployHeadline({ status: "cancelled" }, now, clock)).toBe("Cancelled");
  });

  test("tones: green live, yellow going out, red failed, the rest quiet", () => {
    expect(DEPLOY_PILL_TONE).toEqual({ waiting: "muted", going_out: "yellow", live: "green", replaced: "muted", failed: "red", cancelled: "dim" });
  });

  test("a reach reads as the word codecast already uses for it", () => {
    expect(Object.fromEntries(Object.entries(REACH_LOOK).map(([k, v]) => [k, `${v.word}/${v.tone}`]))).toEqual({
      live: "live/green",
      going_out: "deploying/yellow",
      queued: "queued/muted",
      failed: "deploy failed/red",
      rolled_back: "rolled back/orange",
      waiting: "not live yet/dim",
    });
  });

  test("a target's reach time is when its state began; only a deploy still going out names it (started)", () => {
    const at = (a: number) => ({ at: a });
    expect(reachTime({ state: "live", deploy: at(1), now: null })).toEqual({ verb: null, at: 1 });
    expect(reachTime({ state: "going_out", deploy: at(2), now: at(9) })).toEqual({ verb: "started", at: 2 });
    expect(reachTime({ state: "failed", deploy: at(3), now: at(9) })).toEqual({ verb: null, at: 3 });
    // Rolled back: when the deploy that replaced it went live.
    expect(reachTime({ state: "rolled_back", deploy: at(4), now: at(9) })).toEqual({ verb: null, at: 9 });
    expect(reachTime({ state: "waiting", deploy: null, now: at(9) })).toBeNull();
  });

  test("a queued target's time says when its deploy was asked for", () => {
    expect(reachTime({ state: "queued", deploy: { at: 5 }, now: { at: 9 } })).toEqual({ verb: "queued", at: 5 });
  });

  test("a deploy no machine has started an hour after it was asked for turns orange; before that it is quiet", () => {
    expect(deployTone({ status: "requested", created_at: now - 59 * MIN }, now)).toBe("muted");
    expect(deployTone({ status: "requested", created_at: now - 22 * 60 * MIN }, now)).toBe("orange");
    expect(deployTone({ status: "running", created_at: now - 22 * 60 * MIN }, now)).toBe("yellow");
  });

  test("a rollback says so in every state it can be in", () => {
    const back = (status: string, extra = {}) => ({ action: "rollback", status, sha: "4a6e4140abcdef", created_at: now - 5 * MIN, ...extra });
    expect(deployPillSuffix(back("live"), now)).toBe("rolled back");
    expect(deployPillSuffix(back("running"), now)).toBe("rolling back 5m");
    expect(deployPillSuffix(back("failed"), now)).toBe("rollback failed");
    expect(deployTone(back("failed"), now)).toBe("red");
    expect(deployTone(back("live", { after: { open: true } }), now)).toBe("orange");
    expect(deployTone(back("running"), now)).toBe("orange");
    expect(deployHeadline(back("live"), now, clock)).toBe("Rolled back to 4a6e414");
    expect(deployHeadline(back("running"), now, clock)).toBe("Rolling back to 4a6e414 for 5m");
    expect(deployHeadline(back("failed", { finished_at: now }), now, clock)).toBe("Rollback failed after 5m");
  });

  test("a replaced deploy names what replaced it, a rollback as a rollback", () => {
    expect(deployPillState({ status: "live", replaced_by: { short_id: "dp-2" } })).toBe("replaced");
    expect(replacedLine({ short_id: "dp-2", sha: "7a6e4170abc", at: now - 5 * 60 * MIN }, now)).toEqual({ verb: "Replaced by", label: "7a6e417", ago: "5h ago" });
    expect(replacedLine({ short_id: "dp-3", sha: null, at: now - 40 * MIN, rollback: true }, now)).toEqual({ verb: "Rolled back by", label: "dp-3", ago: "40m ago" });
  });

  test("steps are named as the Deploys page names them", () => {
    expect(deployStepLabel("gate")).toBe("Eval gate");
    expect(deployStepLabel("rollout")).toBe("Roll out");
    expect(deployStepLabel("ci")).toBe("CI");
    expect(deployStepLabel("returned")).toBe("returned");
  });

  test("a deploy is named by its target and sha, else its version, else its dp-N", () => {
    expect(deployTitle({ target: "web", sha: "2a6e4120abcdef", short_id: "dp-1" })).toBe("web 2a6e412");
    expect(deployTitle({ target: "web", version: "v1.1.246", short_id: "dp-1" })).toBe("web v1.1.246");
    expect(deployTitle({ target: "web", short_id: "dp-1972" })).toBe("web dp-1972");
    expect(deployTitle({ target: "web" })).toBe("web");
  });

  test("a run is named by its url or its bare id of nine or more digits", () => {
    expect(runRefKey("https://github.com/o/r/actions/runs/44822506482")).toBe("44822506482");
    expect(runRefKey(" 44822506482 ")).toBe("44822506482");
    expect(runRefKey("12345678")).toBeNull();
    expect(runRefKey("dp-12")).toBeNull();
    const d = { short_id: "dp-12", url: "https://github.com/o/r/actions/runs/44822506482" };
    expect(deployMatchesRef(d, "44822506482")).toBe(true);
    expect(deployMatchesRef({ short_id: "dp-13", workflow_run: "44822506483" }, "44822506483")).toBe(true);
    expect(deployMatchesRef(d, "44822506483")).toBe(false);
  });

  test("a deploy is found by its dp-N or by the Actions run carrying it, any attempt form", () => {
    const d = { short_id: "dp-12", url: "https://github.com/o/r/actions/runs/44822506482" };
    expect(deployMatchesRef(d, "dp-12")).toBe(true);
    expect(deployMatchesRef(d, "DP-12")).toBe(true);
    expect(deployMatchesRef(d, "dp-13")).toBe(false);
    expect(deployMatchesRef(d, "https://github.com/o/r/actions/runs/44822506482")).toBe(true);
    expect(deployMatchesRef(d, "https://github.com/o/r/actions/runs/44822506482/attempts/1")).toBe(true);
    expect(deployMatchesRef(d, "https://github.com/o/r/actions/runs/44822506482/attempts/2")).toBe(false);
    expect(deployMatchesRef(d, "https://github.com/o/r/actions/runs/1")).toBe(false);
    expect(deployMatchesRef({ short_id: "dp-1", url: null }, "https://github.com/o/r/actions/runs/1")).toBe(false);
    expect(deployMatchesRef(null, "dp-1")).toBe(false);
  });
});

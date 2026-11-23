import { describe, expect, test } from "bun:test";
import { changeLifecycle, nowElapsed, vehicleName, type Lifecycle } from "../lifecycle";
import { changeExamples } from "../examples";

const now = 1_790_000_000_000;
const byId = Object.fromEntries(changeExamples(now).map((e) => [e.id, changeLifecycle(e.facts)]));
const track = (l: Lifecycle) => l.stages.map((s) => s.state).join(" ");

describe("a change's now", () => {
  test("every example reads as one word in one tone, at the stage that holds it", () => {
    const got = Object.fromEntries(Object.entries(byId).map(([id, l]) => [id, `${l.now.stage}: ${l.now.word}${l.now.detail ? ` · ${l.now.detail}` : ""} (${l.now.tone})`]));
    expect(got).toEqual({
      editing: "work: editing (yellow)",
      "not-shipped": "work: not shipped (muted)",
      pass: "work: not shipped (muted)",
      checking: "check: checking (yellow)",
      "changes-asked": "check: changes asked (orange)",
      "checks-failed": "check: checks failed · test-web (2/4) (red)",
      "ready-to-land": "land: ready to land (blue)",
      conflicts: "land: conflicts (orange)",
      "auto-merge": "land: landing (yellow)",
      "not-live": "deploy: not live yet (muted)",
      "deploy-queued": "deploy: deploy queued (muted)",
      deploying: "deploy: deploying · 1 of 2 live (yellow)",
      "deploy-failed": "deploy: deploy failed (red)",
      live: "live: live (green)",
      "rolled-back": "live: rolled back (orange)",
      "red-main": "check: red on main (red)",
      landed: "land: landed (green)",
      closed: "check: closed (dim)",
    });
  });

  test("the track: stages before the now are passed, the now holds its state, the rest wait; only a live change is all done", () => {
    expect(track(byId.editing)).toBe("active idle idle idle idle");
    expect(track(byId.checking)).toBe("done active idle idle idle");
    expect(track(byId["ready-to-land"])).toBe("done done you idle idle");
    expect(track(byId.deploying)).toBe("done done done active idle");
    expect(track(byId.live)).toBe("done done done done done");
    expect(track(byId["rolled-back"])).toBe("done done done done back");
    expect(track(byId.landed)).toBe("done done done skipped skipped");
    // CI after a direct push reads as Check, with Land already passed.
    expect(track(byId["red-main"])).toBe("done failed done idle idle");
    const allDone = Object.entries(byId).filter(([, l]) => l.stages.every((s) => s.state === "done")).map(([id]) => id);
    expect(allDone).toEqual(["live"]);
  });

  test("hover lines say what each stage holds", () => {
    expect(byId.editing.stages[0].line).toBe("6 files uncommitted · 2 commits ahead");
    expect(byId["changes-asked"].stages[1].line).toBe("14 checks passed · review asked for changes");
    expect(byId["checks-failed"].stages[1].line).toBe("test-web (2/4) failed · review passed");
    expect(byId.deploying.stages[3].line).toBe("backend deploying · web live");
    expect(byId.live.stages[4].line).toBe("Live on all 2 targets");
    expect(byId["red-main"].stages[1].line).toBe("unit (3/8) failed · after it landed");
    expect(byId["red-main"].stages[2].line).toBe("Shipped with the checkout as 9f8e7d6");
  });

  test("a green change with auto-merge on lands on its own; one without waits for a person", () => {
    const facts = { vehicle: { kind: "branch" as const, name: "x/y" }, work: { uncommitted: 0, ahead: 1, pushed: true, writers: [] }, check: { ci: "success" as const, review: "approved" as const } };
    expect(changeLifecycle({ ...facts, auto_merge: true }).now).toMatchObject({ stage: "land", word: "landing", tone: "yellow" });
    expect(changeLifecycle(facts).now).toMatchObject({ stage: "land", word: "ready to land", tone: "blue" });
  });

  test("a pushed branch nobody checks says so", () => {
    const l = changeLifecycle({ vehicle: { kind: "branch", name: "x/y" }, work: { uncommitted: 0, ahead: 1, pushed: true, writers: [] } });
    expect(l.now).toMatchObject({ stage: "check", word: "not checked", tone: "muted" });
  });

  test("a deploy in motion or in a queue says how long; a settled one does not", () => {
    expect(nowElapsed(byId.deploying.now, now)).toBe("6m");
    expect(nowElapsed(byId["deploy-queued"].now, now)).toBe("3m");
    expect(nowElapsed(byId.live.now, now)).toBeNull();
    expect(nowElapsed(byId["ready-to-land"].now, now)).toBeNull();
  });

  test("a vehicle's name", () => {
    expect(vehicleName({ kind: "pr", number: 12 })).toBe("#12");
    expect(vehicleName({ kind: "commit", sha: "abcdef123456" })).toBe("abcdef1");
    expect(vehicleName({ kind: "pass", folder: "~/code/codecast", sessions: 1, files: 2 })).toBe("codecast checkout");
  });

  test("a draft waits on its author; auto-merge lands itself; a review a person owes is their turn", () => {
    const base = { vehicle: { kind: "pr" as const, number: 9 }, work: { uncommitted: 0, ahead: 1, pushed: true, writers: [] } };
    expect(changeLifecycle({ ...base, draft: true, check: { ci: "success", review: "none" } }).now).toMatchObject({ word: "draft", tone: "muted" });
    expect(changeLifecycle({ ...base, draft: true, check: { ci: "failure", review: "none" } }).now).toMatchObject({ word: "checks failed", tone: "red" });
    expect(changeLifecycle({ ...base, auto_merge: true, check: { ci: "success", review: "approved" } }).now).toMatchObject({ word: "landing", tone: "yellow" });
    expect(changeLifecycle({ ...base, check: { ci: "success", review: "required" } }).now).toMatchObject({ stage: "check", word: "needs review", tone: "blue" });
    expect(changeLifecycle({ ...base, check: { ci: "pending", review: "required" } }).now).toMatchObject({ word: "checking" });
  });

  test("a landed change whose deploys are still being read says it is on main, never that it touches nothing", () => {
    const l = changeLifecycle({ vehicle: { kind: "pr", number: 9 }, land: { state: "landed", how: "merged", sha: "abcdef1234" }, reach_pending: true });
    expect(l.now).toMatchObject({ stage: "deploy", word: "on main", tone: "muted" });
    expect(l.stages[3].line).toBe("Reading its deploys");
  });
});

import { describe, expect, test } from "bun:test";
import { projectPathRepairKey, projectPathRepairNeeded } from "./daemon.js";

// The boot sweep sends conversations:updateProjectPath only for transcripts
// whose (path, git root) the server has not already confirmed for that session.
describe("projectPathRepairNeeded", () => {
  const confirmed = {
    "sess-a": projectPathRepairKey("/Users/u/src/app", "/Users/u/src/app"),
    "sess-b": projectPathRepairKey("/Users/u/src/app/packages/web", "/Users/u/src/app"),
    "sess-c": projectPathRepairKey("/tmp/scratch"),
  };

  test("an unchanged session is skipped", () => {
    expect(projectPathRepairNeeded(confirmed, "sess-a", "/Users/u/src/app", "/Users/u/src/app").send).toBe(false);
    expect(projectPathRepairNeeded(confirmed, "sess-b", "/Users/u/src/app/packages/web", "/Users/u/src/app").send).toBe(false);
    expect(projectPathRepairNeeded(confirmed, "sess-c", "/tmp/scratch", undefined).send).toBe(false);
  });

  test("a new session, a moved checkout, or a changed git root is sent", () => {
    expect(projectPathRepairNeeded(confirmed, "sess-new", "/Users/u/src/app", "/Users/u/src/app").send).toBe(true);
    expect(projectPathRepairNeeded(confirmed, "sess-a", "/Users/u/code/app", "/Users/u/code/app").send).toBe(true);
    expect(projectPathRepairNeeded(confirmed, "sess-a", "/Users/u/src/app", undefined).send).toBe(true);
    expect(projectPathRepairNeeded(confirmed, "sess-c", "/tmp/scratch", "/tmp/scratch").send).toBe(true);
  });

  test("the key it returns is what the next boot compares against", () => {
    const plan = projectPathRepairNeeded({}, "sess-x", "/p", "/g");
    expect(plan.send).toBe(true);
    expect(projectPathRepairNeeded({ "sess-x": plan.key }, "sess-x", "/p", "/g").send).toBe(false);
  });

  test("path and git root cannot alias each other in the key", () => {
    expect(projectPathRepairKey("/a\n/b")).not.toBe(projectPathRepairKey("/a", "/b"));
  });
});

import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { internal } from "./_generated/api";

// A page the build before peers queued over a dead parent's spawned sessions
// (`spawned: true`, a cursor of another index) still validates, and ends.
describe("releaseDeadParentChildren's deploy-window alias", () => {
  test("a queued spawned page is accepted and releases nothing", async () => {
    const t = convexTest(schema, allModules);
    const res = await t.mutation(internal.notifications.releaseDeadParentChildren, { parent_id: "x", released_at: 1, spawned: true, cursor: "not-this-index" });
    expect(res).toEqual({ released: 0, rechecked: 0 });
  });
});

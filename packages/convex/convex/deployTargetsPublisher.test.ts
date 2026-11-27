import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { publisherOf } from "./deployTargetsState";

// A change run on another person's machine cannot send a target, and its stop names whose machine can
// (awaitDeploy.ts). Synthetic data only.
describe("who publishes a target (publisherOf)", () => {
  test("the publisher's name and their machine's display name; nulls for what is not recorded", async () => {
    const t = convexTest(schema, allModules);
    await t.run(async (ctx) => {
      const ana = await ctx.db.insert("users", { name: "Ana" });
      await ctx.db.insert("devices", { user_id: ana, device_id: "d1", label: "macOS - ana-mbp", platform: "darwin", display_name: "Ana's laptop", last_seen: 1 } as any);
      expect(await publisherOf(ctx, { publisher_user_id: ana, device_id: "d1" })).toEqual({ name: "Ana", machine: "Ana's laptop" });
      expect(await publisherOf(ctx, { publisher_user_id: ana, device_id: "gone" })).toEqual({ name: "Ana", machine: null });
      expect(await publisherOf(ctx, { publisher_user_id: ana })).toEqual({ name: "Ana", machine: null });
    });
  });
});

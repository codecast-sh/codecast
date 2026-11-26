import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";

// The recovery mode belongs to the person, not a machine. It used to live on
// each laptop's device row and was read from whichever laptop beat last, so a
// person with two laptops online got one machine's choice or the other's
// depending on heartbeat timing.

test("a person's recovery mode applies to every machine they run", async () => {
  const t = convexTest(schema, allModules);
  const now = Date.now();
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { name: "Ada", email: "ada@example.com" } as any);
    // Two laptops online that disagree: the fresher one says "off".
    await ctx.db.insert("devices", { user_id: id, device_id: "mac-a", last_seen: now - 10_000, cc_auto_continue: true, cc_accounts: { profiles: [] } } as any);
    await ctx.db.insert("devices", { user_id: id, device_id: "mac-b", last_seen: now - 1_000, cc_accounts: { profiles: [] } } as any);
    return id;
  });
  const as = t.withIdentity({ subject: `${userId}|session` });

  // Before the person chooses, each machine keeps its own legacy flags.
  expect((await as.query(api.accountSwitch.recoveryStatus, {}))?.mode).toBe("off");

  await as.mutation(api.accountSwitch.setRecoveryMode, { mode: "resume" });

  expect((await as.query(api.accountSwitch.recoveryStatus, {}))?.mode).toBe("resume");
  const roster = await as.query(api.accountSwitch.listAccountProfiles, {});
  expect(roster?.devices.map((d) => [d.device_id, d.auto_continue]).sort()).toEqual([
    ["mac-a", true],
    ["mac-b", true],
  ]);
});

import { expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(120_000);

test("Sync folder adds the folder to the chosen ones, or lifts its exclusion, planned from the stored lists", async () => {
  const t = convexTest(schema, allModules);
  const [chooser, allBut] = await t.run(async (ctx: any) => [
    await ctx.db.insert("users", { name: "C", email: "c@x.dev", sync_mode: "selected", sync_projects: ["/Users/c/git/a"] }),
    await ctx.db.insert("users", { name: "A", email: "a@x.dev", sync_mode: "all", sync_excluded: ["/Users/a/clients"] }),
  ]);
  await t.withIdentity({ subject: `${chooser}|s` }).mutation(api.users.syncFolder, { folder: "/Users/rentamac" });
  await t.withIdentity({ subject: `${chooser}|s` }).mutation(api.users.syncFolder, { folder: "/Users/rentamac" });
  await t.withIdentity({ subject: `${allBut}|s` }).mutation(api.users.syncFolder, { folder: "/Users/other/clients" });
  const [c, a] = await t.run(async (ctx: any) => [await ctx.db.get(chooser), await ctx.db.get(allBut)]);
  expect(c.sync_projects).toEqual(["/Users/c/git/a", "/Users/rentamac"]);
  expect(a.sync_excluded).toEqual([]);
});

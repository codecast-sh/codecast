import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../schema";
import { internal } from "../_generated/api";
import { allModules } from "../testModules.testkit";
import { hasExperiment } from "./experiments";

async function setup() {
  const t = convexTest(schema, allModules);
  const userId = await t.run((ctx) => ctx.db.insert("users", { name: "Pat" }));
  const has = (name: string) => t.run((ctx) => hasExperiment(ctx, userId, name));
  const set = (name: string, on: boolean) =>
    t.mutation(internal.experiments.set, { user_id: userId, name, on });
  return { has, set };
}

describe("experiments", () => {
  test("absent field is off", async () => {
    const { has } = await setup();
    expect(await has("priority_cards")).toBe(false);
  });

  test("on then off", async () => {
    const { has, set } = await setup();
    expect(await set("priority_cards", true)).toEqual(["priority_cards"]);
    expect(await has("priority_cards")).toBe(true);
    expect(await has("other")).toBe(false);
    expect(await set("priority_cards", false)).toEqual([]);
    expect(await has("priority_cards")).toBe(false);
  });

  test("set is idempotent", async () => {
    const { set } = await setup();
    await set("a", true);
    expect(await set("a", true)).toEqual(["a"]);
    await set("b", true);
    expect(await set("a", false)).toEqual(["b"]);
    expect(await set("a", false)).toEqual(["b"]);
  });
});

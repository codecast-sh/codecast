import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";

// The web's DashboardLayout feeds agentDefinitions.list and listChains with {}
// before auth settles (or after it lapses). A list feed with no caller answers
// an empty list, like the other workspace feeds, instead of throwing a server
// error (ct-74851). Writes and name lookups still reject.

describe("agentDefinitions list feeds without a caller", () => {
  test("listChains returns [] instead of throwing", async () => {
    const t = convexTest(schema, allModules);
    expect(await t.query(api.agentDefinitions.listChains, {})).toEqual([]);
  });

  test("list returns [] instead of throwing", async () => {
    const t = convexTest(schema, allModules);
    expect(await t.query(api.agentDefinitions.list, {})).toEqual([]);
  });

  test("getChain still rejects an unauthenticated caller", async () => {
    const t = convexTest(schema, allModules);
    await expect(t.query(api.agentDefinitions.getChain, { name: "x" })).rejects.toThrow(/Authentication failed/);
  });
});

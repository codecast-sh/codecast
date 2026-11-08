// A new team starts with every feature the catalog marks onByDefault stored
// on, and nothing else: in-development features and policy switches stay off.
import { expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { TEAM_FEATURES, teamFeatureEnabled } from "@codecast/shared/contracts";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./teams.ts": () => import("./teams"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
};

test("createTeam stores the default-on features", async () => {
  const t = convexTest(schema, modules);
  const user = await t.run((ctx) => ctx.db.insert("users", { email: "a@x", name: "A" } as any));
  const { api } = await import("./_generated/api");
  const teamId = await t.withIdentity({ subject: `${user}|x` } as any).mutation(api.teams.createTeam, { name: "New" } as any);
  const team = await t.run((ctx) => ctx.db.get(teamId));
  for (const f of TEAM_FEATURES) expect([f.key, teamFeatureEnabled(team, f.key)]).toEqual([f.key, !!f.onByDefault]);
  expect(["chat", "calls", "org", "line", "ship"].every((k) => teamFeatureEnabled(team, k as any))).toBe(true);
  expect(teamFeatureEnabled(team, "agent_realtime")).toBe(false);
});

import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

// A decision recorded with the repo and paths it governs is found by a change
// to those paths; a reversed one stops binding and its successor inherits
// what it governed.

const TOKEN = "decisions_touching_token";
const REMOTE = "git@github.com:codecast-sh/codecast.git";

async function setup() {
  const t = convexTest(schema, allModules);
  await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Me" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: 1, last_used_at: 1 } as any);
  });
  return t;
}

const touching = (files: string[], conversation_ids: string[] = []) => ({ git_remote: REMOTE, files, conversation_ids });

describe("decisions --touching", () => {
  test("a governed path finds the decision; a reversal moves the binding to its successor", async () => {
    const t = await setup();
    const first: any = await t.mutation(api.decisions.create, {
      api_token: TOKEN, title: "Breadth gets 20%", rationale: "r", git_remote: REMOTE, files: ["./outreach/engine/"],
    });
    expect(first.success).toBe(true);

    let res: any = await t.mutation(api.decisions.list, { api_token: TOKEN, touching: touching(["outreach/engine/buy.ts", "README.md"]) });
    expect(res.decisions.map((d: any) => [d.title, d.touches.files])).toEqual([["Breadth gets 20%", ["outreach/engine/buy.ts"]]]);

    res = await t.mutation(api.decisions.list, { api_token: TOKEN, touching: touching(["web/app.ts"]) });
    expect(res.decisions).toEqual([]);

    const second: any = await t.mutation(api.decisions.create, {
      api_token: TOKEN, title: "Breadth gets 30%", rationale: "r", supersedes: String(first.id).slice(0, 7),
    });
    expect(second.success).toBe(true);
    res = await t.mutation(api.decisions.list, { api_token: TOKEN, touching: touching(["outreach/engine/buy.ts"]) });
    expect(res.decisions.map((d: any) => d.title)).toEqual(["Breadth gets 30%"]);

    const all: any = await t.mutation(api.decisions.list, { api_token: TOKEN });
    expect(all.decisions.find((d: any) => d.title === "Breadth gets 20%").superseded_by).toBe(second.id);
  });

  test("superseding a decision the caller cannot read is refused", async () => {
    const t = await setup();
    const res: any = await t.mutation(api.decisions.create, { api_token: TOKEN, title: "x", rationale: "r", supersedes: "qd00000" });
    expect(res.error).toContain("qd00000");
  });
});

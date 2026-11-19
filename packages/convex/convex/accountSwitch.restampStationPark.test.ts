// A workflow station whose park flag was cleared while its transcript still ends on the banner gets the flag back
// when its runner asks (restampStationPark): 56 onefix Build hands were killed at 480m on a weekly limit, 2026-11-18.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

const TOKEN = "s".repeat(64);
const T0 = Date.now();
const BANNER = "You've hit your weekly limit · resets Nov 21, 10am (UTC)";

async function setup(lastMessage: { role: string; content: string }, extra: Record<string, unknown> = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ana" } as any);
    const stranger = await ctx.db.insert("users", { name: "Ben" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    const conv = (owner: any) => ctx.db.insert("conversations", {
      user_id: owner, session_id: `s-${owner}`, agent_type: "claude_code", status: "active",
      started_at: T0, updated_at: T0, message_count: 2, pending_api_error: false, ...extra,
    } as any);
    const mine = await conv(user);
    const theirs = await conv(stranger);
    for (const c of [mine, theirs]) {
      await ctx.db.insert("messages", { conversation_id: c, role: "user", content: "build it", timestamp: T0 - 2_000 } as any);
      await ctx.db.insert("messages", { conversation_id: c, ...lastMessage, timestamp: T0 - 1_000 } as any);
    }
    return { mine, theirs };
  });
  const restamp = (id: string) => t.mutation(api.accountSwitch.restampStationPark, { api_token: TOKEN, conversation_id: id });
  const row = (id: any) => t.run((ctx) => ctx.db.get(id)) as Promise<any>;
  return { ids, restamp, row };
}

describe("restampStationPark", () => {
  test("a cleared flag over a limit banner is stamped again", async () => {
    const { ids, restamp, row } = await setup({ role: "assistant", content: BANNER });
    expect(await restamp(ids.mine)).toEqual({ kind: "limit" });
    expect(await row(ids.mine)).toMatchObject({ pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: T0 - 1_000 });
  });

  test("a context banner is left to its own recovery", async () => {
    const { ids, restamp, row } = await setup({ role: "assistant", content: "Prompt is too long" });
    expect(await restamp(ids.mine)).toEqual({ kind: null });
    expect((await row(ids.mine)).pending_api_error).toBe(false);
  });

  test("a transcript that ends on a real turn is left alone", async () => {
    const { ids, restamp, row } = await setup({ role: "assistant", content: "Checking the build." });
    expect(await restamp(ids.mine)).toEqual({ kind: null });
    expect((await row(ids.mine)).pending_api_error).toBe(false);
  });

  test("another user's row, and a killed one, are never stamped", async () => {
    const { ids, restamp, row } = await setup({ role: "assistant", content: BANNER });
    expect(await restamp(ids.theirs)).toEqual({ kind: null });
    expect((await row(ids.theirs)).pending_api_error).toBe(false);
    const killed = await setup({ role: "assistant", content: BANNER }, { inbox_killed_at: T0 });
    expect(await killed.restamp(killed.ids.mine)).toEqual({ kind: null });
  });
});

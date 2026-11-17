// What the suggester reads back about its past suggestions (suggestionOutcomes.recent)
// under convex-test. The outcome row holds none of the person's words: what
// they sent instead is the first message they typed after the agent turn,
// read from the transcript, so deleting that transcript takes it along. A
// regulated team's conversation stays out, since this goes to the vendor.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { typedPart } from "./suggestionOutcomes";
import { formatJointMessage } from "@codecast/shared/contracts/jointMessage";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(120_000);

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ada", email: "ada@plain.dev" } as any);
    const clinic = await ctx.db.insert("teams", { name: "Clinic", invite_code: "CLINIC12", created_at: 1, policy: { regulated_data: true } } as any);
    const conv = (team?: Id<"teams">) =>
      ctx.db.insert("conversations", {
        user_id: user, agent_type: "claude_code", session_id: crypto.randomUUID(), started_at: 1, updated_at: 1,
        message_count: 0, is_private: false, status: "active", ...(team ? { team_id: team } : {}),
      } as any);
    const mine = await conv();
    const regulated = await conv(clinic);
    return { user, mine, regulated };
  });
  return { t, ...ids };
}

async function turn(t: any, conversation_id: Id<"conversations">, agentUuid: string, at: number, reply: string | null) {
  await t.run(async (ctx: any) => {
    await ctx.db.insert("messages", { conversation_id, message_uuid: agentUuid, role: "assistant", content: "Shall I ship it?", timestamp: at });
    if (reply !== null) await ctx.db.insert("messages", { conversation_id, message_uuid: `${agentUuid}-r`, role: "user", content: reply, timestamp: at + 10 });
  });
}

async function outcome(t: any, user: Id<"users">, conversation_id: Id<"conversations">, anchor: string, kind: "sent" | "edited" | "ignored", at: number) {
  await t.run((ctx: any) =>
    ctx.db.insert("suggestion_outcomes", { user_id: user, conversation_id, anchor_message_uuid: anchor, suggestion: "ship it to staging", outcome: kind, shown: ["ship it to staging"], created_at: at }),
  );
}

describe("suggestionOutcomes.recent", () => {
  test("reads what they typed from the transcript, newest first", async () => {
    const { t, user, mine } = await setup();
    await turn(t, mine, "a1", 100, "revert the flag and rerun the soak test");
    await turn(t, mine, "a2", 200, "ship it to staging tonight");
    await outcome(t, user, mine, "a1", "ignored", 1);
    await outcome(t, user, mine, "a2", "edited", 2);
    const out = await t.query(internal.suggestionOutcomes.recent, { user_id: user });
    expect(out).toEqual([
      { outcome: "edited", suggestion: "ship it to staging", reply: "ship it to staging tonight" },
      { outcome: "ignored", suggestion: "ship it to staging", reply: "revert the flag and rerun the soak test" },
    ]);
  });

  test("a reply that is gone, or a slash command, leaves its outcome out", async () => {
    const { t, user, mine } = await setup();
    await turn(t, mine, "a1", 100, "revert the flag and rerun the soak test");
    await turn(t, mine, "a2", 200, "/compact");
    await outcome(t, user, mine, "a1", "ignored", 1);
    await outcome(t, user, mine, "a2", "ignored", 2);
    // The person deletes their reply's transcript row.
    await t.run(async (ctx: any) => {
      const row = await ctx.db.query("messages").withIndex("by_conversation_uuid", (q: any) => q.eq("conversation_id", mine).eq("message_uuid", "a1-r")).first();
      await ctx.db.delete(row._id);
    });
    expect(await t.query(internal.suggestionOutcomes.recent, { user_id: user })).toEqual([]);
  });

  test("a regulated team's conversation stays out", async () => {
    const { t, user, regulated } = await setup();
    await turn(t, regulated, "c1", 100, "summarize the patient intake notes");
    await outcome(t, user, regulated, "c1", "ignored", 1);
    expect(await t.query(internal.suggestionOutcomes.recent, { user_id: user })).toEqual([]);
  });
});

describe("typedPart: only the words the person typed", () => {
  test("a quote folded in ahead of the reply is cut by the typed length", () => {
    const sent = "> the cookie wait is racy\n\nVerdict: wrong\n\nrevert the flag and rerun the soak test";
    expect(typedPart(sent, "revert the flag and rerun the soak test".length)).toBe("revert the flag and rerun the soak test");
    // An older client sent no length: a message holding a quote teaches nothing.
    expect(typedPart(sent)).toBeNull();
    expect(typedPart("ship it to staging tonight")).toBe("ship it to staging tonight");
  });
  test("a joint send gives the person's own part, which the composer puts first", () => {
    const joint = formatJointMessage([{ from: "Ada", body: "ship it tonight" }, { from: "Mo", body: "wait for the soak test" }]);
    expect(typedPart(joint, 15)).toBe("ship it tonight");
  });
});

describe("the name released phones still call", () => {
  test("composerSuggestions.recordSuggestionOutcome writes the same row and no words", async () => {
    const { t, user, mine } = await setup();
    const asUser = t.withIdentity({ subject: `${user}|s`, tokenIdentifier: "x" });
    await asUser.mutation(api.composerSuggestions.recordSuggestionOutcome, { conversation_id: mine, anchor_message_uuid: "a1", suggestion: "ship it to staging", outcome: "sent" });
    await asUser.mutation(api.suggestionOutcomes.record, { conversation_id: mine, anchor_message_uuid: "a2", suggestion: "ship it to staging", outcome: "ignored", shown: ["ship it to staging"], typed_length: 12 });
    const rows = await t.run((ctx: any) => ctx.db.query("suggestion_outcomes").collect());
    expect(rows.map((r: any) => [r.anchor_message_uuid, r.outcome, r.typed_length ?? null, "sent" in r])).toEqual([["a1", "sent", null, false], ["a2", "ignored", 12, false]]);
  });
});

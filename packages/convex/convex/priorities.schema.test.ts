// Priorities groundwork (plan pl-1106): every pin write leaves a trail row the
// pass reads, kept 30 days and readable only by its owner; the team feature
// exists, staff-gated and seated in personal workspaces; and priority short
// ids are allocated as pri-N.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api, internal } from "./_generated/api";
import { nextShortId } from "./counters";
import { accessJudgeFor, accessStampFor, accessStampFromDoc } from "./lib/accessKeys";
import { THREAD_STATE_EVENT_RETENTION_MS } from "./threadStateEvents";
import { TEAM_FEATURES } from "@codecast/shared/contracts";
import { RESERVED_OBJECT_PREFIXES } from "@codecast/shared/contracts/mods";
import type { PriorityStep } from "@codecast/shared/contracts/priorities";
import type { Doc } from "./_generated/dataModel";

setDefaultTimeout(60_000);

// The stored step and the shared contract's step are the same shape.
const _stepMatchesContract: PriorityStep = {} as Doc<"priorities">["steps"][number];
const _contractMatchesStep: Doc<"priorities">["steps"][number] = {} as PriorityStep;
void _stepMatchesContract;
void _contractMatchesStep;

/** An owner and a teammate in one team, with a team-visible session the owner runs. */
async function teamWorld() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Ada" } as any);
    const mate = await ctx.db.insert("users", { name: "Bea" } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: Date.now() } as any);
    for (const u of [owner, mate]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: 1 } as any);
    const conversation = await ctx.db.insert("conversations", {
      user_id: owner, team_id: team, agent_type: "claude_code", session_id: "pin-session", short_id: "jx7pin1",
      started_at: Date.now(), updated_at: Date.now(), message_count: 3, is_private: false, team_visibility: "full", status: "active",
    } as any);
    return { owner, mate, team, conversation };
  });
  return { t, ...ids };
}

describe("thread_state_events", () => {
  test("a cast state write inserts one event row and still pins the state", async () => {
    const { t, owner, conversation } = await teamWorld();
    const res: any = await t.withIdentity({ subject: `${owner}|session` }).mutation(api.conversations.setThreadState, {
      session: "jx7pin1", text: "Waiting on CI", status: "dormant",
    });
    expect(res.cleared).toBe(false);

    const { conv, events } = await t.run(async (ctx) => ({
      conv: await ctx.db.get(conversation),
      events: await ctx.db.query("thread_state_events").withIndex("by_conversation_at", (q) => q.eq("conversation_id", conversation)).collect(),
    }));
    expect(conv?.thread_state).toBe("Waiting on CI");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ conversation_id: conversation, user_id: owner, at: res.at, text: "Waiting on CI", status: "dormant" });
  });

  test("events older than 30 days are pruned, newer ones kept", async () => {
    const { t, owner, conversation } = await teamWorld();
    const now = Date.now();
    await t.run(async (ctx) => {
      for (const at of [now - THREAD_STATE_EVENT_RETENTION_MS - 60_000, now - THREAD_STATE_EVENT_RETENTION_MS + 60_000]) {
        await ctx.db.insert("thread_state_events", { conversation_id: conversation, user_id: owner, at, text: `pin ${at}`, status: "working" });
      }
    });
    expect(await t.mutation((internal as any).threadStateEvents.prune, {})).toBe(1);
    const left = await t.run(async (ctx) => ctx.db.query("thread_state_events").collect());
    expect(left.map((r) => r.at)).toEqual([now - THREAD_STATE_EVENT_RETENTION_MS + 60_000]);
  });
});

describe("access", () => {
  test("pass runs and pin events are their owner's alone, even filed under a team; a priority follows its workspace", async () => {
    const { t, owner, mate, team, conversation } = await teamWorld();
    const workspace = `team:${team}`;
    await t.run(async (ctx) => {
      const event = { user_id: owner, conversation_id: conversation, at: 1, text: "x", status: "working" };
      const run = { user_id: owner, workspace, started_at: 1, finished_at: 2, status: "ok", cursor_at: 1, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } };
      const priority = { user_id: owner, workspace };

      expect(accessStampFromDoc("priority_pass_runs", run)).toEqual({ access_owner: String(owner) });
      // The lazy-key branch would otherwise file the event under its conversation's team.
      expect(await accessStampFor(ctx, "thread_state_events", event)).toEqual({ access_owner: String(owner) });
      expect(await accessStampFor(ctx, "priority_pass_runs", run)).toEqual({ access_owner: String(owner) });
      expect(await accessStampFor(ctx, "priorities", priority)).toEqual({ access_owner: String(owner), access_key: workspace });

      const asOwner = await accessJudgeFor(ctx, owner);
      const asMate = await accessJudgeFor(ctx, mate);
      for (const [table, doc] of [["thread_state_events", event], ["priority_pass_runs", run]] as const) {
        expect(await asOwner(table, doc)).toBe(true);
        expect(await asMate(table, doc)).toBe(false);
      }
      expect(await asMate("priorities", priority)).toBe(true);
    });
  });
});

describe("priorities feature and ids", () => {
  test("the priorities feature is staff-gated and seated in personal workspaces", () => {
    const feature = TEAM_FEATURES.find((f) => f.key === "priorities");
    expect(feature?.personal).toBe(true);
    expect(feature?.inDevelopment).toBe(true);
  });

  test("short ids are pri-N, and mods cannot claim the prefix", async () => {
    const t = convexTest(schema, allModules);
    const ids = await t.run(async (ctx) => [await nextShortId(ctx.db, "pri"), await nextShortId(ctx.db, "pri")]);
    expect(ids).toEqual(["pri-1", "pri-2"]);
    expect(RESERVED_OBJECT_PREFIXES.has("pri")).toBe(true);
  });
});

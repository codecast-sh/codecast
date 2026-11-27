// Close hides a session until it needs you. Three ways it used to stay hidden
// while it needed you, each closed here:
//  - closed while its agent waits on a prompt (ct-102441): the projection
//    keeps it in view while the ask stands (shared closeHeldByAsk);
//  - a team session one person closed that stalls (ct-102442): the stall
//    check brings it back for them (lib/viewerTriage resurfaceViewerTriageOnStall);
//  - a woken turn that ends with no pin (ct-102443): the settle check brings
//    an ordinary one back, the classifier's needs-input verdict a role's
//    (shared settleHideFields).
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { internal } from "./_generated/api";
import { setup } from "./dispatch.close.testkit";
import { enqueuePendingMessage } from "./pendingMessages";
import { performSetIdleSummary } from "./idleSummary";
import { computeSessionsLiveness } from "./conversations";
import { ME, MIN, NOW, EPOCH, conv as projConv, db as projDb } from "./conversations.projection.testkit";

setDefaultTimeout(60_000);

async function closed(o: Parameters<typeof setup>[0] = {}, team = false) {
  const s = await setup(o);
  const at = Date.now() - 60_000;
  if (team) {
    await s.t.run(async (ctx) => {
      const teamId = await ctx.db.insert("teams", { name: "Crew", created_at: at } as any);
      await ctx.db.patch(s.ids.conv, { team_owner_team_id: teamId } as any);
      await ctx.db.insert("session_team_owners", { conversation_id: s.ids.conv, team_id: teamId, created_at: at } as any);
      // One person's Close of a team session: theirs alone, the agent keeps running.
      await ctx.db.insert("session_viewer_triage", { user_id: s.ids.user, conversation_id: s.ids.conv, inbox_dismissed_at: at, inbox_closed_at: at, updated_at: at } as any);
    });
  } else {
    await s.send("closeSession", [String(s.ids.conv)]);
  }
  const hides = async () => (team ? ((await s.t.run(async (ctx) => (await ctx.db.query("session_viewer_triage").collect())[0])) as any) : (await s.read()).conv);
  // A trigger fires into it: the close becomes a hidden stash (isClosedHidden).
  const wake = () => s.t.run(async (ctx) => {
    await enqueuePendingMessage(ctx, await ctx.db.get(s.ids.conv), s.ids.user, { content: "check CI", origin: "scheduler" } as any);
  });
  // The agent's turn ends (or stalls) on `status`, and the needs-input check
  // scheduled off that status runs.
  const settle = async (status: string, fields: Record<string, unknown> = {}) => {
    const ts = Date.now() - 60_000;
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.ids.conv, { has_pending_messages: false, ...fields } as any);
      const ms = await ctx.db.query("managed_sessions").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", s.ids.conv)).first();
      const row = { agent_status: status, agent_status_updated_at: ts, last_heartbeat: Date.now() };
      if (ms) await ctx.db.patch(ms._id, row as any);
      else await ctx.db.insert("managed_sessions", { session_id: "s-close", conversation_id: s.ids.conv, user_id: s.ids.user, pid: 1, started_at: ts, ...row } as any);
    });
    return s.t.mutation(internal.notifications.checkNeedsInput, { conversation_id: s.ids.conv, status_ts: ts });
  };
  const classify = (verdict: "done" | "needs_input") => s.t.run(async (ctx) => {
    await performSetIdleSummary(ctx, { conversation_id: s.ids.conv, settle_verdict: verdict });
  });
  return { ...s, hides, wake, settle, classify };
}

const hidden = (row: any) => {
  expect(row.inbox_stashed_at).toBeGreaterThan(0);
  expect(row.inbox_stashed_at).toBe(row.inbox_closed_at);
  expect(row.inbox_stash_hidden).toBe(true);
};
const shown = (row: any) => {
  expect(row.inbox_dismissed_at ?? undefined).toBeUndefined();
  expect(row.inbox_stashed_at ?? undefined).toBeUndefined();
  expect(row.inbox_killed_at ?? undefined).toBeUndefined();
};

describe("ct-102441: closed while its agent waits on a prompt, it stays in view while the ask stands", () => {
  let nowSpy: ReturnType<typeof spyOn> | null = null;
  afterEach(() => { nowSpy?.mockRestore(); nowSpy = null; });

  test("the server's projection files it as a question, and as stashed again once answered", async () => {
    nowSpy = spyOn(Date, "now").mockReturnValue(NOW);
    const at = EPOCH - 5 * MIN;
    // The shape a close of a session on a prompt leaves: set aside, hidden.
    const aside = { inbox_closed_at: at, inbox_stashed_at: at, inbox_stash_hidden: true, updated_at: EPOCH - MIN };
    const tables = {
      conversations: [projConv("asking", aside), projConv("answered", aside), projConv("stash", { ...aside, inbox_stashed_at: at + 1 })],
      managed_sessions: [
        { _id: "ms_asking", user_id: ME, conversation_id: "conversations_asking", last_heartbeat: EPOCH - 1000, agent_status: "permission_blocked", agent_status_updated_at: EPOCH - MIN },
        { _id: "ms_answered", user_id: ME, conversation_id: "conversations_answered", last_heartbeat: EPOCH - 1000, agent_status: "working", agent_status_updated_at: EPOCH - MIN },
        { _id: "ms_stash", user_id: ME, conversation_id: "conversations_stash", last_heartbeat: EPOCH - 1000, agent_status: "permission_blocked", agent_status_updated_at: EPOCH - MIN },
      ],
    };
    const { liveness } = await computeSessionsLiveness({ db: projDb(tables) }, ME as any);
    expect(liveness.conversations_asking).toMatchObject({ asking: true, bucket: "questions" });
    expect(liveness.conversations_answered.bucket).toBe("stashed");
    // A person's own stash and hide over it is no close: it keeps hiding.
    expect(liveness.conversations_stash.bucket).toBe("stashed");
  });

  test("closing it sets it aside, so nothing is stopped and the prompt is still there to answer", async () => {
    const s = await setup({ agent: "permission_blocked" });
    await s.send("closeSession", [String(s.ids.conv)]);
    const r = await s.read();
    hidden(r.conv);
    expect(r.kills.length).toBe(0);
  });
});

describe("ct-102442: a team session one person closed comes back for them when it stalls", () => {
  for (const [name, status] of [["a permission prompt", "permission_blocked"], ["a dead process", "stopped"]] as const) {
    test(`${name}, before any wake`, async () => {
      const s = await closed({}, true);
      await s.settle(status);
      shown(await s.hides());
    });

    test(`${name}, after a machine wake ran it out of sight`, async () => {
      const s = await closed({}, true);
      await s.wake();
      hidden(await s.hides());
      await s.settle(status);
      shown(await s.hides());
    });
  }

  test("a role's team session comes back on a stall too", async () => {
    const s = await closed({ role: true }, true);
    await s.wake();
    await s.settle("permission_blocked");
    shown(await s.hides());
  });

  test("a turn that ends dormant leaves the close alone", async () => {
    const s = await closed({}, true);
    await s.wake();
    await s.settle("dormant");
    hidden(await s.hides());
  });
});

describe("ct-102443: a closed session whose woken turn ends with no pin comes back", () => {
  for (const team of [false, true]) {
    const who = team ? "a team session one person closed" : "an ordinary session";

    test(`${who}: back at the settle, since nobody classified the turn`, async () => {
      const s = await closed({}, team);
      await s.wake();
      hidden(await s.hides());
      const out = await s.settle("idle");
      if (!team) expect(out).toMatchObject({ reason: "closed_settle" });
      shown(await s.hides());
    });

    test(`${who}: a turn that pins dormant stays out`, async () => {
      const s = await closed({}, team);
      await s.wake();
      await s.settle("dormant");
      hidden(await s.hides());
    });

    test(`${who}: a role's waits for the classifier, and comes back only when the turn asked`, async () => {
      const s = await closed({ role: true }, team);
      await s.wake();
      await s.settle("idle");
      hidden(await s.hides());
      await s.classify("done");
      hidden(await s.hides());
      await s.classify("needs_input");
      shown(await s.hides());
    });
  }

  test("a close no machine woke stays closed at a straggling settle: its stop was the teardown", async () => {
    const s = await closed();
    const out = await s.settle("idle");
    expect(out).toMatchObject({ reason: "closed" });
    const { conv } = await s.read();
    expect(conv.inbox_dismissed_at).toBe(conv.inbox_closed_at);
  });

  test("a killed session stays out whatever the classifier says", async () => {
    const s = await closed();
    await s.wake();
    await s.t.run(async (ctx) => { await ctx.db.patch(s.ids.conv, { inbox_killed_at: Date.now() } as any); });
    await s.classify("needs_input");
    expect((await s.read()).conv.inbox_stashed_at).toBeGreaterThan(0);
  });
});

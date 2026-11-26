// A closed session stays out through machine wakes (shared isMachineWake: a
// trigger firing, a quiet send, another session's message): the wake runs it
// as a hidden stash stamped with its close (isClosedHidden). It comes back
// when it pins blocked, a trigger run completes --needs-attention, or a person
// writes to it; an ordinary session also when it pins done (closeReturnsOnDone),
// a role, anchor or standing trigger's home not.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { formatSessionMessage } from "@codecast/shared/contracts";
import { setup } from "./dispatch.close.testkit";
import { enqueuePendingMessage } from "./pendingMessages";
import { performSetThreadState } from "./conversations";
import { restoreToInbox } from "./inboxFilters";
import { makeAdoptionReleaseDb } from "./lib/adoptionRelease";

setDefaultTimeout(60_000);

async function closed(o: Parameters<typeof setup>[0] = {}) {
  const s = await setup(o);
  await s.send("closeSession", [String(s.ids.conv)]);
  const { conv } = await s.read();
  expect(conv.inbox_closed_at).toBe(conv.inbox_dismissed_at);
  const wake = (fields: Record<string, unknown>) => s.t.run(async (ctx) => {
    await enqueuePendingMessage(ctx, await ctx.db.get(s.ids.conv), s.ids.user, { content: "check CI", ...fields } as any);
  });
  const pin = (status: "done" | "blocked" | "dormant" | "working") => s.t.run(async (ctx) => {
    await performSetThreadState(ctx, (await ctx.db.get(s.ids.conv)) as any, `Pinned ${status}`, status);
  });
  return { ...s, wake, pin };
}

const sessionMessage = { content: formatSessionMessage("jx7work", "Report: CI is green") };

const hiddenStash = (conv: any) => {
  expect(conv.inbox_dismissed_at).toBeUndefined();
  expect(conv.inbox_stashed_at).toBeGreaterThan(0);
  expect(conv.inbox_stashed_at).toBe(conv.inbox_closed_at);
  expect(conv.inbox_stash_hidden).toBe(true);
  expect(conv.inbox_killed_at).toBeUndefined();
};
const inInbox = (conv: any) => {
  expect(conv.inbox_dismissed_at).toBeUndefined();
  expect(conv.inbox_stashed_at).toBeUndefined();
  expect(conv.inbox_killed_at).toBeUndefined();
};

const ROLES: Array<[string, Parameters<typeof setup>[0]]> = [
  ["a role's own session", { role: true }],
  ["a standing anchor", { conv: { persistent: true } }],
  ["a standing trigger's home", { conv: { armed_trigger_kind: "standing" } }],
];
const ORDINARY: Array<[string, Parameters<typeof setup>[0]]> = [
  ["an ordinary session", {}],
  ["a one-off trigger's home", { conv: { armed_trigger_kind: "once" } }],
];

describe("every closed session stays out through machine wakes", () => {
  for (const [name, o] of [...ROLES, ...ORDINARY]) {
    test(`${name}: a trigger, a quiet send and another session's message each run it as a hidden stash`, async () => {
      const s = await closed(o);
      await s.wake({ origin: "scheduler" });
      hiddenStash((await s.read()).conv);
      expect((await s.read()).conv.has_pending_messages).toBe(true);
      await s.wake({ quiet: true });
      hiddenStash((await s.read()).conv);
      await s.wake(sessionMessage);
      hiddenStash((await s.read()).conv);
    });

    test(`${name}: another session's message alone hides it`, async () => {
      const s = await closed(o);
      await s.wake(sessionMessage);
      hiddenStash((await s.read()).conv);
    });

    test(`${name}: pinning blocked brings it back`, async () => {
      const s = await closed(o);
      await s.wake({ origin: "scheduler" });
      await s.pin("blocked");
      const { conv } = await s.read();
      inInbox(conv);
      expect(conv.inbox_stash_hidden).toBeUndefined();
    });

    test(`${name}: pinning dormant or working leaves it out`, async () => {
      const s = await closed(o);
      await s.wake({ origin: "scheduler" });
      await s.pin("dormant");
      hiddenStash((await s.read()).conv);
      await s.pin("working");
      hiddenStash((await s.read()).conv);
    });

    test(`${name}: a person writing brings it back, before or after a hidden wake`, async () => {
      const s = await closed(o);
      await s.wake({ human: true });
      inInbox((await s.read()).conv);
      const t = await closed(o);
      await t.wake(sessionMessage);
      await t.wake({ human: true });
      const { conv } = await t.read();
      inInbox(conv);
      // The flag goes with the stash, so a later plain stash is not a hidden one.
      expect(conv.inbox_stash_hidden).toBeUndefined();
    });

    test(`${name}: a run that completes --needs-attention brings it back`, async () => {
      const s = await closed(o);
      await s.wake({ origin: "scheduler" });
      await s.t.run(async (ctx) => { await restoreToInbox(ctx, (await ctx.db.get(s.ids.conv)) as any); });
      inInbox((await s.read()).conv);
    });
  }
});

describe("pinning done", () => {
  for (const [name, o] of ORDINARY) {
    test(`${name}: brings it back, since it delivered something`, async () => {
      const s = await closed(o);
      await s.wake(sessionMessage);
      await s.pin("done");
      const { conv } = await s.read();
      inInbox(conv);
      expect(conv.inbox_stash_hidden).toBeUndefined();
    });
  }
  for (const [name, o] of ROLES) {
    test(`${name}: leaves it out, since its routine runs end done`, async () => {
      const s = await closed(o);
      await s.wake({ origin: "scheduler" });
      await s.pin("done");
      hiddenStash((await s.read()).conv);
    });
  }

  test("a straggling done before any wake leaves a plain close alone", async () => {
    const s = await closed();
    await s.pin("done");
    const { conv } = await s.read();
    expect(conv.inbox_dismissed_at).toBe(conv.inbox_closed_at);
  });

  test("a person's own Stash and hide does not come back on done", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => { await ctx.db.patch(s.ids.conv, { inbox_stashed_at: Date.now(), inbox_stash_hidden: true }); });
    await s.t.run(async (ctx) => { await performSetThreadState(ctx, (await ctx.db.get(s.ids.conv)) as any, "Shipped", "done"); });
    const { conv } = await s.read();
    expect(conv.inbox_stash_hidden).toBe(true);
    expect(conv.inbox_stashed_at).toBeGreaterThan(0);
  });

  test("a person's Stash and hide on top of a close keeps its own stamp through a wake, so done leaves it out", async () => {
    const s = await closed();
    const at = Date.now() + 10;
    await s.t.run(async (ctx) => { await ctx.db.patch(s.ids.conv, { inbox_stashed_at: at, inbox_stash_hidden: true }); });
    await s.wake({ origin: "scheduler" });
    expect((await s.read()).conv.inbox_stashed_at).toBe(at);
    await s.pin("done");
    const { conv } = await s.read();
    expect(conv.inbox_stashed_at).toBe(at);
    expect(conv.inbox_stash_hidden).toBe(true);
  });

  test("a person's plain stash over a close follows the plain stash rule: a wake shows it", async () => {
    const s = await closed();
    await s.t.run(async (ctx) => { await ctx.db.patch(s.ids.conv, { inbox_stashed_at: Date.now() + 10 }); });
    await s.wake({ origin: "scheduler" });
    inInbox((await s.read()).conv);
  });

  test("an earlier close left on a stash and hide does not mark it as closed", async () => {
    const s = await setup();
    const closedAt = Date.now() - 60_000;
    await s.t.run(async (ctx) => { await ctx.db.patch(s.ids.conv, { inbox_closed_at: closedAt, inbox_stashed_at: Date.now(), inbox_stash_hidden: true }); });
    await s.t.run(async (ctx) => { await performSetThreadState(ctx, (await ctx.db.get(s.ids.conv)) as any, "Shipped", "done"); });
    expect((await s.read()).conv.inbox_stash_hidden).toBe(true);
  });
});

describe("a person's own Stash and hide", () => {
  test("stays out through another session's message, which it used to show", async () => {
    const s = await setup();
    const at = Date.now();
    await s.t.run(async (ctx) => { await ctx.db.patch(s.ids.conv, { inbox_stashed_at: at, inbox_stash_hidden: true }); });
    await s.t.run(async (ctx) => { await enqueuePendingMessage(ctx, await ctx.db.get(s.ids.conv), s.ids.user, sessionMessage); });
    expect((await s.read()).conv.inbox_stashed_at).toBe(at);
  });

  test("a plain stash still comes back on another session's message", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => { await ctx.db.patch(s.ids.conv, { inbox_stashed_at: Date.now() }); });
    await s.t.run(async (ctx) => { await enqueuePendingMessage(ctx, await ctx.db.get(s.ids.conv), s.ids.user, sessionMessage); });
    expect((await s.read()).conv.inbox_stashed_at).toBeUndefined();
  });
});

describe("a send nobody marked keeps showing a closed session", () => {
  test("a codecast notice with no session wrapper brings it back, as before", async () => {
    const s = await closed();
    await s.wake({ content: "Your account switched; continue." });
    inInbox((await s.read()).conv);
  });

  test("a person's `cast send` from a terminal (human, session-wrapped) brings it back", async () => {
    const s = await closed();
    await s.wake({ ...sessionMessage, human: true });
    inInbox((await s.read()).conv);
  });
});

describe("a close set aside mid-turn", () => {
  for (const [name, o] of [["a role's", { role: true }], ["an ordinary session's", {}]] as const) {
    test(`${name} is a hidden stash, so its next wake leaves it out`, async () => {
      const s = await setup({ ...o, agent: "working", conv: { updated_at: Date.now() } });
      await s.send("closeSession", [String(s.ids.conv)]);
      hiddenStash((await s.read()).conv);
      await s.t.run(async (ctx) => { await enqueuePendingMessage(ctx, await ctx.db.get(s.ids.conv), s.ids.user, { content: "check CI", origin: "scheduler" }); });
      hiddenStash((await s.read()).conv);
    });
  }

  test("an ordinary one comes back when its turn finishes done", async () => {
    const s = await setup({ agent: "working", conv: { updated_at: Date.now() } });
    await s.send("closeSession", [String(s.ids.conv)]);
    await s.t.run(async (ctx) => { await performSetThreadState(ctx, (await ctx.db.get(s.ids.conv)) as any, "Shipped the fix", "done"); });
    inInbox((await s.read()).conv);
  });
});

describe("a killed session stays out", () => {
  test("no pin brings it back", async () => {
    const s = await setup();
    const at = Date.now();
    await s.t.run(async (ctx) => { await ctx.db.patch(s.ids.conv, { inbox_killed_at: at, inbox_dismissed_at: at, inbox_closed_at: at }); });
    for (const status of ["done", "blocked"] as const) {
      await s.t.run(async (ctx) => { await performSetThreadState(ctx, (await ctx.db.get(s.ids.conv)) as any, "late", status); });
      expect((await s.read()).conv.inbox_killed_at).toBe(at);
    }
  });
});

describe("the paths around a closed session", () => {
  test("a close the web sets aside (its own read of a running turn) comes back on done", async () => {
    const s = await setup({ agent: "working", conv: { updated_at: Date.now() } });
    const now = Date.now();
    // The patch the web store's closeInDraft sends for a row it sets aside.
    await s.send("closeSession", [String(s.ids.conv)], { [s.ids.conv]: { inbox_stashed_at: now, inbox_stash_hidden: true, inbox_closed_at: now } });
    hiddenStash((await s.read()).conv);
    await s.t.run(async (ctx) => { await performSetThreadState(ctx, (await ctx.db.get(s.ids.conv)) as any, "Shipped", "done"); });
    inInbox((await s.read()).conv);
  });

  test("a worker's report to its closed lead keeps the close's adoption: the worker stays its own card", async () => {
    const s = await setup();
    const kid = await s.t.run(async (ctx) => {
      const t = Date.now();
      const c = await ctx.db.insert("conversations", { user_id: s.ids.user, agent_type: "claude_code", started_at: t, updated_at: t - 3_600_000, status: "active", session_id: "ca19ce3d-0000-4000-8000-000000000001", message_count: 4, is_subagent: true, parent_conversation_id: s.ids.conv, last_message_role: "assistant" } as any);
      await ctx.db.insert("managed_sessions", { session_id: "ca19ce3d-0000-4000-8000-000000000001", conversation_id: c, user_id: s.ids.user, pid: 2, started_at: t, last_heartbeat: t, agent_status: "idle", agent_status_updated_at: t - 3_600_000 } as any);
      return c;
    });
    await s.send("closeSession", [String(s.ids.conv)]);
    const row = (id: any) => s.t.run(async (ctx) => (await ctx.db.get(id)) as any);
    const adopted = (await row(kid)).inbox_adopted_at;
    expect(adopted).toBeGreaterThan(0);
    const send = (fields: Record<string, unknown>) => s.t.run(async (ctx) => {
      const db = makeAdoptionReleaseDb(ctx.db, ctx.db);
      await enqueuePendingMessage({ ...ctx, db } as any, await ctx.db.get(s.ids.conv), s.ids.user, fields as any);
    });
    await send(sessionMessage);
    hiddenStash(await row(s.ids.conv));
    expect((await row(kid)).inbox_adopted_at).toBe(adopted);
    // A person writing ends the close: the worker nests under its lead again.
    await send({ content: "what did it find?", human: true });
    inInbox(await row(s.ids.conv));
    expect((await row(kid)).inbox_adopted_at).toBeUndefined();
  });
});

describe("a team session: each person's own Close follows the same rule", () => {
  async function teamClosed(o: Parameters<typeof setup>[0] = {}) {
    const s = await setup(o);
    const at = Date.now() - 60_000;
    await s.t.run(async (ctx) => {
      const team = await ctx.db.insert("teams", { name: "Crew", created_at: at } as any);
      await ctx.db.patch(s.ids.conv, { team_owner_team_id: team } as any);
      await ctx.db.insert("session_team_owners", { conversation_id: s.ids.conv, team_id: team, created_at: at } as any);
      await ctx.db.insert("session_viewer_triage", { user_id: s.ids.user, conversation_id: s.ids.conv, inbox_dismissed_at: at, inbox_closed_at: at, updated_at: at } as any);
    });
    const triage = () => s.t.run(async (ctx) => (await ctx.db.query("session_viewer_triage").collect())[0] as any);
    const wake = (fields: Record<string, unknown>) => s.t.run(async (ctx) => {
      await enqueuePendingMessage(ctx, await ctx.db.get(s.ids.conv), s.ids.user, { content: "check CI", ...fields } as any);
    });
    const pin = (status: "done" | "blocked") => s.t.run(async (ctx) => {
      await performSetThreadState(ctx, (await ctx.db.get(s.ids.conv)) as any, `Pinned ${status}`, status);
    });
    return { ...s, at, triage, wake, pin };
  }

  test("a machine wake keeps it out; a done pin brings an ordinary one back", async () => {
    const s = await teamClosed();
    await s.wake(sessionMessage);
    hiddenStash(await s.triage());
    await s.pin("done");
    inInbox(await s.triage());
  });

  test("a role's comes back on blocked, not on done", async () => {
    const s = await teamClosed({ role: true });
    await s.wake({ origin: "scheduler" });
    await s.pin("done");
    hiddenStash(await s.triage());
    await s.pin("blocked");
    inInbox(await s.triage());
  });

  test("blocked brings each person's close back even when the row has its own hide", async () => {
    const s = await teamClosed();
    await s.t.run(async (ctx) => { await ctx.db.patch(s.ids.conv, { inbox_dismissed_at: Date.now() }); });
    await s.pin("blocked");
    inInbox(await s.triage());
    inInbox((await s.read()).conv);
  });

  test("a straggling done before any wake leaves the close alone", async () => {
    const s = await teamClosed();
    await s.pin("done");
    expect((await s.triage()).inbox_dismissed_at).toBe(s.at);
  });
});

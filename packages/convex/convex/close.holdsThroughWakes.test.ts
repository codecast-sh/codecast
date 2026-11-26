// A closed role, anchor or standing trigger's home follows the "Stash and
// hide" rules (shared closeHidesThroughWakes): its own machine wakes (a trigger
// firing, a quiet send) run it out of sight as a hidden stash, and it comes
// back when it pins blocked, a trigger run completes --needs-attention, or a
// person writes to it. A close of any other session still comes back on its
// next wake.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { setup } from "./dispatch.close.testkit";
import { enqueuePendingMessage } from "./pendingMessages";
import { performSetThreadState } from "./conversations";
import { restoreToInbox } from "./inboxFilters";

setDefaultTimeout(60_000);

async function closed(o: Parameters<typeof setup>[0] = {}) {
  const s = await setup(o);
  await s.send("closeSession", [String(s.ids.conv)]);
  const { conv } = await s.read();
  expect(conv.inbox_closed_at).toBe(conv.inbox_dismissed_at);
  const wake = (fields: Record<string, unknown>) => s.t.run(async (ctx) => {
    await enqueuePendingMessage(ctx, await ctx.db.get(s.ids.conv), s.ids.user, { content: "check CI", ...fields } as any);
  });
  return { ...s, wake };
}

const hiddenStash = (conv: any) => {
  expect(conv.inbox_dismissed_at).toBeUndefined();
  expect(conv.inbox_stashed_at).toBeGreaterThan(0);
  expect(conv.inbox_stash_hidden).toBe(true);
  expect(conv.inbox_killed_at).toBeUndefined();
};
const inInbox = (conv: any) => {
  expect(conv.inbox_dismissed_at).toBeUndefined();
  expect(conv.inbox_stashed_at).toBeUndefined();
  expect(conv.inbox_killed_at).toBeUndefined();
};

describe("a closed role stays out through its own wakes", () => {
  const homes: Array<[string, Parameters<typeof setup>[0]]> = [
    ["a role's own session", { role: true }],
    ["a standing anchor", { conv: { persistent: true } }],
    ["a standing trigger's home", { conv: { armed_trigger_kind: "standing" } }],
  ];
  for (const [name, o] of homes) {
    test(`${name}: a trigger firing runs it as a hidden stash, again and again`, async () => {
      const s = await closed(o);
      await s.wake({ origin: "scheduler" });
      hiddenStash((await s.read()).conv);
      expect((await s.read()).conv.has_pending_messages).toBe(true);
      await s.wake({ origin: "scheduler" });
      hiddenStash((await s.read()).conv);
    });
  }

  test("a quiet send leaves it out too", async () => {
    const s = await closed({ role: true });
    await s.wake({ quiet: true });
    hiddenStash((await s.read()).conv);
  });

  test("pinning blocked brings it back", async () => {
    const s = await closed({ role: true });
    await s.wake({ origin: "scheduler" });
    await s.t.run(async (ctx) => { await performSetThreadState(ctx, (await ctx.db.get(s.ids.conv)) as any, "Needs your call on the deploy", "blocked"); });
    inInbox((await s.read()).conv);
  });

  test("pinning done or dormant leaves it out", async () => {
    const s = await closed({ role: true });
    await s.wake({ origin: "scheduler" });
    await s.t.run(async (ctx) => { await performSetThreadState(ctx, (await ctx.db.get(s.ids.conv)) as any, "Checked CI, all green", "done"); });
    hiddenStash((await s.read()).conv);
  });

  test("a run that completes --needs-attention brings it back", async () => {
    const s = await closed({ role: true });
    await s.wake({ origin: "scheduler" });
    await s.t.run(async (ctx) => { await restoreToInbox(ctx, (await ctx.db.get(s.ids.conv)) as any); });
    inInbox((await s.read()).conv);
  });

  test("a person writing to it brings it back", async () => {
    const s = await closed({ role: true });
    await s.wake({ human: true });
    inInbox((await s.read()).conv);
  });

  test("another session's message brings it back", async () => {
    const s = await closed({ role: true });
    await s.wake({ origin: "scheduler" });
    await s.wake({});
    inInbox((await s.read()).conv);
  });

  test("a person writing after a hidden wake brings it back", async () => {
    const s = await closed({ role: true });
    await s.wake({ origin: "scheduler" });
    await s.wake({ human: true });
    inInbox((await s.read()).conv);
  });
});

describe("a close set aside mid-turn", () => {
  test("a role's is a hidden stash, so its next trigger leaves it out", async () => {
    const s = await setup({ role: true, agent: "working", conv: { updated_at: Date.now() } });
    await s.send("closeSession", [String(s.ids.conv)]);
    hiddenStash((await s.read()).conv);
    await s.t.run(async (ctx) => { await enqueuePendingMessage(ctx, await ctx.db.get(s.ids.conv), s.ids.user, { content: "check CI", origin: "scheduler" }); });
    hiddenStash((await s.read()).conv);
  });

  test("an ordinary session's is a plain stash, as before", async () => {
    const s = await setup({ agent: "working", conv: { updated_at: Date.now() } });
    await s.send("closeSession", [String(s.ids.conv)]);
    const { conv } = await s.read();
    expect(conv.inbox_stashed_at).toBeGreaterThan(0);
    expect(conv.inbox_stash_hidden).toBeUndefined();
  });
});

describe("an ordinary closed session is unchanged", () => {
  for (const [name, o] of [["no trigger", {}], ["a one-off trigger", { conv: { armed_trigger_kind: "once" } }]] as const) {
    test(`${name}: a trigger firing brings it back`, async () => {
      const s = await closed(o);
      await s.wake({ origin: "scheduler" });
      inInbox((await s.read()).conv);
    });
  }

  test("a quiet send brings it back", async () => {
    const s = await closed();
    await s.wake({ quiet: true });
    inInbox((await s.read()).conv);
  });
});

// Linking a codecast channel to a Slack channel: one mirror per side, the
// Slack name wins, history imports, and how outbound failures change a link.
import { describe, expect, test } from "bun:test";
import { commitLink, patchBackfill, backfillSinceTs, updateLink, recordOutboundFailure } from "./slackSync";
import { updateChannel } from "./chat";
import { ALICE, BOB, TEAM, CHANNEL, OTHER_CHANNEL, LINK, SLACK_CH, context, call, scheduledNames } from "./slackSync.testkit";

describe("link management", () => {
  test("commitLink refuses a second mirror on either side, and a manager-only write", async () => {
    const ctx = context(ALICE);
    await expect(call(commitLink, ctx, { chat_channel_id: CHANNEL, slack_channel_id: "C0NEW", since_ts: "1" })).rejects.toThrow(/already mirrors/);
    await expect(call(commitLink, ctx, { chat_channel_id: OTHER_CHANNEL, slack_channel_id: SLACK_CH, since_ts: "1" })).rejects.toThrow(/already mirrors/);
    const bob = context(BOB);
    // Bob created #random, so he may link it; he may not touch #general's link.
    await expect(call(updateLink, bob, { link_id: LINK, paused: true })).rejects.toThrow();
    const ok = await call(commitLink, bob, { chat_channel_id: OTHER_CHANNEL, slack_channel_id: "C0RANDOM", slack_channel_name: "random-chatter", since_ts: "1" });
    expect(ok.link_id).toBeTruthy();
    // The chat channel takes the Slack channel's name, and the caller is told.
    expect((await bob.db.get(OTHER_CHANNEL)).name).toBe("random-chatter");
    expect(ok.chat_channel_name).toBe("random-chatter");
    expect(ok.slack_channel_name).toBe("random-chatter");
    const notice = bob.db._tables.chat_messages.find((m: any) => m.channel_id === OTHER_CHANNEL);
    expect(notice.sync_local_only).toBe(true);
    expect(notice.external_author.name).toBe("Slack");
  });
  test("a mirrored channel keeps the Slack name: our rename is refused, a taken Slack name is not adopted", async () => {
    const ctx = context(ALICE);
    await expect(call(updateChannel, ctx, { channel_id: CHANNEL, name: "something-else" })).rejects.toThrow(/Slack/);
    // The topic is still ours to set.
    await call(updateChannel, ctx, { channel_id: CHANNEL, topic: "mirrored room" });
    expect((await ctx.db.get(CHANNEL)).topic).toBe("mirrored room");
    // #general is taken by the mirrored channel, so #random linked to a Slack #general stays #random.
    const ok = await call(commitLink, ctx, { chat_channel_id: OTHER_CHANNEL, slack_channel_id: "C0GEN2", slack_channel_name: "general", since_ts: "1" });
    expect(ok.chat_channel_name).toBe("random");
    expect((await ctx.db.get(OTHER_CHANNEL)).name).toBe("random");
  });
  test("a history window seeds the import progress on the link; none leaves it off", async () => {
    const ctx = context(ALICE);
    const ok = await call(commitLink, ctx, { chat_channel_id: OTHER_CHANNEL, slack_channel_id: "C0HIST", slack_channel_name: "history", since_ts: "1", backfill_window: "90d" });
    const link = await ctx.db.get(ok.link_id);
    expect(link.backfill).toMatchObject({ window: "90d", status: "running", fetched: 0 });
    await call(patchBackfill, ctx, { link_id: ok.link_id, fetched: 240, status: "running" });
    expect((await ctx.db.get(ok.link_id)).backfill.fetched).toBe(240);
    await call(patchBackfill, ctx, { link_id: ok.link_id, fetched: 5000, status: "done", capped: true });
    const done = (await ctx.db.get(ok.link_id)).backfill;
    expect(done.status).toBe("done");
    expect(done.capped).toBe(true);
    expect(done.finished_at).toBeGreaterThan(0);
    // A failed import restarts when the link is resumed.
    await call(patchBackfill, ctx, { link_id: ok.link_id, fetched: 12, status: "failed", error: "Slack: ratelimited" });
    await call(updateLink, ctx, { link_id: ok.link_id, paused: false });
    expect((await ctx.db.get(ok.link_id)).backfill).toMatchObject({ status: "running", fetched: 0 });
    expect(scheduledNames(ctx)).toContain("slackSync:backfill");
    // While it runs, another run is refused; once done, an explicit reimport
    // and turning a kind of line on both run it again.
    await expect(call(updateLink, ctx, { link_id: ok.link_id, reimport: true })).rejects.toThrow(/still running/);
    await call(patchBackfill, ctx, { link_id: ok.link_id, fetched: 40, status: "done" });
    await call(updateLink, ctx, { link_id: ok.link_id, options: { bot_messages: false } });
    expect((await ctx.db.get(ok.link_id)).backfill.status).toBe("done"); // turning OFF changes nothing
    await call(updateLink, ctx, { link_id: ok.link_id, options: { bot_messages: true } });
    expect((await ctx.db.get(ok.link_id)).backfill).toMatchObject({ status: "running", fetched: 0, window: "90d" });
    await call(patchBackfill, ctx, { link_id: ok.link_id, fetched: 55, status: "done" });
    const r = await call(updateLink, ctx, { link_id: ok.link_id, reimport: true });
    expect(r.reimport).toBe(true);
    expect((await ctx.db.get(ok.link_id)).backfill.status).toBe("running");
    // No window, no progress object at all.
    const plain = context(BOB);
    const ok2 = await call(commitLink, plain, { chat_channel_id: OTHER_CHANNEL, slack_channel_id: "C0PLAIN", slack_channel_name: "plain", since_ts: "1", backfill_window: "none" });
    expect((await plain.db.get(ok2.link_id)).backfill).toBeUndefined();
  });
  test("history windows resolve to a Slack ts floor", () => {
    const now = 1_700_000_000_000;
    expect(backfillSinceTs("none", now)).toBe("1700000000.000000");
    expect(backfillSinceTs("7d", now)).toBe(((now - 7 * 86_400_000) / 1000).toFixed(6));
    expect(backfillSinceTs("all", now)).toBe("0");
  });
  test("a link whose installation is gone is replaced, not a blocker", async () => {
    const ctx = context(ALICE, { slack_installations: [] });
    await ctx.db.insert("slack_installations", { workspace_id: "T0NEW", workspace_name: "New", bot_user_id: "UB2", bot_token: "x", team_id: TEAM, installed_by_user_id: ALICE, created_at: 1, updated_at: 1 });
    const ok = await call(commitLink, ctx, { chat_channel_id: CHANNEL, slack_channel_id: "C0X", since_ts: "1" });
    expect(ok.link_id).toBeTruthy();
    expect(ctx.db._tables.slack_channel_links.length).toBe(1);
  });
  test("updateLink merges options and clears the error on resume", async () => {
    const ctx = context(ALICE);
    await ctx.db.patch(LINK, { paused: true, last_error: "boom", last_error_at: 5 });
    await call(updateLink, ctx, { link_id: LINK, options: { threads: false }, paused: false, direction: "slack_to_codecast" });
    const link = await ctx.db.get(LINK);
    expect(link.options.threads).toBe(false);
    expect(link.options.reactions).toBe(true);
    expect(link.paused).toBe(false);
    expect(link.last_error).toBeUndefined();
    expect(link.direction).toBe("slack_to_codecast");
  });
  test("a read-only Slack conversation turns the link one-way instead of erroring forever", async () => {
    const ctx = context(ALICE);
    await call(recordOutboundFailure, ctx, { link_id: LINK, error: "restricted_action_read_only_channel" });
    let link = await ctx.db.get(LINK);
    expect(link.direction).toBe("slack_to_codecast");
    expect(link.slack_read_only).toBe(true);
    expect(link.last_error).toBeUndefined();
    expect(link.paused).toBeFalsy();
    await call(updateLink, ctx, { link_id: LINK, direction: "both" });
    link = await ctx.db.get(LINK);
    expect(link.slack_read_only).toBeUndefined();
  });
  test("other outbound failures still record the error", async () => {
    const ctx = context(ALICE);
    await call(recordOutboundFailure, ctx, { link_id: LINK, error: "rate_limited" });
    const link = await ctx.db.get(LINK);
    expect(link.last_error).toBe("rate_limited");
    expect(link.direction).toBe("both");
  });
});

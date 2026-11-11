// Replays as moments under convex-test (learning-loop.md LL7): a recording a
// vendor import saved (PostHog, Sentry) opens a `replay` moment on its source
// the way our own recorder's does, once that source publishes a replay
// extractor and only for a used recording; and an extractor may decline a
// moment, which is kept as skipped and never judged. The model is stubbed at fetch.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api, internal } from "./_generated/api";
import { JUDGE, T0, TOKEN, setup, stubs } from "./moments.testkit";

const REPLAY_EXTRACTOR = { kind: "replay", path: ".codecast/moments/replay.ts", version: "b".repeat(40), quiet_ms: 0, timeout_ms: 30_000 };
const REPLAY_JUDGE = { ...JUDGE, name: "visitor", moment: "replay", parts: ["none"] };

describe("replay moments", () => {
  const s = stubs();
  beforeEach(() => s.install());
  afterEach(() => s.restore());

  async function imported(t: any, source: any, external_id: string, o: { clicks: number; duration_ms: number }) {
    const opened = await t.mutation(internal.replays.openImport, { source_id: source, external_id, started_at: T0 - 120_000 });
    await t.mutation(internal.replays.saveImported, { replay_id: opened.replay_id, provider: "posthog", chunk_keys: [], timeline_md: `replay ${opened.short_id}`, counts: { clicks: o.clicks, errors: 0, failed_requests: 0 }, duration_ms: o.duration_ms, url: "https://example.com/" });
    return opened.short_id as string;
  }
  const replayMoments = (t: any) => t.run(async (ctx: any) => (await ctx.db.query("moments").collect()).filter((m: any) => m.kind === "replay"));

  test("a vendor's used recording opens a replay moment once a replay extractor is published; a glance does not", async () => {
    const { t, ids, scope } = await setup();
    // No replay extractor yet: nothing opens.
    await imported(t, ids.source, "ph-0", { clicks: 5, duration_ms: 60_000 });
    expect(await replayMoments(t)).toHaveLength(0);

    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [REPLAY_EXTRACTOR], judges: [REPLAY_JUDGE] });
    const used = await imported(t, ids.source, "ph-1", { clicks: 5, duration_ms: 60_000 });
    await imported(t, ids.source, "ph-2", { clicks: 1, duration_ms: 60_000 });
    await imported(t, ids.source, "ph-3", { clicks: 9, duration_ms: 10_000 });
    const opened = await replayMoments(t);
    expect(opened.map((m: any) => [m.subject, m.status])).toEqual([[used, "waiting"]]);
    expect(JSON.parse(opened[0].refs_json)).toEqual({ replay: used });
  });

  test("an extractor that declines a moment leaves it skipped with its reason, and no judge runs", async () => {
    const { t, ids, scope } = await setup();
    await t.mutation(api.moments.publish, { ...scope, source: "app", device_id: "host-1", root: "/repo", extractors: [REPLAY_EXTRACTOR], judges: [REPLAY_JUDGE] });
    await t.mutation(api.modelCalls.budgetForCli, { ...scope, set_usd: 5 });
    await imported(t, ids.source, "ph-1", { clicks: 5, duration_ms: 60_000 });
    await t.run(async (ctx: any) => { for (const m of await ctx.db.query("moments").collect()) await ctx.db.patch(m._id, { due_at: Date.now() - 1 }); });
    const [c] = await t.mutation(api.moments.claim, { api_token: TOKEN, device_id: "host-1" });
    const reply = await t.action(api.moments.complete, { api_token: TOKEN, device_id: "host-1", moment: c.moment, extractor_version: "b".repeat(40), output: JSON.stringify({ skip: "a staff page, not the public site" }) });
    expect(reply).toMatchObject({ status: "skipped", error: "a staff page, not the public site" });
    const [m] = await replayMoments(t);
    expect(m).toMatchObject({ status: "skipped", error: "a staff page, not the public site" });
    expect(m.claim_device).toBeUndefined();
    expect(await t.run((ctx: any) => ctx.db.query("judge_runs").collect())).toHaveLength(0);
    expect(s.state.model).toHaveLength(0);
  });
});

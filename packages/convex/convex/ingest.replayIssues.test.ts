// Replay issues (external-data.md X5): the walls recordings show become
// replay_issue groups through the one upsert, keyed by route and failure, one
// count per recording, promoted like errors.
import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { applyReplayIssues } from "./ingest";
import { clearGroups } from "./replayIssues";
import { replayIssues } from "@codecast/shared/replay";
import type { ReplayEvent } from "@codecast/shared/contracts/replay";

const h = (fn: any) => fn._handler;
const NOW = Date.now();

function world(promote: string[] = ["new", "regressed"]) {
  const scheduled: Array<{ name: string; args: any }> = [];
  const db = makeFakeDb(
    {
      users: [{ _id: "u1" }],
      teams: [{ _id: "team_1", name: "Acme" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      counters: [],
      event_sources: [
        { _id: "src1", workspace: "team:team_1", team_id: "team_1", owner_user_id: "u1", short_id: "src-1", provider: "posthog", name: "acme-posthog", fingerprint_prefix: "acme", promote, status: "active", created_at: 1, updated_at: 1 },
      ],
      event_groups: [],
      event_samples: [],
      external_events: [],
      agent_tasks: [],
      replays: [],
      signals: [],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const scheduler = { runAfter: async (_ms: number, fn: any, args: any) => void scheduled.push({ name: getFunctionName(fn), args }) };
  return { db: db as any, scheduled, ctx: { db, scheduler } as any };
}

/** A group with its tally (occurrences held off the row) laid over, as a detail reader sees it. */
function live(w: ReturnType<typeof world>, g: any) {
  const t = (w.db._tables.event_group_tallies ?? []).find((x: any) => x.group_id === g._id);
  return t ? { ...g, ...Object.fromEntries(Object.entries(JSON.parse(t.fields_json)).map(([k, value]) => [k, value ?? undefined])) } : g;
}

let n = 0;
async function recording(w: ReturnType<typeof world>, events: ReplayEvent[]) {
  const id = `rec-${++n}`;
  const _id = await w.db.insert("replays", {
    workspace: "team:team_1", team_id: "team_1", source_id: "src1", short_id: `rp-${n}`, provider: "posthog", external_id: id,
    started_at: NOW - 3_600_000, counts: { clicks: 0, errors: 0, failed_requests: 0 }, group_ids: [], chunk_keys: [], created_at: NOW, updated_at: NOW,
  });
  const apply = () => h(applyReplayIssues)(w.ctx, { replay_id: _id, issues_json: JSON.stringify(replayIssues(events)) });
  return { _id, apply };
}

const broken = (orderId: string): ReplayEvent[] => [
  { type: "nav", t: 0, url: `https://app.acme.com/orders/${orderId}` },
  { type: "network", t: 50, method: "POST", url: `https://api.acme.com/orders/${orderId}/pay`, status: 500, ms: 120 },
  { type: "console", t: 60, level: "error", message: "Payment failed for order 77" },
];

describe("replay issues", () => {
  test("recordings of one failure on one route make one group per failure, counted once each", async () => {
    const w = world();
    const a = await recording(w, broken("1001"));
    const b = await recording(w, broken("2002"));
    expect(await a.apply()).toMatchObject({ groups: 2, transitions: 2 });
    expect(await b.apply()).toMatchObject({ groups: 2, transitions: 0 });
    // A second read of the same recording (an assembly, a re-import, a regroup) adds nothing.
    expect(await a.apply()).toMatchObject({ groups: 0 });

    const groups = w.db._tables.event_groups.map((g: any) => live(w, g));
    expect(groups.map((g: any) => [g.kind, g.title, g.count, g.status])).toEqual([
      ["replay_issue", "POST api.acme.com/orders/:id/pay answers 500", 2, "open"],
      ["replay_issue", "Payment failed for order 77", 2, "open"],
    ]);
    expect(groups[0].fingerprint).toMatch(/^replay:request-[0-9a-f]{8}$/);
    expect(groups[0].culprit).toBe("/orders/:id");
    const rows = w.db._tables.replays;
    expect(rows.every((r: any) => r.group_ids.length === 2)).toBe(true);
    expect(w.db._tables.event_samples.some((s: any) => s.replay_external_id === "rec-1" || s.replay_id)).toBe(true);
  });

  test("a new group is announced once and promotes under the source's prefix", async () => {
    const w = world();
    await (await recording(w, broken("1"))).apply();
    await (await recording(w, broken("2"))).apply();
    const events = w.db._tables.external_events;
    expect(events.map((e: any) => e.data.transition)).toEqual(["new", "new"]);
    expect(events[0].data.group_kind).toBe("replay_issue");
    const promotions = w.scheduled.filter((s) => s.name === "ingest:promote");
    expect(promotions).toHaveLength(2);
    expect(promotions[0].args.fingerprint).toMatch(/^acme:replay:request-/);
  });

  test("a resolved issue seen in a later recording regresses", async () => {
    const w = world();
    await (await recording(w, broken("1"))).apply();
    for (const g of w.db._tables.event_groups) Object.assign(g, { status: "resolved", resolved_at: NOW - 7_200_000 });
    await (await recording(w, broken("2"))).apply();
    expect(w.db._tables.event_groups.map((g: any) => g.status)).toEqual(["open", "open"]);
    expect(w.db._tables.external_events.filter((e: any) => e.data.transition === "regressed")).toHaveLength(2);
  });

  test("a paused source groups nothing", async () => {
    const w = world();
    w.db._tables.event_sources[0].status = "paused";
    expect(await (await recording(w, broken("1"))).apply()).toEqual({ groups: 0, transitions: 0 });
    expect(w.db._tables.event_groups).toHaveLength(0);
  });

  test("clearing takes a source's issue groups down with their rows and links, and keeps one that reached a cause", async () => {
    const w = world();
    await (await recording(w, broken("1"))).apply();
    const [a, b] = w.db._tables.event_groups;
    b.signal_task_id = "task_1";
    await w.db.insert("signals", { workspace: "team:team_1", source: "posthog:acme-posthog", subject: a.short_id, fingerprint: "f", created_at: 1 });
    expect(await h(clearGroups)(w.ctx, { source_id: "src1" })).toEqual({ cleared: 1, kept: 1 });
    expect(w.db._tables.event_groups.map((g: any) => g._id)).toEqual([b._id]);
    expect(w.db._tables.event_samples.every((s: any) => s.group_id !== a._id)).toBe(true);
    expect(w.db._tables.external_events.every((e: any) => e.group_id !== a._id)).toBe(true);
    expect(w.db._tables.signals).toHaveLength(0);
    expect(w.db._tables.replays[0].group_ids).toEqual([b._id]);
  });
});

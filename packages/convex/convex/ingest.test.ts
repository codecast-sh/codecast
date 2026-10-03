import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { gzipSync, strToU8 } from "fflate";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { sha256Hex } from "./lib/hash";
import { HOUR_MS, hourStart } from "./lib/ingestGroups";
import { INGEST_LIMITS, isIngestKey } from "@codecast/shared/contracts/ingest";
import {
  applyBatch,
  createSource,
  getGroup,
  getSource,
  listEvents,
  listGroups,
  listSources,
  promotionInputs,
  promotionSignal,
  rotateKey,
  setGroupStatus,
  sourceForKey,
  updateSource,
} from "./ingest";
import { listForTeam } from "./externalEvents";
import { nextArmingAfterRun } from "./agentTasks";
import { decodeIngestBody, ingestErrorStatus, ingestKeyFrom, originAllowed } from "./ingestHttp";

const h = (fn: any) => fn._handler;

function world() {
  const scheduled: Array<{ name: string; args: any }> = [];
  const db = makeFakeDb(
    {
      users: [{ _id: "u1", active_team_id: "team_1" }, { _id: "u2" }],
      teams: [{ _id: "team_1", name: "Acme" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      counters: [],
      projects: [],
      event_sources: [],
      event_groups: [],
      event_samples: [],
      external_events: [],
      agent_tasks: [],
      conversations: [],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const scheduler = { runAfter: async (_ms: number, fn: any, args: any) => void scheduled.push({ name: getFunctionName(fn), args }) };
  const as = (userId: string) => ({ auth: { getUserIdentity: async () => ({ subject: `${userId}|sess` }) }, db, scheduler }) as any;
  return { db: db as any, scheduled, as, internalCtx: { db, scheduler } as any };
}

const TEAM = { workspace: "team" as const, team_id: "team_1" as any };

async function teamSource(w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
  const out = await h(createSource)(w.as("u1"), { ...TEAM, name: " Union ", provider: "sdk", ...extra });
  return out as { source: any; ingest_key: string };
}

const NOW = Date.now();
const err = (message: string, over: Record<string, unknown> = {}) => ({ type: "error", message, at: NOW, ...over });
const batch = (w: ReturnType<typeof world>, sourceId: string, items: unknown[], extra: Record<string, unknown> = {}) =>
  h(applyBatch)(w.internalCtx, { source_id: sourceId, items_json: JSON.stringify(items), ...extra });
const names = (w: ReturnType<typeof world>) => w.scheduled.map((s) => s.name);

describe("sources", () => {
  test("create returns the key once and stores only its hash", async () => {
    const w = world();
    const { source, ingest_key } = await teamSource(w);
    expect(isIngestKey(ingest_key)).toBe(true);
    const row = w.db._tables.event_sources[0];
    expect(row.ingest_key_hash).toBe(await sha256Hex(ingest_key));
    expect(row).toMatchObject({ workspace: "team:team_1", team_id: "team_1", owner_user_id: "u1", name: "union", status: "active", short_id: "src-1", promote: ["new", "regressed"] });
    expect(source.ingest_key_hash).toBeUndefined();
    expect(source.keyed).toBe(true);
    expect(JSON.stringify(await h(listSources)(w.as("u1"), TEAM))).not.toContain(row.ingest_key_hash);
  });

  test("no public source function returns the key hash", async () => {
    const w = world();
    await teamSource(w);
    const hash = w.db._tables.event_sources[0].ingest_key_hash;
    const outs = [
      await h(getSource)(w.as("u1"), { ...TEAM, source: "union" }),
      await h(updateSource)(w.as("u1"), { ...TEAM, source: "union", promote: ["new"] }),
      await h(listSources)(w.as("u1"), TEAM),
    ];
    const rotated = await h(rotateKey)(w.as("u1"), { ...TEAM, source: "union" });
    for (const out of [...outs, rotated]) expect(JSON.stringify(out)).not.toContain("ingest_key_hash");
    expect(JSON.stringify(outs)).not.toContain(hash);
  });

  test("a name is unique per workspace, whatever its spelling", async () => {
    const w = world();
    await teamSource(w);
    await expect(h(createSource)(w.as("u1"), { ...TEAM, name: "UNION", provider: "http" })).rejects.toThrow(/already exists/);
  });

  test("a connector source gets no key", async () => {
    const w = world();
    const out = await h(createSource)(w.as("u1"), { ...TEAM, name: "sentry", provider: "sentry" });
    expect(out.ingest_key).toBeUndefined();
    expect(w.db._tables.event_sources[0].ingest_key_hash).toBeUndefined();
  });

  test("rotate replaces the hash, so the old key stops resolving", async () => {
    const w = world();
    const { ingest_key } = await teamSource(w);
    const { ingest_key: next } = await h(rotateKey)(w.as("u1"), { ...TEAM, source: "union" });
    expect(next).not.toBe(ingest_key);
    expect(await h(sourceForKey)(w.internalCtx, { key_hash: await sha256Hex(ingest_key) })).toBeNull();
    expect(await h(sourceForKey)(w.internalCtx, { key_hash: await sha256Hex(next) })).toMatchObject({ status: "active" });
  });

  test("someone outside the workspace cannot see or change it", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await expect(h(rotateKey)(w.as("u2"), { workspace: "personal", source: source.short_id })).rejects.toThrow(/not found/);
    expect(await h(listSources)(w.as("u2"), { workspace: "personal" })).toEqual([]);
  });

  test("resume clears the reason a source stopped", async () => {
    const w = world();
    await teamSource(w);
    w.db._tables.event_sources[0].status = "paused";
    w.db._tables.event_sources[0].last_error = "filer left";
    const { source } = await h(updateSource)(w.as("u1"), { ...TEAM, source: "src-1", status: "active" });
    expect(source.status).toBe("active");
    expect(source.last_error).toBeUndefined();
  });
});

describe("applyBatch", () => {
  test("a new error makes a group, a sample, one timeline row, a trigger firing and a promotion", async () => {
    const w = world();
    const { source } = await teamSource(w);
    const res = await batch(w, source._id, [err("Boom 1"), err("Boom 2")], { release: "1.0.0", environment: "prod" });
    expect(res).toEqual({ accepted: 2, dropped: 0, transitions: 1 });

    const group = w.db._tables.event_groups[0];
    expect(group).toMatchObject({ workspace: "team:team_1", source_id: source._id, short_id: "eg-1", kind: "error", status: "open", count: 2, title: "Boom 2", first_release: "1.0.0" });
    expect(group.fingerprint.startsWith("error:")).toBe(true);
    expect(w.db._tables.event_samples).toHaveLength(2);

    const event = w.db._tables.external_events[0];
    expect(event).toMatchObject({ workspace: "team:team_1", team_id: "team_1", source_id: source._id, group_id: group._id, kind: "error_new", source: "sdk" });
    expect(event.repository).toBeUndefined();
    expect(event.data).toMatchObject({ transition: "new", group_short_id: "eg-1", source_name: "union", release: "1.0.0", environment: "prod" });

    const fire = w.scheduled.find((s) => s.name === "agentTasks:matchTaskTriggers")!;
    expect(fire.args).toMatchObject({ event_type: "error_new", team_id: "team_1", workspace: "team:team_1", source: "union", event_ref: { external_event_id: event._id, group_short_id: "eg-1" } });
    const promo = w.scheduled.find((s) => s.name === "ingest:promote")!;
    expect(promo.args).toMatchObject({ group_id: group._id, transition: "new", fingerprint: group.fingerprint });

    expect(w.db._tables.event_sources[0]).toMatchObject({ events_today: 2, groups_open: 1 });
  });

  test("a repeat only counts: no row, no firing", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom")]);
    w.scheduled.length = 0;
    const res = await batch(w, source._id, [err("Boom", { at: NOW + 1 })]);
    expect(res.transitions).toBe(0);
    expect(w.db._tables.event_groups[0].count).toBe(2);
    expect(w.db._tables.external_events).toHaveLength(1);
    expect(w.scheduled).toEqual([]);
  });

  test("the fingerprint prefix reaches the signal, not the stored group", async () => {
    const w = world();
    const { source } = await teamSource(w, { fingerprint_prefix: "union", promote: ["check_failed"] });
    await batch(w, source._id, [{ type: "check", id: "orders-balance", ok: false }]);
    expect(w.db._tables.event_groups[0].fingerprint).toBe("invariant:orders-balance");
    expect(w.scheduled.find((s) => s.name === "ingest:promote")!.args.fingerprint).toBe("union:invariant:orders-balance");
  });

  test("a check flips red then green; a transition the source does not promote only fires", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [{ type: "check", id: "c1", ok: true, at: NOW - 2000 }]);
    expect(w.db._tables.external_events).toHaveLength(0);
    await batch(w, source._id, [{ type: "check", id: "c1", ok: false, at: NOW - 1000 }]);
    await batch(w, source._id, [{ type: "check", id: "c1", ok: true, at: NOW }]);
    expect(w.db._tables.external_events.map((e: any) => e.kind)).toEqual(["check_failed", "check_recovered"]);
    expect(names(w).filter((n) => n === "agentTasks:matchTaskTriggers")).toHaveLength(2);
    expect(names(w)).not.toContain("ingest:promote");
    expect(w.db._tables.event_groups[0]).toMatchObject({ status: "resolved", meta: { ok: true } });
    // A green report keeps no sample.
    expect(w.db._tables.event_samples).toHaveLength(1);
    expect(w.db._tables.event_sources[0].groups_open).toBe(0);
  });

  test("samples stay at 20 per group", async () => {
    const w = world();
    const { source } = await teamSource(w);
    for (let i = 0; i < 6; i++) {
      await batch(w, source._id, Array.from({ length: 10 }, (_, j) => err("Boom", { at: NOW - 100_000 + i * 100 + j })));
    }
    expect(w.db._tables.event_samples).toHaveLength(20);
    expect(w.db._tables.event_groups[0].count).toBe(60);
  });

  test("a resolved error that comes back regresses and promotes", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom", { at: NOW - 10 })]);
    await h(setGroupStatus)(w.as("u1"), { group: "eg-1", status: "resolved", resolved_in: "1.0.0" });
    expect(w.db._tables.event_sources[0].groups_open).toBe(0);
    w.scheduled.length = 0;
    await batch(w, source._id, [err("Boom")], { release: "0.9.0" });
    expect(w.db._tables.external_events).toHaveLength(1);
    await batch(w, source._id, [err("Boom", { at: NOW + 1 })], { release: "1.0.1" });
    expect(w.db._tables.external_events.map((e: any) => e.kind)).toEqual(["error_new", "error_regressed"]);
    expect(w.scheduled.find((s) => s.name === "ingest:promote")!.args.transition).toBe("regressed");
  });

  test("a spike announces against a quiet day", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom", { at: NOW - 30 * HOUR_MS })]);
    const hour = hourStart(NOW);
    await batch(w, source._id, Array.from({ length: 25 }, (_, i) => err("Boom", { at: hour + i })));
    expect(w.db._tables.external_events.map((e: any) => e.kind)).toEqual(["error_new", "error_spike"]);
  });

  test("a deploy is one marker however often it is reported", async () => {
    const w = world();
    const { source } = await teamSource(w);
    const deploy = { type: "deploy", version: "1.2.0", sha: "abc", at: NOW };
    await batch(w, source._id, [deploy], { environment: "prod" });
    await batch(w, source._id, [deploy], { environment: "prod" });
    expect(w.db._tables.external_events).toHaveLength(1);
    expect(w.db._tables.external_events[0]).toMatchObject({ kind: "deploy", title: "Deployed 1.2.0 to prod", sha: "abc" });
    expect(w.scheduled.find((s) => s.name === "agentTasks:matchTaskTriggers")!.args).toMatchObject({ event_type: "deploy", source: "union" });
  });

  test("events, info logs and replays are accepted without a group", async () => {
    const w = world();
    const { source } = await teamSource(w);
    const res = await batch(w, source._id, [{ type: "event", name: "signup", at: NOW }, { type: "log", level: "info", message: "hi", at: NOW }, { type: "replay", replay_id: "r", at: NOW }]);
    expect(res).toEqual({ accepted: 3, dropped: 0, transitions: 0 });
    expect(w.db._tables.event_groups).toHaveLength(0);
  });

  test("a paused source takes nothing", async () => {
    const w = world();
    const { source } = await teamSource(w);
    w.db._tables.event_sources[0].status = "paused";
    expect(await batch(w, source._id, [err("Boom")])).toEqual({ accepted: 0, dropped: 1, transitions: 0 });
    expect(w.db._tables.event_groups).toHaveLength(0);
  });

  test("the team feed leaves the transitions out; the ingestion timeline has them", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom")]);
    expect(await h(listForTeam)(w.as("u1"), { team_id: "team_1" })).toEqual([]);
    expect(await h(listEvents)(w.as("u1"), TEAM)).toHaveLength(1);
    expect(await h(listEvents)(w.as("u1"), { ...TEAM, source: "union" })).toHaveLength(1);
  });
});

describe("readers", () => {
  test("groups and their samples are the workspace's only", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom"), { type: "job_failed", job: "Send", error: "x", at: NOW }]);
    expect((await h(listGroups)(w.as("u1"), TEAM)).map((g: any) => g.kind).sort()).toEqual(["error", "job"]);
    expect((await h(listGroups)(w.as("u1"), { ...TEAM, kind: "job" })).map((g: any) => g.short_id)).toEqual(["eg-2"]);
    const shown = await h(getGroup)(w.as("u1"), { group: "eg-1" });
    expect(shown.samples).toHaveLength(1);
    expect(shown.source).toMatchObject({ name: "union", short_id: "src-1" });
    expect(await h(listGroups)(w.as("u2"), { workspace: "personal" })).toEqual([]);
    await expect(h(getGroup)(w.as("u2"), { group: "eg-1" })).rejects.toThrow(/not found/);
    await expect(h(setGroupStatus)(w.as("u2"), { group: "eg-1", status: "ignored" })).rejects.toThrow(/not found/);
  });
});

describe("promotion", () => {
  const source = { provider: "sdk" as const, name: "union", workspace: "team:team_1", team_id: "team_1" as any, project_id: "p1" as any };
  const group = { short_id: "eg-4", kind: "error" as const, title: "Boom", culprit: "load@/a.js", count: 3, first_seen: 1, last_seen: 2, last_release: "1.0" };

  test("files in the source's workspace and project, by the kind map", () => {
    expect(promotionSignal(source, group, "new", "union:error:abc")).toMatchObject({
      source: "sdk:union",
      kind: "bug",
      fingerprint: "union:error:abc",
      title: "Boom",
      subject: "eg-4",
      observed_at: 2,
      workspace: "team",
      team_id: "team_1",
      project: "p1",
    });
    expect(promotionSignal(source, group, "spike", "f")!.kind).toBe("regression");
    expect(promotionSignal({ ...source, workspace: "user:u1", team_id: undefined, project_id: undefined }, group, "regressed", "f")).toMatchObject({ workspace: "personal" });
    expect(promotionSignal(source, group, "resolved", "f")).toBeNull();
  });

  test("a filer who left the team cannot file", async () => {
    const w = world();
    const { source: created } = await teamSource(w);
    await batch(w, created._id, [err("Boom")]);
    const groupId = w.db._tables.event_groups[0]._id;
    expect((await h(promotionInputs)(w.internalCtx, { group_id: groupId }))!.filer_may_file).toBe(true);
    w.db._tables.team_memberships.length = 0;
    expect((await h(promotionInputs)(w.internalCtx, { group_id: groupId }))!.filer_may_file).toBe(false);
  });
});

describe("trigger payload", () => {
  test("an event trigger spends its pending events when it re-arms", () => {
    expect(nextArmingAfterRun({ schedule_type: "event" } as any, NOW)).toHaveProperty("pending_events", undefined);
    expect("pending_events" in nextArmingAfterRun({ schedule_type: "event" } as any, NOW)).toBe(true);
  });
});

describe("the door", () => {
  test("the key comes from the path on either prefix, else the bearer header", () => {
    expect(ingestKeyFrom("/cli/ingest/cc_ing_abc", null)).toBe("cc_ing_abc");
    expect(ingestKeyFrom("/api/ingest/cc_ing_abc/extra", null)).toBe("cc_ing_abc");
    expect(ingestKeyFrom("/cli/ingest/", "Bearer cc_ing_xyz")).toBe("cc_ing_xyz");
    expect(ingestKeyFrom("/cli/ingest/", null)).toBeNull();
  });

  test("origins: no list allows any, a list allows only its members", () => {
    expect(originAllowed(null, "https://evil.example")).toBe(true);
    expect(originAllowed(["https://app.union.dev/"], "https://app.union.dev")).toBe(true);
    expect(originAllowed(["https://app.union.dev"], "https://evil.example")).toBe(false);
    expect(originAllowed(["https://app.union.dev"], null)).toBe(true);
  });

  test("bodies: plain, gzip, a gzip bomb, junk", () => {
    const body = JSON.stringify({ items: [] });
    expect(decodeIngestBody(strToU8(body), null)).toEqual({ text: body });
    expect(decodeIngestBody(gzipSync(strToU8(body)), "gzip")).toEqual({ text: body });
    const bomb = gzipSync(new Uint8Array(INGEST_LIMITS.max_bytes + 10));
    expect(bomb.byteLength).toBeLessThan(INGEST_LIMITS.max_bytes);
    expect(decodeIngestBody(bomb, "gzip")).toMatchObject({ status: 413 });
    expect(decodeIngestBody(new Uint8Array(INGEST_LIMITS.max_bytes + 1), null)).toMatchObject({ status: 413 });
    expect(decodeIngestBody(strToU8("not gzip"), "gzip")).toMatchObject({ status: 400 });
    expect(decodeIngestBody(strToU8(body), "br")).toMatchObject({ status: 400 });
  });

  test("errors map like the CLI routes", () => {
    expect(ingestErrorStatus({ data: { code: "FORBIDDEN" } })).toBe(403);
    expect(ingestErrorStatus({ data: { code: "RATE_LIMITED" } })).toBe(429);
    expect(ingestErrorStatus(new Error("boom"))).toBe(500);
  });
});

import { describe, expect, setSystemTime, test } from "bun:test";
import { sha256Hex } from "./lib/hash";
import { HOUR_MS, hourStart } from "./lib/ingestGroups";
import { isIngestKey } from "@codecast/shared/contracts/ingest";
import { applyBatch, backfillGroupUsers, createSource, dailyUpkeep, endOldKey, flushGroupTally, getGroup, purgeSourceRows, removeSource, getSource, listEvents, listGroups, listSources, linkSignal, promoteDue, PROMOTE_DUE_BATCH, promotionInputs, OLD_KEY_GRACE_MS, rotateKey, setGroupFix, setGroupStatus, setGroupTask, groupTransitions, sourceForKey, updateSource } from "./ingest";
import { OVERFLOW_FP, SOURCE_CAPS } from "./lib/groupWrite";
import { PROMOTE_RETRY_MS, PROMOTE_SPACING_MS, PROMOTE_TRIES, queuePromotions, settlePromotion } from "./ingestPromotions";
import { promotionSignal } from "./lib/ingestPayloads";
import { listForTask, listForTeam } from "./externalEvents";
import { applyTaskUpdate, insertTask, nextArmingAfterRun } from "./agentTasks";
import { h, world, armedWorld, TEAM, teamSource, NOW, err, batch, names, live, stats } from "./ingest.testkit";

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

  test("rotate keeps the old key for its grace window; end_old, endOldKey or the window's end stop it", async () => {
    const w = world();
    const { ingest_key } = await teamSource(w);
    const resolve = async (key: string) => h(sourceForKey)(w.internalCtx, { key_hash: await sha256Hex(key) });
    const { ingest_key: next } = await h(rotateKey)(w.as("u1"), { ...TEAM, source: "union" });
    expect(next).not.toBe(ingest_key);
    expect(await resolve(next)).toMatchObject({ status: "active" });
    expect((await resolve(next)).old_key).toBeUndefined();
    expect(await resolve(ingest_key)).toMatchObject({ status: "active", old_key: true });
    setSystemTime(new Date(Date.now() + OLD_KEY_GRACE_MS + 1_000));
    try {
      expect(await resolve(ingest_key)).toBeNull();
    } finally {
      setSystemTime();
    }
    const { ingest_key: third } = await h(rotateKey)(w.as("u1"), { ...TEAM, source: "union" });
    expect(await resolve(next)).toMatchObject({ old_key: true });
    await h(endOldKey)(w.as("u1"), { ...TEAM, source: "union" });
    expect(await resolve(next)).toBeNull();
    const { ingest_key: fourth } = await h(rotateKey)(w.as("u1"), { ...TEAM, source: "union", end_old: true });
    expect(await resolve(third)).toBeNull();
    expect(await resolve(fourth)).toMatchObject({ status: "active" });
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
    const w = await armedWorld();
    const { source } = await teamSource(w);
    const res = await batch(w, source._id, [err("Boom 1"), err("Boom 2")], { release: "1.0.0", environment: "prod" });
    expect(res).toEqual({ accepted: 2, dropped: 0, transitions: 1, folded: 0 });

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

    expect(stats(w)).toMatchObject({ events_today: 2, groups_open: 1 });
    // The counters stay off the source row, which every Ops query reads.
    expect(w.db._tables.event_sources[0].events_today).toBeUndefined();
    expect((await h(getSource)(w.as("u1"), { ...TEAM, source: "union" })).events_today).toBe(2);
  });

  test("one Convex function's error is one group across requests, argument values and browsers", async () => {
    const w = world();
    const { source } = await teamSource(w);
    const refused = (requestId: string, value: string) =>
      `[CONVEX Q(sessionFlowRuns:forConversation)] [Request ID: ${requestId}] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .conversation_id\nValue: "${value}"\nValidator: v.id("conversations")\n\n\n  Called by client`;
    const chrome = (message: string) => `Error: ${message}\n    at An.queryResult (https://codecast.sh/assets/convex-Btvm0TSz.js:2:11855)`;
    const a = refused("840724336f5b92b8", "lmj2gfa4b78upxm786ffa");
    const b = refused("39d07d0b34fc4046", "i5yz2zt0t976fvtn52xtp");
    const c = refused("dbe41b2eebe7520f", "o73g9z4it236dmwj90l83");
    await batch(w, source._id, [
      err(a, { stack: chrome(a) }),
      err(b, { stack: chrome(b), at: NOW + 1 }),
      err(c, { stack: "queryResult@https://codecast.sh/assets/convex-CuwZpkwa.js:2:11855", at: NOW + 2 }),
      err(refused("43124caab399da9c", "x").replace("sessionFlowRuns:forConversation", "sessionFlowRuns:forTask"), { at: NOW + 3 }),
    ]);
    const groups = w.db._tables.event_groups;
    expect(groups).toHaveLength(2);
    expect(groups.map((g: any) => g.culprit).sort()).toEqual(["sessionFlowRuns:forConversation", "sessionFlowRuns:forTask"]);
    expect(live(w).count).toBe(3);
  });

  test("a repeat only counts: no row, no firing", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom")]);
    w.scheduled.length = 0;
    const res = await batch(w, source._id, [err("Boom", { at: NOW + 1 })]);
    expect(res.transitions).toBe(0);
    expect(live(w).count).toBe(2);
    expect(w.db._tables.external_events).toHaveLength(1);
    // A quiet repeat inside a minute holds its numbers on the tally, so the
    // issues list (the group rows) does not re-run; one flush writes them.
    expect(w.db._tables.event_groups[0].count).toBe(1);
    expect(names(w)).toEqual(["ingest:flushGroupTally"]);
    expect((await h(getGroup)(w.as("u1"), { group: "eg-1" })).group.count).toBe(2);
  });

  test("the fingerprint prefix reaches the signal, not the stored group", async () => {
    const w = world();
    const { source } = await teamSource(w, { fingerprint_prefix: "union", promote: ["check_failed"] });
    await batch(w, source._id, [{ type: "check", id: "orders-balance", ok: false }]);
    expect(w.db._tables.event_groups[0].fingerprint).toBe("invariant:orders-balance");
    expect(w.scheduled.find((s) => s.name === "ingest:promote")!.args.fingerprint).toBe("union:invariant:orders-balance");
  });

  test("a check flips red then green; a transition the source does not promote only fires", async () => {
    const w = await armedWorld();
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
    expect(stats(w).groups_open).toBe(0);
  });

  test("samples stay at 20 per group", async () => {
    const w = world();
    const { source } = await teamSource(w);
    for (let i = 0; i < 6; i++) {
      await batch(w, source._id, Array.from({ length: 10 }, (_, j) => err("Boom", { at: NOW - 100_000 + i * 100 + j })));
    }
    expect(w.db._tables.event_samples).toHaveLength(20);
    expect(live(w).count).toBe(60);
    expect(live(w).sample_count).toBe(20);
  });

  test("a resolved error that comes back regresses and promotes", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom", { at: NOW - 10 })]);
    await h(setGroupStatus)(w.as("u1"), { group: "eg-1", status: "resolved", resolved_in: "1.0.0" });
    expect(stats(w).groups_open).toBe(0);
    w.scheduled.length = 0;
    await batch(w, source._id, [err("Boom")], { release: "0.9.0" });
    expect(w.db._tables.external_events).toHaveLength(1);
    await batch(w, source._id, [err("Boom", { at: NOW + 1 })], { release: "1.0.1" });
    expect(w.db._tables.external_events.map((e: any) => e.kind)).toEqual(["error_new", "error_regressed"]);
    expect(w.scheduled.find((s) => s.name === "ingest:promote")!.args.transition).toBe("regressed");
  });

  test("a regression after a second resolve announces even when the occurrence reuses an earlier regression's at", async () => {
    const w = await armedWorld();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom", { at: NOW - 10 })]);
    await h(setGroupStatus)(w.as("u1"), { group: "eg-1", status: "resolved" });
    await batch(w, source._id, [err("Boom", { at: NOW })]);
    await new Promise((r) => setTimeout(r, 2));
    await h(setGroupStatus)(w.as("u1"), { group: "eg-1", status: "resolved", resolved_in: "1.1.0" });
    w.scheduled.length = 0;
    // A retried batch: the same `at` as the first regression.
    await batch(w, source._id, [err("Boom", { at: NOW })], { release: "1.1.0" });
    expect(w.db._tables.event_groups[0].status).toBe("open");
    expect(w.db._tables.external_events.map((e: any) => e.kind)).toEqual(["error_new", "error_regressed", "error_regressed"]);
    expect(names(w)).toContain("agentTasks:matchTaskTriggers");
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
    const w = await armedWorld();
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
    expect(res).toEqual({ accepted: 3, dropped: 0, transitions: 0, folded: 0 });
    expect(w.db._tables.event_groups).toHaveLength(0);
    // An analytics event is counted per name and hour on the source, and its payload is not kept.
    await batch(w, source._id, [{ type: "event", name: "signup", at: NOW, props: { plan: "plan-zeta" } }, { type: "event", name: "checkout", at: NOW }]);
    const names = stats(w).event_names;
    expect(names.map((e: any) => [e.name, e.buckets.reduce((n: number, b: any) => n + b.count, 0)])).toEqual([["signup", 2], ["checkout", 1]]);
    expect(JSON.stringify(w.db._tables.event_source_stats)).not.toContain("plan-zeta");
  });

  test("a paused source takes nothing", async () => {
    const w = world();
    const { source } = await teamSource(w);
    w.db._tables.event_sources[0].status = "paused";
    expect(await batch(w, source._id, [err("Boom")])).toEqual({ accepted: 0, dropped: 1, transitions: 0, folded: 0 });
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

  test("a record is never listed as an issue: a CI run filed as its own group, a check that never failed", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom")]);
    const base = { ...w.db._tables.event_groups[0] };
    delete base._id;
    await w.db.insert("event_groups", { ...base, short_id: "eg-8", kind: "check", fingerprint: "invariant:ci:a/b:Deploy 76f24cd8c", title: "Deploy 76f24cd8c4d1 for Aivery on a/b main", count: 1, status: "resolved" });
    await w.db.insert("event_groups", { ...base, short_id: "eg-9", kind: "check", fingerprint: "invariant:quiet", title: "Quiet invariant", count: 0, status: "resolved" });
    expect((await h(listGroups)(w.as("u1"), TEAM)).map((g: any) => g.short_id)).toEqual(["eg-1"]);
    expect((await h(listGroups)(w.as("u1"), { ...TEAM, status: "resolved" }))).toEqual([]);
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

  test("a source routed to a team but private to its owner files into the owner's workspace, never the team's", () => {
    // The same rule moments.ts uses for a live judge's findings (lib/ingestScope.sourceFilingScope).
    const filed = promotionSignal({ ...source, workspace: "user:u1" }, group, "new", "f")!;
    expect(filed.workspace).toBe("personal");
    expect("team_id" in filed).toBe(false);
  });

  test("the promoting transition and every later one land on the cause task's timeline", async () => {
    const w = world();
    w.db._tables.tasks = [{ _id: "t1", short_id: "ct-1", title: "Boom", user_id: "u1", team_id: "team_1", workspace: "team:team_1", status: "open", created_at: NOW, updated_at: NOW }];
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom", { at: NOW - 10 })]);
    const promo = w.scheduled.find((s) => s.name === "ingest:promote")!;
    const first = w.db._tables.external_events[0];
    expect(promo.args.external_event_id).toBe(first._id);
    // What ingest.promote writes back once signals.ingestAs names the cause.
    await h(linkSignal)(w.internalCtx, { group_id: promo.args.group_id, task_id: "t1", external_event_id: promo.args.external_event_id });
    await h(linkSignal)(w.internalCtx, { group_id: promo.args.group_id, task_id: "t1", external_event_id: promo.args.external_event_id });
    expect(w.db._tables.external_events[0]).toMatchObject({ task_id: "t1", task_ids: ["t1"] });

    await h(setGroupStatus)(w.as("u1"), { group: "eg-1", status: "resolved" });
    await batch(w, source._id, [err("Boom")], { release: "2.0.0" });
    const regressed = w.db._tables.external_events[1];
    expect(regressed).toMatchObject({ kind: "error_regressed", task_id: "t1", task_ids: ["t1"] });

    const timeline = await h(listForTask)(w.as("u1"), { task_id: "t1" });
    expect(timeline.map((e: any) => e.kind)).toEqual(["error_regressed", "error_new"]);
  });

  test("a promotion never stamps a row of another group", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom"), { type: "job_failed", job: "Send", error: "x", at: NOW }]);
    const [a, b] = w.db._tables.event_groups;
    const jobEvent = w.db._tables.external_events.find((e: any) => e.group_id === b._id);
    await h(linkSignal)(w.internalCtx, { group_id: a._id, task_id: "t1", external_event_id: jobEvent._id });
    expect(jobEvent.task_id).toBeUndefined();
    expect(w.db._tables.event_groups[0].signal_task_id).toBe("t1");
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

describe("what one source can cost (review fixes)", () => {
  test("a deploy reported again (a retried batch, an SDK reporting at boot) fires its triggers once", async () => {
    const w = await armedWorld();
    const { source } = await teamSource(w);
    const deploy = { type: "deploy", version: "1.2.0", sha: "abc", at: NOW };
    expect((await batch(w, source._id, [deploy])).transitions).toBe(1);
    expect((await batch(w, source._id, [deploy])).transitions).toBe(0);
    expect(names(w).filter((n) => n === "agentTasks:matchTaskTriggers")).toHaveLength(1);
  });

  test("new fingerprints past the hourly cap fold into one overflow group per kind", async () => {
    const w = world();
    const { source } = await teamSource(w);
    const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => err(`Distinct ${from + i}`, { fingerprint: `fp-${from + i}` }));
    await batch(w, source._id, many(0, SOURCE_CAPS.new_groups_per_hour - 2));
    const res = await batch(w, source._id, many(1000, 10));
    expect(res.folded).toBe(8);
    const groups = w.db._tables.event_groups;
    expect(groups).toHaveLength(SOURCE_CAPS.new_groups_per_hour + 1);
    const overflow = groups.find((g: any) => g.fingerprint.endsWith(OVERFLOW_FP))!;
    expect(live(w, groups.indexOf(overflow)).count).toBe(8);
    // Later batches past the cap keep landing there, not in new rows.
    await batch(w, source._id, many(2000, 5));
    expect(w.db._tables.event_groups).toHaveLength(SOURCE_CAPS.new_groups_per_hour + 1);
  });

  test("promotions past the hourly cap wait on their group and file once the window has room", async () => {
    const w = await armedWorld();
    const { source } = await teamSource(w);
    for (let i = 0; i < SOURCE_CAPS.promotions_per_hour + 3; i++) await batch(w, source._id, [err(`E${i}`, { fingerprint: `p${i}` })]);
    expect(names(w).filter((n) => n === "ingest:promote")).toHaveLength(SOURCE_CAPS.promotions_per_hour);
    expect(names(w).filter((n) => n === "agentTasks:matchTaskTriggers")).toHaveLength(SOURCE_CAPS.promotions_per_hour + 3);
    // The ones scheduled stay on their group until their run settles; the held-back three wait for the window.
    const held = () => w.db._tables.event_groups.filter((g: any) => g.promotion_due && g.promotion_due.scheduled_at === undefined);
    expect(held()).toHaveLength(3);
    // Still the same hour: the window has no room, and the scheduled runs are in flight, so nothing more files.
    expect((await h(promoteDue)(w.internalCtx, {})).filed).toBe(0);
    // An hour on, the held-back three file, spaced apart, and every run settles.
    setSystemTime(new Date(Date.now() + 3_600_000 + 1_000));
    try {
      for (const g of w.db._tables.event_groups) if (g.promotion_due?.scheduled_at !== undefined) await h(settlePromotion)(w.internalCtx, { group_id: g._id });
      const delays: number[] = [];
      const runAfter = w.internalCtx.scheduler.runAfter;
      w.internalCtx.scheduler.runAfter = async (ms: number, fn: any, args: any) => { delays.push(ms); return runAfter(ms, fn, args); };
      expect(await h(promoteDue)(w.internalCtx, {})).toEqual({ due: 3, filed: 3 });
      expect(delays).toEqual([0, PROMOTE_SPACING_MS, 2 * PROMOTE_SPACING_MS]);
    } finally {
      setSystemTime();
    }
    expect(names(w).filter((n) => n === "ingest:promote")).toHaveLength(SOURCE_CAPS.promotions_per_hour + 3);
    expect(held()).toHaveLength(0);
  });

  test("a paused source holding a full batch of promotions does not starve another source", async () => {
    const w = await armedWorld();
    const { source: paused } = await teamSource(w, { name: "paused" });
    const { source: other } = await teamSource(w, { name: "other" });
    await w.db.patch(paused._id, { status: "paused" });
    for (let i = 0; i < PROMOTE_DUE_BATCH + 5; i++) {
      await w.db.insert("event_groups", { source_id: paused._id, promotion_due: { transition: "new", fingerprint: `held${i}`, at: NOW - 100_000 + i } });
    }
    const waiting = await w.db.insert("event_groups", { source_id: other._id, promotion_due: { transition: "new", fingerprint: "waiting", at: NOW } });
    // The first pass reads only the paused source's rows and sends them to the back.
    expect(await h(promoteDue)(w.internalCtx, {})).toEqual({ due: PROMOTE_DUE_BATCH, filed: 0 });
    let filedOther = false;
    for (let pass = 0; pass < 3 && !filedOther; pass++) {
      await h(promoteDue)(w.internalCtx, {});
      filedOther = (await w.db.get(waiting)).promotion_due?.scheduled_at !== undefined;
    }
    expect(filedOther).toBe(true);
    // The paused source's promotions are kept for when it resumes.
    expect(w.db._tables.event_groups.filter((g: any) => g.source_id === paused._id && g.promotion_due)).toHaveLength(PROMOTE_DUE_BATCH + 5);
  });

  test("a promotion whose run never settles is scheduled again, and let go after its tries", async () => {
    const w = await armedWorld();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Lost", { fingerprint: "lost" })]);
    const group = () => w.db._tables.event_groups[0];
    const runs = () => names(w).filter((n) => n === "ingest:promote").length;
    expect(group().promotion_due).toMatchObject({ transition: "new", tries: 1 });
    // A run in flight is left alone.
    expect((await h(promoteDue)(w.internalCtx, {})).filed).toBe(0);
    let at = Date.now();
    try {
      for (let tries = 2; tries <= PROMOTE_TRIES; tries++) {
        at += PROMOTE_RETRY_MS + 1_000;
        setSystemTime(new Date(at));
        expect((await h(promoteDue)(w.internalCtx, {})).filed).toBe(1);
        expect(group().promotion_due.tries).toBe(tries);
      }
      at += PROMOTE_RETRY_MS + 1_000;
      setSystemTime(new Date(at));
      expect((await h(promoteDue)(w.internalCtx, {})).filed).toBe(0);
    } finally {
      setSystemTime();
    }
    expect(runs()).toBe(PROMOTE_TRIES);
    expect(group().promotion_due).toBeUndefined();
  });

  test("groups opened before their kind promoted queue behind the cap and file through promoteDue", async () => {
    const w = await armedWorld();
    const { source } = await teamSource(w, { promote: [], fingerprint_prefix: "union" });
    await batch(w, source._id, [err("Old", { fingerprint: "old" }), { type: "job_failed", job: "nightly", error: "x", at: NOW }]);
    expect(names(w)).not.toContain("ingest:promote");
    const [errGroup, jobGroup] = w.db._tables.event_groups;
    await h(updateSource)(w.as("u1"), { ...TEAM, source: "union", promote: ["new"] });
    const out = await h(queuePromotions)(w.internalCtx, { short_ids: [errGroup.short_id, jobGroup.short_id, "eg-999"] });
    expect(out).toEqual({
      queued: [errGroup.short_id],
      skipped: [{ short_id: jobGroup.short_id, why: "union promotes no job transition" }, { short_id: "eg-999", why: "no such group" }],
    });
    expect(w.db._tables.event_groups[0].promotion_due).toMatchObject({ transition: "new", fingerprint: `union:${errGroup.fingerprint}` });
    expect(await h(promoteDue)(w.internalCtx, {})).toEqual({ due: 1, filed: 1 });
    expect(w.scheduled.find((s) => s.name === "ingest:promote")?.args).toMatchObject({ group_id: errGroup._id, transition: "new", fingerprint: `union:${errGroup.fingerprint}` });
  });

  test("a deploy's sha joins the release's errors to the commit and the session that wrote it", async () => {
    const w = world();
    const { source } = await teamSource(w);
    const sha = "a".repeat(40);
    w.db._tables.conversations.push({ _id: "c1", user_id: "u1", short_id: "jx1abcd" });
    (w.db._tables.commits ??= []).push({ _id: "k1", sha, message: "Fix the thing\n\nbody", author_name: "Ann", timestamp: NOW, conversation_id: "c1" });
    await batch(w, source._id, [{ type: "deploy", version: "2.0.0", sha, at: NOW }], { environment: "prod" });
    await batch(w, source._id, [err("Boom")], { release: "2.0.0", environment: "prod" });
    expect(w.db._tables.event_groups[0].last_sha).toBe(sha);
    const { commit } = await h(getGroup)(w.as("u1"), { group: "eg-1" });
    expect(commit).toMatchObject({ sha, message: "Fix the thing", session: "jx1abcd" });
    // A release with no deploy sha on record names another build: the join clears.
    await batch(w, source._id, [err("Boom", { at: NOW + 1 })], { release: "2.0.1", environment: "prod" });
    expect(live(w).last_sha).toBeUndefined();
  });

  test("a held tally flushes onto the row, and a write after the minute goes to the row directly", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom")]);
    await batch(w, source._id, [err("Boom", { at: NOW + 1 })]);
    await h(flushGroupTally)(w.internalCtx, { group_id: w.db._tables.event_groups[0]._id });
    expect(w.db._tables.event_groups[0].count).toBe(2);
    expect(w.db._tables.event_group_tallies).toHaveLength(0);
    w.db._tables.event_groups[0].updated_at = NOW - 120_000;
    await batch(w, source._id, [err("Boom", { at: NOW + 2 })]);
    expect(w.db._tables.event_groups[0].count).toBe(3);
  });

  test("a group written before sample_count is counted once, then trimmed by the count", async () => {
    const w = world();
    const { source } = await teamSource(w);
    for (let i = 0; i < 4; i++) await batch(w, source._id, Array.from({ length: 5 }, (_, j) => err("Boom", { at: NOW - 1000 + i * 10 + j })));
    w.db._tables.event_groups[0].updated_at = 0;
    delete w.db._tables.event_groups[0].sample_count;
    (w.db._tables.event_group_tallies ?? []).length = 0;
    await batch(w, source._id, [err("Boom", { at: NOW })]);
    expect(w.db._tables.event_samples).toHaveLength(20);
    expect(w.db._tables.event_groups[0].sample_count).toBe(20);
  });

  test("removing a source purges its rows a bounded page at a time, watches and replays included", async () => {
    const w = world();
    const { source } = await teamSource(w);
    for (let i = 0; i < 45; i++) await batch(w, source._id, Array.from({ length: 5 }, (_, j) => err(`E${i}`, { fingerprint: `g${i}`, at: NOW - j })));
    (w.db._tables.metric_watches ??= []).push({ _id: "mw1", source_id: source._id, workspace: "team:team_1" });
    (w.db._tables.replays ??= []).push({ _id: "rp1", source_id: source._id, workspace: "team:team_1", started_at: NOW });
    (w.db._tables.replay_timelines ??= []).push({ _id: "rt1", replay_id: "rp1", timeline_md: "x", updated_at: NOW });
    await h(removeSource)(w.as("u1"), { ...TEAM, source: "union" });
    let runs = 0;
    while (w.scheduled.some((x) => x.name === "ingest:purgeSourceRows") && runs < 20) {
      w.scheduled.length = 0;
      await h(purgeSourceRows)(w.internalCtx, { source_id: source._id });
      runs++;
    }
    expect(runs).toBeGreaterThan(1);
    for (const table of ["event_groups", "event_samples", "metric_watches", "replays", "replay_timelines", "event_source_stats"]) {
      expect((w.db._tables[table] ?? []).length).toBe(0);
    }
  });

  test("a workspace holds one app connector, since it reads through the workspace's one app connection", async () => {
    const w = world();
    await h(createSource)(w.as("u1"), { ...TEAM, name: "union", provider: "app" });
    await expect(h(createSource)(w.as("u1"), { ...TEAM, name: "billing", provider: "app" })).rejects.toThrow(/already has an app connector/);
  });

  test("the daily prune reads only groups whose buckets can still change", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Recent", { at: NOW - 80 * HOUR_MS }), err("Old", { fingerprint: "old", at: NOW - 30 * 24 * HOUR_MS })]);
    const before = w.db._tables.event_groups.map((g: any) => ({ ...g }));
    await h(dailyUpkeep)(w.internalCtx, {});
    const old = w.db._tables.event_groups.find((g: any) => g.title === "Old");
    expect(old).toEqual(before.find((g: any) => g.title === "Old"));
  });
});

describe("trigger payload", () => {
  test("an event trigger spends its pending events when it re-arms", () => {
    expect(nextArmingAfterRun({ schedule_type: "event" } as any, NOW)).toHaveProperty("pending_events", undefined);
    expect("pending_events" in nextArmingAfterRun({ schedule_type: "event" } as any, NOW)).toBe(true);
  });
});

describe("trigger source filters", () => {
  // A trigger with no project_path fires in its owner's personal workspace
  // (agentTasks triggerWorkspaceKey), so the source lives there.
  const personalSource = (w: ReturnType<typeof world>) => h(createSource)(w.as("u1"), { workspace: "personal", name: " Union ", provider: "sdk" });
  const armed = (w: ReturnType<typeof world>, source: string) =>
    insertTask(w.internalCtx, "u1" as any, { title: "t", prompt: "p", schedule_type: "event", event_filter: { event_type: "error_new", source } });

  test("a name or src-N is stored as the source's canonical name", async () => {
    const w = world();
    await personalSource(w);
    await armed(w, "src-1");
    await armed(w, " UNION ");
    expect(w.db._tables.agent_tasks.map((t: any) => t.event_filter.source)).toEqual(["union", "union"]);
  });

  test("an unknown source is refused at save, naming the known ones, on create and on edit", async () => {
    const w = world();
    await personalSource(w);
    await expect(armed(w, "unoin")).rejects.toThrow(/No source "unoin".*union \(src-1\)/);
    expect(w.db._tables.agent_tasks).toHaveLength(0);
    await armed(w, "union");
    const task = w.db._tables.agent_tasks[0];
    await expect(
      applyTaskUpdate(w.internalCtx, task, { schedule_type: "event", event_filter: { event_type: "error_new", source: "src-9" } }, { userId: "u1" as any, source: "cli" }),
    ).rejects.toThrow(/No source "src-9"/);
  });

  test("a blank source is dropped and no source is not checked", async () => {
    const w = world();
    await armed(w, "  ");
    expect(w.db._tables.agent_tasks[0].event_filter).toEqual({ event_type: "error_new" });
  });
});

describe("people and the fix on a group", () => {
  test("users counts distinct people across batches, the quiet tally included", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom", { user: { email: "a@x.io" } }), err("Boom", { user: { email: "A@x.io" } }), err("Boom", { user: { id: "u-2" } }), err("Boom")]);
    expect(w.db._tables.event_groups[0].users).toBe(2);
    expect(w.db._tables.event_groups[0].users_since).toBeUndefined();
    await batch(w, source._id, [err("Boom", { at: NOW + 1, user: { email: "a@x.io" } }), err("Boom", { at: NOW + 2, user: { email: "c@x.io" } })]);
    expect(live(w).users).toBe(3);
    expect(w.db._tables.event_group_users).toHaveLength(3);
    await h(flushGroupTally)(w.internalCtx, { group_id: w.db._tables.event_groups[0]._id });
    expect(w.db._tables.event_groups[0].users).toBe(3);
  });

  test("a group that predates the count starts counting and says since when", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom")]);
    const g = w.db._tables.event_groups[0];
    await w.db.patch(g._id, { users: undefined, users_since: undefined, updated_at: 0 });
    await batch(w, source._id, [err("Boom", { at: NOW + 1, user: { email: "a@x.io" } })]);
    expect(live(w)).toMatchObject({ users: 1 });
    expect(typeof live(w).users_since).toBe("number");
  });

  test("a group that counted nobody counts the people its kept samples name, once", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom", { user: { email: "a@x.io" } }), err("Boom", { at: NOW + 1, user: { email: "b@x.io" } })]);
    await h(flushGroupTally)(w.internalCtx, { group_id: w.db._tables.event_groups[0]._id });
    const g = w.db._tables.event_groups[0];
    // As a group written before people were counted reads: samples name people, the group counts none.
    await w.db.patch(g._id, { users: undefined, users_since: undefined });
    for (const row of [...w.db._tables.event_group_users]) await w.db.delete(row._id);
    await h(backfillGroupUsers)(w.internalCtx, {});
    expect(w.db._tables.event_groups[0].users).toBe(2);
    expect(w.db._tables.event_group_users).toHaveLength(2);
    // A second pass finds the group counted and adds nobody.
    await h(backfillGroupUsers)(w.internalCtx, {});
    expect(w.db._tables.event_group_users).toHaveLength(2);
  });

  test("purging a source takes its people rows with its groups", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom", { user: { email: "a@x.io" } })]);
    await h(purgeSourceRows)(w.internalCtx, { source_id: source._id });
    expect(w.db._tables.event_group_users).toHaveLength(0);
  });

  test("the fix session is recorded by its owner only", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom")]);
    const mine = await w.db.insert("conversations", { user_id: "u1" });
    const theirs = await w.db.insert("conversations", { user_id: "u2" });
    await expect(h(setGroupFix)(w.as("u1"), { group: "eg-1", conversation_id: theirs })).rejects.toThrow();
    const out = await h(setGroupFix)(w.as("u1"), { group: "eg-1", conversation_id: mine });
    expect(out.group).toMatchObject({ fix_conversation_id: mine });
    expect(typeof w.db._tables.event_groups[0].fix_started_at).toBe("number");
  });
  test("a misfiled problem task is re-pointed by short id or unlinked, and only to a task the caller reads", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom")]);
    const mine = await w.db.insert("tasks", { short_id: "ct-7", title: "Real cause", user_id: "u1", team_id: "team_1", workspace: "team:team_1", status: "open", priority: "medium", created_at: NOW, updated_at: NOW });
    await w.db.insert("tasks", { short_id: "ct-8", title: "Someone else's", user_id: "u2", workspace: "user:u2", status: "open", priority: "medium", created_at: NOW, updated_at: NOW });
    const out = await h(setGroupTask)(w.as("u1"), { group: "eg-1", task: "ct-7" });
    expect(out.task_id).toBe(mine);
    expect(w.db._tables.event_groups[0].signal_task_id).toBe(mine);
    await expect(h(setGroupTask)(w.as("u1"), { group: "eg-1", task: "ct-8" })).rejects.toThrow();
    await h(setGroupTask)(w.as("u1"), { group: "eg-1", task: null });
    expect(w.db._tables.event_groups[0].signal_task_id).toBeUndefined();
  });

  test("a group's transitions come with its source's deploys and nothing of its siblings", async () => {
    const w = world();
    const { source } = await teamSource(w);
    await batch(w, source._id, [err("Boom"), err("Other")]);
    const out = await h(groupTransitions)(w.as("u1"), { group: "eg-1", days: 7 });
    const mine = w.db._tables.event_groups[0]._id;
    expect(out.complete).toBe(true);
    expect(out.events.length).toBeGreaterThan(0);
    expect(out.events.every((e: any) => e.group_id === mine || e.kind === "deploy")).toBe(true);
  });
});

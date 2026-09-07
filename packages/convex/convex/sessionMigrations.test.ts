import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  isStaleMigration,
  matchesProject,
  performBeginSession,
  performCancelBatch,
  performCreateBatch,
  performEnqueueQuiesce,
  performFailSession,
  performFinishSession,
  performReapStale,
  performRetryFailed,
  planMigration,
  STALE_MIGRATION_MS,
  summarizeBatch,
} from "./sessionMigrations";
import { canDaemonSeePendingMessage } from "./pendingMessages";

// The bulk-migration rail, end to end on the fake db: planning, the fence,
// the quiesce target, the one-transaction flip, and the reaper. Transfers
// themselves live in the CLI; here the rows and the conversation are what
// must be right after every step.

const ME = "u".repeat(31) + "m";
const OTHER = "u".repeat(31) + "o";
const LAPTOP = "laptop-device";
const LAPTOP2 = "laptop-two";
const BOX = "box-device";
const NOW = 1_700_000_000_000;
const ONLINE = NOW - 10_000;
const OFFLINE = NOW - 60 * 60 * 1000;

function fixtures(overrides: { conversations?: any[]; devices?: any[]; managed?: any[] } = {}) {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me" }, { _id: OTHER, name: "Other" }],
    devices: overrides.devices ?? [
      { _id: "d1", user_id: ME, device_id: LAPTOP, label: "MacBook", last_seen: ONLINE },
      { _id: "d2", user_id: ME, device_id: LAPTOP2, label: "Desk", last_seen: ONLINE - 5_000 },
      { _id: "d3", user_id: ME, device_id: BOX, label: "Linux box", is_remote: true, last_seen: OFFLINE },
    ],
    conversations: overrides.conversations ?? [
      { _id: "c1", short_id: "c1short", session_id: "s1", user_id: ME, owner_device_id: LAPTOP, agent_type: "claude_code", status: "active", project_path: "/Users/me/src/repo/.codecast/worktrees/a", title: "A" },
      { _id: "c2", short_id: "c2short", session_id: "s2", user_id: ME, owner_device_id: LAPTOP, agent_type: "claude_code", status: "active", project_path: "/Users/me/src/repo/.codecast/worktrees/a", title: "B" },
      { _id: "c3", short_id: "c3short", session_id: "s3", user_id: ME, owner_device_id: BOX, agent_type: "claude_code", status: "active", project_path: "/home/ubuntu/work/repo/.codecast/worktrees/cloud-1", title: "On the box" },
    ],
    managed_sessions: overrides.managed ?? [
      { _id: "m1", session_id: "s1", conversation_id: "c1", user_id: ME, agent_status: "working" },
    ],
    daemon_commands: [],
    migration_batches: [],
    session_migrations: [],
    pending_messages: [],
  });
}

const conv = (db: any, id: string) => db._tables.conversations.find((c: any) => c._id === id);
const commands = (db: any) => db._tables.daemon_commands as any[];
const rowsOf = (db: any) => db._tables.session_migrations as any[];

describe("planMigration", () => {
  const devices = [
    { device_id: LAPTOP, last_seen: ONLINE, label: "MacBook" },
    { device_id: LAPTOP2, last_seen: OFFLINE, label: "Desk" },
    { device_id: BOX, is_remote: true, last_seen: OFFLINE, label: "Linux box" },
  ];
  const base = { session_id: "s", agent_type: "claude_code", status: "active" };

  test("laptop → cloud: the owner executes (it holds the files); an offline owner's row is refused; an unowned row goes to the freshest online laptop", () => {
    const { rows, skipped } = planMigration({
      conversations: [
        { ...base, _id: "a", owner_device_id: LAPTOP },
        { ...base, _id: "b", owner_device_id: LAPTOP2 },
        { ...base, _id: "c" },
      ],
      devices, targetDeviceId: BOX, now: NOW,
    });
    expect(skipped).toEqual([expect.objectContaining({ conversation_id: "b", reason: "Desk is offline — it holds the session's files" })]);
    expect(rows.map((r) => [r.conversation_id, r.direction, r.executor_device_id])).toEqual([
      ["a", "to_cloud", LAPTOP],
      ["c", "to_cloud", LAPTOP],
    ]);
  });

  test("cloud → laptop: the destination executes and must be online", () => {
    const ok = planMigration({ conversations: [{ ...base, _id: "x", owner_device_id: BOX }], devices, targetDeviceId: LAPTOP, now: NOW });
    expect(ok.rows).toHaveLength(1);
    expect(ok.rows[0]).toMatchObject({ direction: "to_local", executor_device_id: LAPTOP, from_device_id: BOX });
    const offline = planMigration({ conversations: [{ ...base, _id: "x", owner_device_id: BOX }], devices, targetDeviceId: LAPTOP2, now: NOW });
    expect(offline.rows).toEqual([]);
    expect(offline.skipped[0].reason).toContain("offline");
  });

  test("every refusal names its reason", () => {
    const { rows, skipped } = planMigration({
      conversations: [
        { ...base, _id: "ended", owner_device_id: LAPTOP, status: "completed" },
        { ...base, _id: "killed", owner_device_id: LAPTOP, inbox_killed_at: 1 },
        { ...base, _id: "sub", owner_device_id: LAPTOP, is_subagent: true },
        { ...base, _id: "busy", owner_device_id: LAPTOP, migration: { batch_id: "mg-old" } },
        { ...base, _id: "placing", owner_device_id: BOX, cloud_placement: "pending" },
        { ...base, _id: "codex", owner_device_id: LAPTOP, agent_type: "codex" },
        { ...base, _id: "notranscript", owner_device_id: LAPTOP, session_id: undefined },
        { ...base, _id: "local2local", owner_device_id: LAPTOP2 },
      ],
      devices, targetDeviceId: LAPTOP, now: NOW,
    });
    expect(rows).toEqual([]);
    const reasons = Object.fromEntries(skipped.map((s) => [s.conversation_id, s.reason]));
    expect(reasons.ended).toContain("ended");
    expect(reasons.killed).toContain("killed");
    expect(reasons.sub).toContain("subagent");
    expect(reasons.busy).toContain("mg-old");
    expect(reasons.placing).toContain("placed");
    expect(reasons.codex).toContain("Claude Code");
    expect(reasons.notranscript).toContain("transcript");
    expect(reasons.local2local).toContain("Run on this device");
  });

  test("a session already on the destination, and a cloud-to-cloud move, are refused", () => {
    const { rows, skipped } = planMigration({
      conversations: [
        { ...base, _id: "here", owner_device_id: BOX },
        { ...base, _id: "c2c", owner_device_id: "other-box" },
      ],
      devices: [...devices, { device_id: "other-box", is_remote: true, last_seen: ONLINE }],
      targetDeviceId: BOX, now: NOW,
    });
    expect(rows).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual([expect.stringContaining("already on"), expect.stringContaining("two cloud hosts")]);
  });

  test("no online laptop means nothing can go to the cloud", () => {
    const { rows, skipped } = planMigration({
      conversations: [{ ...base, _id: "a", owner_device_id: LAPTOP }, { ...base, _id: "unowned" }],
      devices: [{ device_id: LAPTOP, label: "MacBook", last_seen: OFFLINE }, { device_id: BOX, is_remote: true, last_seen: ONLINE }],
      targetDeviceId: BOX, now: NOW,
    });
    expect(rows).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual([
      "MacBook is offline — it holds the session's files",
      expect.stringContaining("no online local machine"),
    ]);
  });
});

describe("performCreateBatch", () => {
  test("one batch, one row per session, one command per executor", async () => {
    const db = fixtures();
    const res = await performCreateBatch({ db }, ME as any, { conversation_ids: ["c1", "c2", "c3", "nope"], to_device_id: BOX }, NOW);
    expect(res.batch_id).toMatch(/^mg-[a-z0-9]{8}$/);
    expect(res.rows.map((r) => r.conversation_id)).toEqual(["c1", "c2"]);
    expect(res.skipped).toEqual([
      { conversation_id: "nope", reason: "not a session you run" },
      expect.objectContaining({ conversation_id: "c3", reason: expect.stringContaining("already on") }),
    ]);
    expect(rowsOf(db).map((r) => [r.position, r.status, r.executor_device_id])).toEqual([[0, "queued", LAPTOP], [1, "queued", LAPTOP]]);
    const cmds = commands(db);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ command: "migrate_sessions", target_device_id: LAPTOP, user_id: ME });
    expect(JSON.parse(cmds[0].args)).toEqual({ batch_id: res.batch_id });
    const batch = db._tables.migration_batches[0];
    expect(batch).toMatchObject({ batch_id: res.batch_id, to_device_id: BOX, concurrency: 2, executor_device_ids: [LAPTOP] });
    expect(batch.wait_for_idle_ms).toBe(10 * 60 * 1000);
    // Creating the batch fences nothing yet: rows queued deep in a batch keep receiving messages.
    expect(conv(db, "c1").migration).toBeUndefined();
  });

  test("short ids resolve like ids; options are clamped", async () => {
    const db = fixtures();
    const res = await performCreateBatch({ db }, ME as any, { conversation_ids: ["c1short"], to_device_id: BOX, wait_for_idle_ms: -5, concurrency: 99 }, NOW);
    expect(res.rows.map((r) => r.conversation_id)).toEqual(["c1"]);
    expect(db._tables.migration_batches[0]).toMatchObject({ wait_for_idle_ms: 0, concurrency: 4 });
  });

  test("nothing movable → no batch, no command", async () => {
    const db = fixtures();
    const res = await performCreateBatch({ db }, ME as any, { conversation_ids: ["c3"], to_device_id: BOX }, NOW);
    expect(res.batch_id).toBeNull();
    expect(db._tables.migration_batches).toEqual([]);
    expect(commands(db)).toEqual([]);
  });

  test("another user's sessions are not yours to move", async () => {
    const db = fixtures({ conversations: [{ _id: "x", session_id: "sx", user_id: OTHER, owner_device_id: LAPTOP, agent_type: "claude_code", status: "active" }] });
    const res = await performCreateBatch({ db }, ME as any, { conversation_ids: ["x"], to_device_id: BOX }, NOW);
    expect(res.batch_id).toBeNull();
    expect(res.skipped[0].reason).toBe("not a session you run");
  });
});

describe("selectors — the agent's 'move everything labeled x'", () => {
  function labeled() {
    const db = fixtures();
    db._tables.inbox_buckets = [{ _id: "b1", user_id: ME, name: "rollout", created_at: NOW, updated_at: NOW }];
    db._tables.bucket_assignments = [
      { _id: "ba1", user_id: ME, conversation_id: "c2", bucket_id: "b1", updated_at: NOW },
      { _id: "ba2", user_id: ME, conversation_id: "c3", bucket_id: "b1", updated_at: NOW },
    ];
    return db;
  }

  test("--label picks the filed sessions; the plan still decides direction and skips", async () => {
    const db = labeled();
    const res = await performCreateBatch({ db }, ME as any, { selector: { label: "rollout" }, to_device_id: BOX }, NOW);
    expect(res.rows.map((r) => r.conversation_id)).toEqual(["c2"]);
    expect(res.skipped.map((s) => [s.conversation_id, s.reason])).toEqual([["c3", expect.stringContaining("already on")]]);
    expect(res.batch_id).toMatch(/^mg-/);
  });

  test("an unknown label is an error naming the labels you have", async () => {
    const db = labeled();
    await expect(performCreateBatch({ db }, ME as any, { selector: { label: "nope" }, to_device_id: BOX }, NOW)).rejects.toThrow(/No label matching "nope"/);
  });

  test("--from and --project narrow; --all takes everything movable; selectors AND together", async () => {
    const db = labeled();
    const from = await performCreateBatch({ db }, ME as any, { selector: { from_device_id: BOX }, to_device_id: LAPTOP, dry_run: true }, NOW);
    expect(from.rows.map((r) => [r.conversation_id, r.direction])).toEqual([["c3", "to_local"]]);
    const proj = await performCreateBatch({ db }, ME as any, { selector: { project: "repo" }, to_device_id: BOX, dry_run: true }, NOW);
    expect(proj.rows.map((r) => r.conversation_id).sort()).toEqual(["c1", "c2"]);
    const both = await performCreateBatch({ db }, ME as any, { selector: { label: "rollout", project: "repo" }, to_device_id: BOX, dry_run: true }, NOW);
    expect(both.rows.map((r) => r.conversation_id)).toEqual(["c2"]);
    const all = await performCreateBatch({ db }, ME as any, { selector: { all: true }, to_device_id: BOX, dry_run: true }, NOW);
    expect(all.rows.map((r) => r.conversation_id).sort()).toEqual(["c1", "c2"]);
    const none = await performCreateBatch({ db }, ME as any, { selector: {}, to_device_id: BOX, dry_run: true }, NOW);
    expect(none.rows).toEqual([]);
  });

  test("a dry run plans and writes nothing", async () => {
    const db = labeled();
    const res = await performCreateBatch({ db }, ME as any, { conversation_ids: ["c1"], selector: { label: "rollout" }, to_device_id: BOX, dry_run: true }, NOW);
    expect(res.dry_run).toBe(true);
    expect(res.batch_id).toBeNull();
    expect(res.rows.map((r) => r.conversation_id)).toEqual(["c1", "c2"]);
    expect(db._tables.migration_batches).toEqual([]);
    expect(rowsOf(db)).toEqual([]);
    expect(commands(db)).toEqual([]);
  });

  test("matchesProject: a path prefix, a repo-name substring, or a worktree of that repo", () => {
    expect(matchesProject("/Users/me/src/platform", "/Users/me/src/platform")).toBe(true);
    expect(matchesProject("/Users/me/src/platform/apps/web", "/Users/me/src/platform")).toBe(true);
    expect(matchesProject("/Users/me/src/platformer", "/Users/me/src/platform")).toBe(false);
    expect(matchesProject("/Users/me/src/platform", "plat")).toBe(true);
    expect(matchesProject("/Users/me/src/codecast/.codecast/worktrees/cloud-1", "codecast")).toBe(true);
    expect(matchesProject("/Users/me/src/codecast/.codecast/worktrees/cloud-1", "cloud-1")).toBe(true);
    expect(matchesProject("/Users/me/src/codecast", "platform")).toBe(false);
    expect(matchesProject(undefined, "x")).toBe(false);
  });
});

async function startedBatch(db: any, ids = ["c1", "c2"], to = BOX) {
  const res = await performCreateBatch({ db }, ME as any, { conversation_ids: ids, to_device_id: to }, NOW);
  return { batchId: res.batch_id!, rows: res.rows };
}

describe("beginSession — the fence", () => {
  test("fences the conversation, claims the row, and reports the live agent status", async () => {
    const db = fixtures();
    const { batchId, rows } = await startedBatch(db);
    const r = await performBeginSession({ db }, ME as any, { migration_id: rows[0].migration_id as any, device_id: LAPTOP }, NOW + 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ session_id: "s1", direction: "to_cloud", owner_device_id: LAPTOP, agent_status: "working", to_label: "Linux box", owner_is_remote: false });
    expect(conv(db, "c1").migration).toEqual({ batch_id: batchId, migration_id: rows[0].migration_id, to_device_id: BOX, started_at: NOW + 1 });
    const row = rowsOf(db).find((x) => x._id === rows[0].migration_id);
    expect(row).toMatchObject({ status: "waiting_idle", attempt: 1, started_at: NOW + 1 });

    // Fenced: no daemon — not even the owner — may deliver into it now.
    const msg = { from_user_id: ME as any, status: "pending" };
    expect(canDaemonSeePendingMessage(msg as any, conv(db, "c1"), ME as any, LAPTOP)).toBe(false);
    // ...while an unfenced sibling still delivers to its owner.
    expect(canDaemonSeePendingMessage(msg as any, conv(db, "c2"), ME as any, LAPTOP)).toBe(true);
  });

  test("only the executor may begin a row, and only once", async () => {
    const db = fixtures();
    const { rows } = await startedBatch(db);
    const wrong = await performBeginSession({ db }, ME as any, { migration_id: rows[0].migration_id as any, device_id: LAPTOP2 }, NOW);
    expect(wrong).toEqual({ ok: false, reason: "another machine executes this row" });
    const first = await performBeginSession({ db }, ME as any, { migration_id: rows[0].migration_id as any, device_id: LAPTOP }, NOW);
    expect(first.ok).toBe(true);
    const again = await performBeginSession({ db }, ME as any, { migration_id: rows[0].migration_id as any, device_id: LAPTOP }, NOW);
    expect(again).toEqual({ ok: false, reason: "row is waiting_idle" });
  });

  test("a cancelled batch cancels the row instead of fencing", async () => {
    const db = fixtures();
    const { batchId, rows } = await startedBatch(db);
    await performCancelBatch({ db }, ME as any, batchId, NOW);
    const r = await performBeginSession({ db }, ME as any, { migration_id: rows[0].migration_id as any, device_id: LAPTOP }, NOW);
    expect(r).toEqual({ ok: false, reason: "row is cancelled" });
    expect(conv(db, "c1").migration).toBeUndefined();
  });

  test("a session that moved to the cloud on its own since planning is refused, not re-moved", async () => {
    const db = fixtures();
    const { rows } = await startedBatch(db);
    conv(db, "c1").owner_device_id = BOX;
    const r = await performBeginSession({ db }, ME as any, { migration_id: rows[0].migration_id as any, device_id: LAPTOP }, NOW);
    expect(r).toEqual({ ok: false, reason: "already on the destination" });
    expect(rowsOf(db)[0]).toMatchObject({ status: "failed", error: "already on the destination" });
    expect(conv(db, "c1").migration).toBeUndefined();
  });
});

describe("quiesce target", () => {
  test("goes to the current owner — the box for a move back, the executor for an unowned row", async () => {
    const db = fixtures({ devices: [
      { _id: "d1", user_id: ME, device_id: LAPTOP, label: "MacBook", last_seen: ONLINE },
      { _id: "d3", user_id: ME, device_id: BOX, label: "Linux box", is_remote: true, last_seen: ONLINE },
    ] });
    const back = await performCreateBatch({ db }, ME as any, { conversation_ids: ["c3"], to_device_id: LAPTOP }, NOW);
    await performBeginSession({ db }, ME as any, { migration_id: back.rows[0].migration_id as any, device_id: LAPTOP }, NOW);
    const q = await performEnqueueQuiesce({ db }, ME as any, { migration_id: back.rows[0].migration_id as any, mode: "idle" }, NOW);
    expect(q.target_device_id).toBe(BOX);
    const cmd = commands(db).find((c) => c._id === q.command_id);
    expect(cmd).toMatchObject({ command: "quiesce_session", target_device_id: BOX });
    expect(JSON.parse(cmd.args)).toMatchObject({ conversation_id: "c3", session_id: "s3", mode: "idle" });
    expect(rowsOf(db).find((r) => r._id === back.rows[0].migration_id).status).toBe("quiescing");

    conv(db, "c1").owner_device_id = undefined;
    const up = await performCreateBatch({ db }, ME as any, { conversation_ids: ["c1"], to_device_id: BOX }, NOW);
    await performBeginSession({ db }, ME as any, { migration_id: up.rows[0].migration_id as any, device_id: LAPTOP }, NOW);
    const q2 = await performEnqueueQuiesce({ db }, ME as any, { migration_id: up.rows[0].migration_id as any, mode: "force" }, NOW);
    expect(q2.target_device_id).toBe(LAPTOP);
  });
});

describe("finishSession — the flip", () => {
  test("one transaction: owner + path flip, targeted resume, release of the old owner, fence off", async () => {
    const db = fixtures();
    const { rows } = await startedBatch(db, ["c1"]);
    const id = rows[0].migration_id as any;
    await performBeginSession({ db }, ME as any, { migration_id: id, device_id: LAPTOP }, NOW);
    expect(conv(db, "c1").migration).toBeDefined();
    const before = commands(db).length;
    const fin = await performFinishSession({ db }, ME as any, {
      migration_id: id, project_path: "/home/ubuntu/work/a", git_root: "/home/ubuntu/work/a", verification: "branch x at abc, destination HEAD matches", source_path: "/Users/me/src/repo/.codecast/worktrees/a",
    }, NOW + 5);
    expect(fin.ok).toBe(true);
    const c = conv(db, "c1");
    expect(c).toMatchObject({ owner_device_id: BOX, project_path: "/home/ubuntu/work/a", git_root: "/home/ubuntu/work/a", status: "active" });
    expect(c.migration).toBeUndefined();
    const added = commands(db).slice(before);
    expect(added.map((x) => [x.command, x.target_device_id])).toEqual([["resume_session", BOX], ["release_session", LAPTOP]]);
    expect(JSON.parse(added[0].args)).toMatchObject({ session_id: "s1", conversation_id: "c1", project_path: "/home/ubuntu/work/a" });
    const row = rowsOf(db)[0];
    expect(row).toMatchObject({ status: "resuming", destination_path: "/home/ubuntu/work/a", source_path: "/Users/me/src/repo/.codecast/worktrees/a" });
    expect(fin.ok && fin.resume_command_id).toBe(added[0]._id);
    expect(row.resume_command_id).toBe(added[0]._id);
    // Unfenced and owned by the box: the box delivers, the laptop no longer does.
    const msg = { from_user_id: ME as any, status: "pending" };
    expect(canDaemonSeePendingMessage(msg as any, c, ME as any, BOX)).toBe(true);
    expect(canDaemonSeePendingMessage(msg as any, c, ME as any, LAPTOP)).toBe(false);
  });

  test("refuses a row that is not in flight", async () => {
    const db = fixtures();
    const { rows } = await startedBatch(db, ["c1"]);
    const r = await performFinishSession({ db }, ME as any, { migration_id: rows[0].migration_id as any, project_path: "/x" }, NOW);
    expect(r).toEqual({ ok: false, reason: "row is queued" });
    expect(conv(db, "c1").owner_device_id).toBe(LAPTOP);
  });
});

describe("failSession / cancel / retry", () => {
  test("a failure lifts only its own fence and leaves the session where it was", async () => {
    const db = fixtures();
    const { rows } = await startedBatch(db);
    const id = rows[0].migration_id as any;
    await performBeginSession({ db }, ME as any, { migration_id: id, device_id: LAPTOP }, NOW);
    // Someone else's fence on the same conversation must survive a stale failure.
    const foreign = { ...conv(db, "c1").migration, migration_id: "session_migrations_other" };
    conv(db, "c1").migration = foreign;
    await performFailSession({ db }, ME as any, { migration_id: id, error: "ssh: connection refused" }, NOW);
    expect(conv(db, "c1").migration).toEqual(foreign);
    conv(db, "c1").migration = { ...foreign, migration_id: id };
    const second = await performFailSession({ db }, ME as any, { migration_id: id, error: "again" }, NOW);
    expect(second).toEqual({ ok: false, status: "failed" });
    expect(conv(db, "c1").owner_device_id).toBe(LAPTOP);
    expect(rowsOf(db)[0]).toMatchObject({ status: "failed", error: "ssh: connection refused" });
  });

  test("a cancelled fail reads as cancelled, not failed", async () => {
    const db = fixtures();
    const { rows } = await startedBatch(db, ["c1"]);
    const id = rows[0].migration_id as any;
    await performBeginSession({ db }, ME as any, { migration_id: id, device_id: LAPTOP }, NOW);
    await performFailSession({ db }, ME as any, { migration_id: id, error: "cancelled before the transfer started", cancelled: true }, NOW);
    expect(rowsOf(db)[0]).toMatchObject({ status: "cancelled", stage: "cancelled before the transfer started" });
    expect(rowsOf(db)[0].error).toBeUndefined();
    expect(conv(db, "c1").migration).toBeUndefined();
  });

  test("cancel stops queued rows only; retry re-queues failed and cancelled rows and re-wakes the executor", async () => {
    const db = fixtures();
    const { batchId, rows } = await startedBatch(db);
    await performBeginSession({ db }, ME as any, { migration_id: rows[0].migration_id as any, device_id: LAPTOP }, NOW);
    const c = await performCancelBatch({ db }, ME as any, batchId, NOW);
    expect(c.cancelled).toBe(1);
    expect(rowsOf(db).map((r) => r.status)).toEqual(["waiting_idle", "cancelled"]);
    await performFailSession({ db }, ME as any, { migration_id: rows[0].migration_id as any, error: "boom" }, NOW);
    const before = commands(db).length;
    const r = await performRetryFailed({ db }, ME as any, batchId, NOW + 10);
    expect(r.requeued).toBe(2);
    expect(rowsOf(db).map((x) => x.status)).toEqual(["queued", "queued"]);
    expect(rowsOf(db)[0].error).toBeUndefined();
    expect(commands(db).slice(before).map((x) => [x.command, x.target_device_id])).toEqual([["migrate_sessions", LAPTOP]]);
    expect(db._tables.migration_batches[0].cancelled_at).toBeUndefined();
  });
});

describe("reaper", () => {
  test("an in-flight row nobody reported on for half an hour fails and its fence lifts", async () => {
    const db = fixtures();
    const { rows } = await startedBatch(db);
    const id = rows[0].migration_id as any;
    await performBeginSession({ db }, ME as any, { migration_id: id, device_id: LAPTOP }, NOW);
    expect(await performReapStale({ db }, NOW + STALE_MIGRATION_MS - 1)).toEqual({ reaped: 0 });
    expect(conv(db, "c1").migration).toBeDefined();
    expect(await performReapStale({ db }, NOW + STALE_MIGRATION_MS + 1)).toEqual({ reaped: 1 });
    expect(conv(db, "c1").migration).toBeUndefined();
    expect(rowsOf(db)[0]).toMatchObject({ status: "failed", error: expect.stringContaining("stopped reporting") });
    // The queued sibling is untouched — it never started.
    expect(rowsOf(db)[1].status).toBe("queued");
  });

  test("isStaleMigration ignores queued and terminal rows", () => {
    expect(isStaleMigration({ status: "queued", updated_at: 0 }, NOW)).toBe(false);
    expect(isStaleMigration({ status: "done", updated_at: 0 }, NOW)).toBe(false);
    expect(isStaleMigration({ status: "transferring", updated_at: NOW - STALE_MIGRATION_MS - 1 }, NOW)).toBe(true);
  });
});

describe("summarizeBatch", () => {
  const s = (statuses: string[]) => summarizeBatch(statuses.map((status) => ({ status: status as any })));
  test("states", () => {
    expect(s([]).state).toBe("empty");
    expect(s(["queued", "done"]).state).toBe("running");
    expect(s(["transferring"]).state).toBe("running");
    expect(s(["done", "done"]).state).toBe("done");
    expect(s(["done", "failed"]).state).toBe("partial");
    expect(s(["failed", "failed"]).state).toBe("failed");
    expect(s(["cancelled", "cancelled"]).state).toBe("cancelled");
    expect(s(["done", "cancelled"])).toMatchObject({ state: "partial", done: 1, cancelled: 1 });
  });
});

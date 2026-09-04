import { expect, test } from "bun:test";
import { hibernate, results } from "./sessionCommands";
import { enqueueHibernateSession, enqueueResumeSession } from "./daemonCommandUtils";
import { makeFakeDb } from "./testDb";
import { normalizeWorkStateFilter } from "./inboxFilters";
import { tallyInboxRows, computeInboxSessions, computeSessionsLiveness } from "./conversations";

function fixture() {
  const db = makeFakeDb({
    conversations: [{ _id: "conv", user_id: "owner", session_id: "session", owner_device_id: "device" }],
    managed_sessions: [{ _id: "managed", user_id: "owner", conversation_id: "conv", session_id: "session" }],
    daemon_commands: [],
  });
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "owner|login" }) } };
  const args = { request_id: "request", conversation_id: "conv", session_id: "session", owner_device_id: "device" };
  return { db, ctx, args };
}

test("hibernate is authorized, exact identity addressed, device routed and idempotent", async () => {
  const f = fixture();
  const first = await (hibernate as any)._handler(f.ctx, f.args);
  const again = await (hibernate as any)._handler(f.ctx, f.args);
  expect(again).toEqual({ command_id: first.command_id, deduplicated: true });
  expect(f.db._tables.daemon_commands).toHaveLength(1);
  expect(f.db._tables.daemon_commands[0]).toMatchObject({ user_id: "owner", target_device_id: "device", request_id: "request", command: "hibernate_session" });
  expect(JSON.parse(f.db._tables.daemon_commands[0].args)).toEqual({ session_id: "session", conversation_id: "conv" });
  for (const changed of [{ session_id: "new-session" }, { owner_device_id: "new-device" }]) {
    await expect((hibernate as any)._handler(f.ctx, { ...f.args, ...changed })).rejects.toThrow("changed");
  }
  f.db._tables.managed_sessions[0].session_id = "foreign";
  await expect((hibernate as any)._handler(f.ctx, f.args)).rejects.toThrow("identity");
});

test("a foreign viewer cannot park or read a command", async () => {
  const f = fixture();
  const queued = await (hibernate as any)._handler(f.ctx, f.args);
  f.ctx.auth.getUserIdentity = async () => ({ subject: "stranger|login" });
  await expect((hibernate as any)._handler(f.ctx, f.args)).rejects.toThrow("Not authorized");
  expect(await (results as any)._handler(f.ctx, { command_ids: [queued.command_id] })).toEqual([]);
});

test("result feed reports actual request, skipped outcome and missing identity without fabricating success", async () => {
  const f = fixture();
  await (hibernate as any)._handler(f.ctx, f.args);
  const read = () => (results as any)._handler(f.ctx, { request_ids: ["request", "missing"] });
  expect((await read())[0]).toMatchObject({ _id: "request", executed_at: null, result: null });
  Object.assign(f.db._tables.daemon_commands[0], { executed_at: 100, result: "skipped_attached", error: "not parked: attached" });
  expect((await read())[0]).toMatchObject({ executed_at: 100, result: "skipped_attached", error: "not parked: attached" });
  expect(await read()).toHaveLength(1);
});

test("wake uses exact runner session and owner device; dedup returns completion ID", async () => {
  const f = fixture();
  const first = await enqueueResumeSession(f.ctx, f.db._tables.conversations[0]);
  const next = await enqueueResumeSession(f.ctx, f.db._tables.conversations[0]);
  expect(next.command_id).toBe(first.command_id);
  expect(next.deduplicated).toBe(true);
  const command = f.db._tables.daemon_commands[0];
  expect(command.target_device_id).toBe("device");
  expect(JSON.parse(command.args)).toMatchObject({ session_id: "session", conversation_id: "conv" });
  for (const changed of [{ session_id: "new-session" }, { owner_device_id: "new-device" }]) {
    const fresh = await enqueueResumeSession(f.ctx, { ...f.db._tables.conversations[0], ...changed });
    expect(fresh.deduplicated).toBe(false);
    expect(fresh.command_id).not.toBe(first.command_id);
  }
});

test("CLI hibernated filter uses actual status, retains dormant alphabet and excludes stale stamps on active rows", () => {
  expect(normalizeWorkStateFilter("hibernated")).toBe("hibernated");
  expect(normalizeWorkStateFilter("parked")).toBe("dormant");
  const make = (id: string, status: string) => ({ _id: id, session_id: id, title: id, updated_at: Date.now(), message_count: 5, agent_status: status, hibernated_at: 1, work_state: status === "hibernated" ? "dormant" : "working", bucket: status === "hibernated" ? "dormant" : "working", is_connected: true });
  const output = tallyInboxRows([make("parked", "hibernated"), make("awake", "working")], { showAll: true, stateFilter: "hibernated", labelByConv: new Map() });
  expect(output.rows.map(r => r.id)).toEqual(["parked"]);
  expect(output.rows[0].is_live).toBe(false);
});

for (const blocked of ["question", "session_error"] as const) test(`parked ${blocked} remains actionable in real inbox and overlay projections`, async () => {
  const now = Date.now();
  const db = makeFakeDb({
    users: [{ _id: "owner", name: "Owner" }],
    conversations: [{ _id: "conv", user_id: "owner", session_id: "session", title: "Parked", status: "active", updated_at: now - 2 * 3600_000, message_count: 4, last_message_role: "assistant", ...(blocked === "session_error" ? { session_error: "Wake failed" } : {}) }],
    managed_sessions: [{ _id: "managed", user_id: "owner", conversation_id: "conv", session_id: "session", agent_status: "hibernated", hibernated_at: now - 3 * 86400_000, last_heartbeat: now - 3 * 86400_000 }],
    messages: blocked === "question" ? [{ _id: "poll", conversation_id: "conv", timestamp: now - 2 * 3600_000, role: "assistant", tool_calls: [{ name: "AskUserQuestion" }] }] : [],
  });
  const { sessions } = await computeInboxSessions({ db }, "owner" as any, { includeLiveness: true, projection: true });
  expect(sessions[0]?.work_state).toBe("needs_input");
  const { liveness } = await computeSessionsLiveness({ db }, "owner" as any);
  expect(liveness.conv?.work_state).toBe("needs_input");
  if (blocked === "question") expect(liveness.conv?.awaiting_input).toBe(true);
  expect(liveness.conv?.agent_status).toBe("hibernated");
});

for (const axis of ["owner_device_id", "session_id", "conversation_id"] as const) {
  test(`request ID remains bound after ${axis} changes, including completed commands`, async () => {
    const f = fixture();
    const first = await (hibernate as any)._handler(f.ctx, f.args);
    await f.db.patch(first.command_id, { executed_at: 100, result: "hibernated", _creationTime: 1 });
    const changed = { ...f.args, [axis]: "new-target" };
    if (axis === "conversation_id") {
      await f.db.insert("conversations", { ...f.db._tables.conversations[0], _id: changed.conversation_id });
      await f.db.insert("managed_sessions", { ...f.db._tables.managed_sessions[0], _id: "new-managed", conversation_id: changed.conversation_id });
    } else {
      await f.db.patch("conv", { [axis]: changed[axis] });
      if (axis === "session_id") await f.db.patch("managed", { session_id: changed.session_id });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect((hibernate as any)._handler(f.ctx, changed)).rejects.toThrow("already bound");
      expect(f.db._tables.daemon_commands).toHaveLength(1);
    }
    expect((await (results as any)._handler(f.ctx, { request_ids: [f.args.request_id] }))[0])
      .toMatchObject({ command_id: first.command_id, executed_at: 100, result: "hibernated" });
  });
}

test("same-target retries preserve the original completed result without an age limit", async () => {
  const f = fixture();
  const first = await (hibernate as any)._handler(f.ctx, f.args);
  await f.db.patch(first.command_id, { executed_at: 100, result: "skipped_attached", error: "not parked: attached", _creationTime: 1 });
  for (let attempt = 0; attempt < 5; attempt++) {
    expect(await (hibernate as any)._handler(f.ctx, f.args)).toEqual({ ...first, deduplicated: true });
  }
  expect(f.db._tables.daemon_commands).toHaveLength(1);
  expect((await (results as any)._handler(f.ctx, { request_ids: [f.args.request_id] }))[0])
    .toMatchObject({ command_id: first.command_id, executed_at: 100, result: "skipped_attached", error: "not parked: attached" });
});

test("concurrent same-target handler calls converge when conflicting transactions retry", async () => {
  const f = fixture();
  let revision = 0;
  let conflicts = 0;
  const mutate = async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const started = revision;
      const db = makeFakeDb(structuredClone(f.db._tables));
      const result = await (hibernate as any)._handler({ ...f.ctx, db }, f.args);
      if (started !== revision) { conflicts++; continue; }
      Object.assign(f.db._tables, db._tables);
      revision++;
      return result;
    }
    throw new Error("Transaction retry limit exceeded");
  };
  const returned = await Promise.all(Array.from({ length: 6 }, mutate));
  expect(conflicts).toBeGreaterThan(0);
  expect(returned.filter(r => !r.deduplicated)).toHaveLength(1);
  expect(new Set(returned.map(r => r.command_id)).size).toBe(1);
  expect(f.db._tables.daemon_commands).toHaveLength(1);
});

test("request IDs are scoped to the runner and cannot be rebound to another command kind", async () => {
  const f = fixture();
  const first = await (hibernate as any)._handler(f.ctx, f.args);
  await f.db.patch(first.command_id, { command: "resume_session" });
  await expect((hibernate as any)._handler(f.ctx, f.args)).rejects.toThrow("already bound");
  expect(f.db._tables.daemon_commands).toHaveLength(1);
  await f.db.patch("conv", { user_id: "other" });
  await f.db.patch("managed", { user_id: "other" });
  f.ctx.auth.getUserIdentity = async () => ({ subject: "other|login" });
  const next = await (hibernate as any)._handler(f.ctx, f.args);
  expect(next.command_id).not.toBe(first.command_id);
  expect((await (results as any)._handler(f.ctx, { request_ids: [f.args.request_id] }))[0].command_id).toBe(next.command_id);
});

for (const duplicateKind of ["hibernate_session", "resume_session", "kill_session"]) {
  test(`ambiguous legacy request rows fail closed even with a ${duplicateKind} duplicate`, async () => {
    const f = fixture();
    const first = await (hibernate as any)._handler(f.ctx, f.args);
    await f.db.patch(first.command_id, { executed_at: 100, result: "hibernated" });
    await f.db.insert("daemon_commands", { ...f.db._tables.daemon_commands[0], _id: "duplicate", command: duplicateKind, executed_at: undefined });
    await expect((hibernate as any)._handler(f.ctx, f.args)).rejects.toThrow("more than one");
    await expect((results as any)._handler(f.ctx, { request_ids: [f.args.request_id] })).rejects.toThrow("more than one");
    await expect((results as any)._handler(f.ctx, { command_ids: [first.command_id] })).rejects.toThrow("more than one");
    expect(f.db._tables.daemon_commands).toHaveLength(2);
  });
}

for (const requestId of ["", " ", "request ", " request", "request\n", "a,b", "é", "x".repeat(129), null, 123, {}]) {
  test(`invalid request ID ${JSON.stringify(requestId)} cannot create or alias a command`, async () => {
    const f = fixture();
    await (hibernate as any)._handler(f.ctx, f.args);
    await expect((hibernate as any)._handler(f.ctx, { ...f.args, request_id: requestId })).rejects.toThrow("Invalid request ID");
    await expect(enqueueHibernateSession(f.ctx, f.db._tables.conversations[0], requestId as any)).rejects.toThrow("Invalid request ID");
    await expect((results as any)._handler(f.ctx, { request_ids: [requestId] })).rejects.toThrow("Invalid request ID");
    expect(f.db._tables.daemon_commands).toHaveLength(1);
  });
}

test("public hibernate requires an ID while valid boundary tokens retain exact identity", async () => {
  const f = fixture();
  await expect((hibernate as any)._handler(f.ctx, { ...f.args, request_id: undefined })).rejects.toThrow("Invalid request ID");
  for (const requestId of ["x", "X_-0123456789".padEnd(128, "x")]) {
    const args = { ...f.args, request_id: requestId };
    const first = await (hibernate as any)._handler(f.ctx, args);
    expect(await (hibernate as any)._handler(f.ctx, args)).toEqual({ ...first, deduplicated: true });
  }
  expect(f.db._tables.daemon_commands).toHaveLength(2);
});

test("an invalid legacy request ID fails closed even when read by command ID", async () => {
  const f = fixture();
  const first = await (hibernate as any)._handler(f.ctx, f.args);
  await f.db.patch(first.command_id, { request_id: "", executed_at: 100, result: "hibernated" });
  await expect((results as any)._handler(f.ctx, { command_ids: [first.command_id] })).rejects.toThrow("Invalid request ID");
});

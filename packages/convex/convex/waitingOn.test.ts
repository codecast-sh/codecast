// conversations.waiting_on (`cast state --status dormant --on <ref>`,
// lib/waitingOn.ts): the pin writes it, a pin without --on clears it, and each
// kind arms a wake the inbox counts and that reaches the session.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { prWakeFailed } from "./lib/waitingOn";
import { loadPendingDecisionConvIds } from "./conversations";

setDefaultTimeout(30_000);

const api = anyApi as any;
const internal = anyApi as any;
const TOKEN = "w".repeat(64);
const ASHOT_TOKEN = "a".repeat(64);
const REPO = "codecast-sh/codecast";

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const person = async (name: string) => {
      const user = await ctx.db.insert("users", { name } as any);
      const team = await ctx.db.insert("teams", { name: `${name}'s team`, created_at: 0, invite_code: name } as any);
      await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "admin", joined_at: 0 } as any);
      return { user, team };
    };
    const ana = await person("Ana");
    const bob = await person("Bob");
    await ctx.db.insert("api_tokens", { user_id: ana.user, token_hash: await hashToken(TOKEN), name: "cli", created_at: 0, last_used_at: 0 } as any);
    // Ashot is on Ana's team: the person a session can wait on.
    const ashot = await ctx.db.insert("users", { name: "Ashot", email: "ashot@example.com" } as any);
    await ctx.db.insert("team_memberships", { user_id: ashot, team_id: ana.team, role: "member", joined_at: 0 } as any);
    await ctx.db.insert("api_tokens", { user_id: ashot, token_hash: await hashToken(ASHOT_TOKEN), name: "cli", created_at: 0, last_used_at: 0 } as any);
    const conv = async (who: { user: any; team: any }, short_id: string, status: string | null, extra: Record<string, unknown> = {}) => {
      const id = await ctx.db.insert("conversations", { user_id: who.user, team_id: who.team, agent_type: "claude_code", session_id: `${short_id}-${who.user}`, title: `Session ${short_id}`, short_id, started_at: now, updated_at: now, message_count: 3, status: "active", is_private: false, project_path: "/repo", ...extra } as any);
      if (status) await ctx.db.insert("managed_sessions", { session_id: `${short_id}-${who.user}`, user_id: who.user, pid: 1, started_at: now, last_heartbeat: now, agent_status: status, agent_status_updated_at: 10, conversation_id: id } as any);
      return id;
    };
    const lead = await conv(ana, "jxlead1", "working");
    const builder = await conv(ana, "jxbuild", "working");
    const worker = await conv(ana, "jxwork1", "working", { is_subagent: true, parent_conversation_id: lead });
    const finished = await conv(ana, "jxdone1", "idle", { thread_state: "Shipped", thread_state_status: "done", thread_state_at: now, thread_state_msg_count: 3 });
    const killed = await conv(ana, "jxkill1", "working", { inbox_killed_at: now });
    // Bob's session shares the builder's short id: short ids collide across workspaces.
    const bobsTwin = await conv(bob, "jxbuild", "working", { title: "Bob's private work", thread_state: "Bob's secret plan", thread_state_status: "done" });
    const bobsOwn = await conv(bob, "jxbob01", "working");
    const task = (who: { user: any; team: any }, short_id: string, status: string) =>
      ctx.db.insert("tasks", { user_id: who.user, team_id: who.team, workspace: `team:${who.team}`, title: `Task ${short_id}`, short_id, status, priority: "medium", source: "human", created_at: 0, updated_at: 0 } as any);
    await task(ana, "ct-7", "in_progress");
    await task(ana, "ct-9", "done");
    await task(bob, "ct-50", "in_progress");
    return { ana, bob, ashot, lead, builder, worker, finished, killed, bobsTwin, bobsOwn };
  });
  const pin = (text: string, status = "dormant", on?: string, session = "jxlead1") =>
    t.mutation(api.conversations.setThreadState, { api_token: TOKEN, session, text, status, ...(on !== undefined ? { on } : {}) });
  const row = (id: any) => t.run(async (ctx) => (await ctx.db.get(id)) as any);
  const wakes = async (conv: any) =>
    (await t.run(async (ctx) => (await ctx.db.query("pending_messages").collect()).filter((m) => String(m.conversation_id) === String(conv)))).map((m) => m.content as string);
  const triggers = (conv: any) =>
    t.run(async (ctx) => (await ctx.db.query("agent_tasks").withIndex("by_originating_conversation", (q) => q.eq("originating_conversation_id", conv)).collect()) as any[]);
  /** The daemon's settle report, through the real status mutation. */
  const settle = (conv: any, agent_status: string, client_ts: number) =>
    t.mutation(api.managedSessions.updateAgentStatus, { api_token: TOKEN, conversation_id: conv, agent_status, client_ts });
  /** Run the scheduled functions named `module:fn` not run yet, as the scheduler would. */
  const ran = new Set<string>();
  const runScheduled = async (name: string) => {
    const due = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f: any) => f.name === name && !ran.has(String(f._id))));
    const [mod, fn] = name.split(":");
    for (const f of due) {
      ran.add(String(f._id));
      await t.mutation(internal[mod][fn], f.args[0]);
    }
    return due.length;
  };
  return { t, ids, pin, row, wakes, triggers, settle, runScheduled };
}

describe("cast state --on: the write", () => {
  test("a dormant pin stores what it waits on; a pin without --on clears it", async () => {
    const s = await setup();
    const res = await s.pin("Waiting on the builder", "dormant", "ct-7");
    expect(res.waiting_on).toEqual({ kind: "task", ref: "ct-7" });
    expect((await s.row(s.ids.lead)).waiting_on).toMatchObject({ kind: "task", ref: "ct-7" });
    await s.pin("Back on it", "working");
    expect((await s.row(s.ids.lead)).waiting_on).toBeUndefined();
    await s.t.mutation(api.conversations.setThreadState, { api_token: TOKEN, session: "jxlead1", text: "Waiting on Ashot", status: "dormant", on: "@ashot", ask: "Which region?" });
    expect((await s.row(s.ids.lead)).waiting_on).toEqual({ kind: "person", ref: "@ashot", decision_id: expect.any(String), at: expect.any(Number) });
    await s.t.mutation(api.conversations.setThreadState, { api_token: TOKEN, session: "jxlead1", text: "" });
    expect((await s.row(s.ids.lead)).waiting_on).toBeUndefined();
  });

  test("a session wait is keyed on the conversation id, with its short id as the label", async () => {
    const s = await setup();
    await s.pin("Waiting on the builder", "dormant", "jxbuild");
    expect((await s.row(s.ids.lead)).waiting_on).toEqual({ kind: "session", ref: String(s.ids.builder), label: "jxbuild", at: expect.any(Number) });
  });

  test("the same wait again keeps when it began", async () => {
    const s = await setup();
    await s.pin("Waiting", "dormant", "ct-7");
    const at = (await s.row(s.ids.lead)).waiting_on.at;
    await s.pin("Still waiting", "dormant", "ct-7");
    expect((await s.row(s.ids.lead)).waiting_on.at).toBe(at);
  });

  test("refused before anything is written: another status, a closed or missing task, another workspace's session or task, a settled or killed session, a bare PR, itself", async () => {
    const s = await setup();
    await s.pin("Before", "working");
    for (const [status, on, says] of [
      ["working", "ct-7", "--status dormant"],
      ["dormant", "ct-9", "already done"],
      ["dormant", "ct-404", "No task"],
      ["dormant", "ct-50", "No task"],
      ["dormant", "jxnobody", "No session"],
      ["dormant", "jxbob01", "No session"],
      ["dormant", "jxdone1", "jxdone1 has already settled (ended its turn)"],
      ["dormant", "jxdone1", "cast read jxdone1"],
      ["dormant", "jxkill1", "has already settled (has stopped)"],
      ["dormant", "#42", "owner/repo#42"],
      ["dormant", "jxlead1", "itself"],
    ] as const) {
      await expect(s.pin("After", status, on)).rejects.toThrow(says);
    }
    const lead = await s.row(s.ids.lead);
    expect(lead.thread_state).toBe("Before");
    expect(lead.waiting_on).toBeUndefined();
  });

  test("the inbox row and cast sessions carry it", async () => {
    const s = await setup();
    await s.pin("Waiting on the builder", "dormant", "jxbuild");
    const cli = await s.t.query(api.conversations.inboxForCLI, { api_token: TOKEN, show_all: true });
    const lead = (cli.sessions as any[]).find((r) => String(r.id) === String(s.ids.lead));
    expect(lead?.waiting_on).toMatchObject({ kind: "session", ref: String(s.ids.builder), label: "jxbuild" });
  });
});

describe("cast state --on: the wake", () => {
  test("a task: a verified wait while it is open; its close wakes the session and clears the wait", async () => {
    const s = await setup();
    await s.pin("Waiting on ct-7", "dormant", "ct-7");
    expect((await s.row(s.ids.lead)).parked_wake_kind).toBe("wait");
    await s.t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-7", status: "done" });
    const [wake] = await s.wakes(s.ids.lead);
    expect(wake).toContain("ct-7");
    expect(wake).toContain("closed as done");
    const lead = await s.row(s.ids.lead);
    expect(lead.waiting_on).toBeUndefined();
    expect(lead.parked_wake_kind).toBe("none");
  });

  test("a session: its settle, through the daemon's status report, tells the waiter once, and not while it is on its own work", async () => {
    const s = await setup();
    await s.pin("Waiting on the builder", "dormant", "jxbuild");
    expect((await s.row(s.ids.lead)).parked_wake_kind).toBe("wait");
    // Dormant on a wake of its own: nothing to tell yet.
    await s.settle(s.ids.builder, "dormant", 20);
    expect(await s.runScheduled("waitingOn:tellSessionWaiters")).toBe(1);
    expect(await s.wakes(s.ids.lead)).toEqual([]);
    await s.t.run((ctx) => ctx.db.patch(s.ids.builder, { thread_state: "Branch ready", thread_state_status: "done", thread_state_at: Date.now(), thread_state_msg_count: 3 } as any));
    await s.settle(s.ids.builder, "idle", 30);
    expect(await s.runScheduled("waitingOn:tellSessionWaiters")).toBe(1);
    const wakes = await s.wakes(s.ids.lead);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("Session jxbuild");
    expect(wakes[0]).toContain("Branch ready");
    expect(wakes[0]).toContain("cast read jxbuild");
    const lead = await s.row(s.ids.lead);
    expect(lead.waiting_on).toBeUndefined();
    expect(lead.parked_wake_kind).toBe("none");
    // Told once: the wait is gone, so the next settle schedules nothing.
    await s.settle(s.ids.builder, "working", 40);
    await s.settle(s.ids.builder, "idle", 50);
    expect(await s.runScheduled("waitingOn:tellSessionWaiters")).toBe(0);
    expect(await s.wakes(s.ids.lead)).toHaveLength(1);
  });

  test("a short id another workspace shares wakes nobody, and leaks nothing", async () => {
    const s = await setup();
    await s.pin("Waiting on the builder", "dormant", "jxbuild");
    // Bob's jxbuild settles: Ana's wait is on her own jxbuild's id, so nothing is scheduled or told.
    await s.t.run((ctx) => ctx.db.patch(s.ids.bobsTwin, { message_count: 4 } as any));
    expect(await s.t.mutation(internal.waitingOn.tellSessionWaiters, { conversation_id: s.ids.bobsTwin })).toEqual({ told: 0 });
    expect(await s.wakes(s.ids.lead)).toEqual([]);
    expect((await s.row(s.ids.lead)).waiting_on?.ref).toBe(String(s.ids.builder));
    expect((await s.row(s.ids.lead)).parked_wake_kind).toBe("wait");
    // Ana's own builder settling is what wakes her, with its own words.
    await s.settle(s.ids.builder, "idle", 30);
    await s.runScheduled("waitingOn:tellSessionWaiters");
    const wakes = await s.wakes(s.ids.lead);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).not.toContain("Bob");
  });

  test("a lead waiting on its own worker hears exactly one message: the worker's report", async () => {
    const s = await setup();
    await s.pin("Waiting on my worker", "dormant", "jxwork1");
    await s.t.run((ctx) => ctx.db.patch(s.ids.worker, { thread_state: "Fixed it", thread_state_status: "done", thread_state_at: Date.now(), thread_state_msg_count: 3 } as any));
    await s.settle(s.ids.worker, "idle", 30);
    expect(await s.runScheduled("workerSettle:tellParent")).toBe(1);
    expect(await s.runScheduled("waitingOn:tellSessionWaiters")).toBe(1);
    const wakes = await s.wakes(s.ids.lead);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("worker-report");
    expect((await s.row(s.ids.lead)).waiting_on).toBeUndefined();
  });

  test("a target killed through the kill path tells the waiter it stopped, and the waiter's wake is recomputed", async () => {
    const s = await setup();
    await s.pin("Waiting on the builder", "dormant", "jxbuild");
    expect((await s.row(s.ids.lead)).parked_wake_kind).toBe("wait");
    await s.t.mutation(api.conversations.cliSetSessionVisibility, { api_token: TOKEN, session: "jxbuild", action: "kill" });
    expect(await s.runScheduled("waitingOn:tellSessionWaiters")).toBeGreaterThan(0);
    const wakes = await s.wakes(s.ids.lead);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("Session jxbuild");
    expect(wakes[0]).toContain("has stopped");
    const lead = await s.row(s.ids.lead);
    expect(lead.waiting_on).toBeUndefined();
    expect(lead.parked_wake_kind).toBe("none");
  });

  test("a settled target with a message queued for it is not settled: the pin is accepted, and its next settle tells", async () => {
    const s = await setup();
    await s.settle(s.ids.builder, "idle", 20);
    await expect(s.pin("Waiting on the builder", "dormant", "jxbuild")).rejects.toThrow("has already settled");
    // `cast send jxbuild "do X"`: the message waits for the idle builder.
    await s.t.mutation(api.pendingMessages.sendMessageToSession, { api_token: TOKEN, conversation_id: s.ids.builder, content: "do X" });
    await s.pin("Waiting on the builder", "dormant", "jxbuild");
    const lead = await s.row(s.ids.lead);
    expect(lead.waiting_on).toMatchObject({ kind: "session", ref: String(s.ids.builder) });
    expect(lead.parked_wake_kind).toBe("wait");
    // The settle that was already scheduled finds the work unread and tells nobody.
    await s.runScheduled("waitingOn:tellSessionWaiters");
    expect(await s.wakes(s.ids.lead)).toEqual([]);
  });

  test("a PR the server has seen merged or closed is refused; one it has not seen is accepted", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      for (const [number, state] of [[42, "merged"], [43, "closed"], [44, "open"]] as const) {
        await ctx.db.insert("pull_requests", { team_id: s.ids.ana.team, repository: REPO, number, state, title: `PR ${number}` } as any);
      }
      // Another team's merged #45 is not Ana's to know about.
      await ctx.db.insert("pull_requests", { team_id: s.ids.bob.team, repository: REPO, number: 45, state: "merged", title: "PR 45" } as any);
    });
    await expect(s.pin("Waiting", "dormant", `${REPO}#42`)).rejects.toThrow(`${REPO}#42 is already merged`);
    await expect(s.pin("Waiting", "dormant", `${REPO}#43`)).rejects.toThrow(`${REPO}#43 is already closed`);
    for (const n of [44, 45, 99]) {
      await s.pin("Waiting", "dormant", `${REPO}#${n}`);
      expect((await s.row(s.ids.lead)).waiting_on).toMatchObject({ kind: "pr", ref: `${REPO}#${n}` });
    }
  });

  test("a co-owner's pin may name only what the session's runner can read", async () => {
    const s = await setup();
    // Bob co-owns Ana's lead and pins it waiting on his own session: Ana cannot read it, so it is refused.
    const BOB_TOKEN = "b".repeat(64);
    await s.t.run(async (ctx) => {
      await ctx.db.insert("api_tokens", { user_id: s.ids.bob.user, token_hash: await hashToken(BOB_TOKEN), name: "cli", created_at: 0, last_used_at: 0 } as any);
      await ctx.db.patch(s.ids.lead, { owner_user_id: s.ids.bob.user } as any);
    });
    await expect(s.t.mutation(api.conversations.setThreadState, { api_token: BOB_TOKEN, session: "jxlead1", text: "Waiting", status: "dormant", on: "jxbob01" })).rejects.toThrow("No session you can see");
    expect((await s.row(s.ids.lead)).waiting_on).toBeUndefined();
  });

  test("clearing the pin from the web takes the wait and its wake with it", async () => {
    const s = await setup();
    await s.pin("Waiting on #42", "dormant", `${REPO}#42`);
    await s.runScheduled("waitingOn:armPrWake");
    // ThreadStatePanel's clear: the store's patchConversation on the dispatch rail.
    const cleared = { thread_state: null, thread_state_at: null, thread_state_msg_count: null, thread_state_status: null };
    await s.t.withIdentity({ subject: `${s.ids.ana.user}|test` }).mutation(api.dispatch.dispatch, {
      action: "patchConversation",
      args: [String(s.ids.lead), cleared],
      patches: { conversations: { [String(s.ids.lead)]: cleared } },
    });
    expect((await s.row(s.ids.lead)).thread_state).toBeUndefined();
    expect((await s.row(s.ids.lead)).waiting_on).toBeUndefined();
    expect((await s.triggers(s.ids.lead)).map((t) => t.status)).toEqual(["completed", "completed"]);
  });

  test("a PR: event triggers into the session for its merge and its close; pr_merged fires the merge one into the session; cancelled when the wait clears", async () => {
    const s = await setup();
    await s.pin("Waiting on #42", "dormant", `${REPO}#42`);
    expect(await s.runScheduled("waitingOn:armPrWake")).toBe(1);
    const armed = await s.triggers(s.ids.lead);
    expect(armed.map((t) => [t.event_filter.event_type, t.event_filter.repository, t.event_filter.pr_number, t.status])).toEqual([
      ["pr_merged", REPO, 42, "scheduled"],
      ["pr_closed", REPO, 42, "scheduled"],
    ]);
    expect(armed.every((t) => t.schedule_type === "event" && String(t.originating_conversation_id) === String(s.ids.lead))).toBe(true);
    expect((await s.row(s.ids.lead)).armed_trigger_kind).toBe("standing");
    // Arming again does not double them.
    await s.t.mutation(internal.waitingOn.armPrWake, { conversation_id: s.ids.lead });
    expect((await s.triggers(s.ids.lead)).length).toBe(2);

    // Another PR merging fires nothing; #42 merging makes the merge trigger due, and only it.
    await s.t.mutation(internal.agentTasks.matchTaskTriggers, { event_type: "pr_merged", repository: REPO, pr_number: 43, team_id: s.ids.ana.team });
    expect((await s.triggers(s.ids.lead)).every((t) => t.run_at === undefined)).toBe(true);
    const before = Date.now();
    await s.t.mutation(internal.agentTasks.matchTaskTriggers, { event_type: "pr_merged", repository: REPO, pr_number: 42, team_id: s.ids.ana.team });
    const [merged, closed] = await s.triggers(s.ids.lead);
    expect(merged.run_at).toBeGreaterThanOrEqual(before);
    expect(merged.prompt).toContain("merged, which this session waited on");
    expect(closed.run_at).toBeUndefined();

    await s.pin("Merged, deploying", "working");
    expect((await s.triggers(s.ids.lead)).map((t) => t.status)).toEqual(["completed", "completed"]);
    expect((await s.row(s.ids.lead)).armed_trigger_kind).toBe("none");
  });

  test("a PR wait that moved on before arming arms nothing", async () => {
    const s = await setup();
    await s.pin("Waiting on #42", "dormant", `${REPO}#42`);
    await s.pin("Never mind", "working");
    await s.runScheduled("waitingOn:armPrWake");
    expect(await s.triggers(s.ids.lead)).toEqual([]);
  });

  test("an arm that fails takes back the triggers and the wait, and tells the session", async () => {
    const s = await setup();
    await s.pin("Waiting on #42", "dormant", `${REPO}#42`);
    await s.runScheduled("waitingOn:armPrWake");
    await s.t.run(async (ctx) => prWakeFailed(ctx as any, (await ctx.db.get(s.ids.lead)) as any, `${REPO}#42`, "a routine limit"));
    expect((await s.triggers(s.ids.lead)).map((t) => t.status)).toEqual(["completed", "completed"]);
    expect((await s.row(s.ids.lead)).waiting_on).toBeUndefined();
    const [wake] = await s.wakes(s.ids.lead);
    expect(wake).toContain("could not be armed (a routine limit)");
    expect(wake).toContain(`--on pr_merged --pr 42 --repo ${REPO}`);
  });
});

describe("cast state --on @person: the card is the wait", () => {
  type S = Awaited<ReturnType<typeof setup>>;
  const OPTIONS = [{ label: "US" }, { label: "EU", description: "closer to the customer" }];
  const askAshot = (s: S, extra: Record<string, unknown> = { options: OPTIONS }) =>
    s.t.mutation(api.conversations.setThreadState, { api_token: TOKEN, session: "jxlead1", text: "Waiting on Ashot's region call", status: "dormant", on: "@ashot", ask: "Which region do we launch in?", ...extra });
  const cards = (s: S) =>
    s.t.run(async (ctx) => (await ctx.db.query("session_decisions").collect()).filter((d: any) => String(d.conversation_id) === String(s.ids.lead)) as any[]);
  const answer = (s: S, token: string, card: any, answer_index: number) =>
    s.t.mutation(api.sessionDecisions.answer, { api_token: token, decision_id: card.short_id, answer_index });
  /** Whether the row asks Ana: the overlay that files it under Needs you (placement's `asking`). */
  const asksAna = (s: S) => s.t.run(async (ctx) => (await loadPendingDecisionConvIds(ctx, s.ids.ana.user)).has(String(s.ids.lead)));
  const ESCALATE = "waitingOn:escalatePersonWait";

  test("--on @person without --ask is refused before anything is written", async () => {
    const s = await setup();
    await s.pin("Before", "working");
    await expect(s.pin("Waiting on Ashot", "dormant", "@ashot")).rejects.toThrow('add --ask "<question>"');
    await expect(s.t.mutation(api.conversations.setThreadState, { api_token: TOKEN, session: "jxlead1", text: "x", status: "dormant", on: "ct-7", ask: "Q?" })).rejects.toThrow("--ask goes with a wait on a person");
    await expect(askAshot(s, { on: "@nobody", options: OPTIONS })).rejects.toThrow("--on @nobody: no person by that name");
    expect((await s.row(s.ids.lead)).thread_state).toBe("Before");
    expect(await cards(s)).toEqual([]);
  });

  test("the card goes to that person alone, with the options, and the row sleeps on it", async () => {
    const s = await setup();
    const res = await askAshot(s);
    const [card] = await cards(s);
    expect(card).toMatchObject({ status: "pending", question: "Which region do we launch in?", options: OPTIONS, asked_user_ids: [s.ids.ashot], addressed: true, blocking: true });
    expect(res.asked).toEqual({ short_id: card.short_id, person: "@ashot" });
    const lead = await s.row(s.ids.lead);
    expect(lead.waiting_on).toMatchObject({ kind: "person", ref: "@ashot", decision_id: card._id });
    expect(lead.parked_wake_kind).toBe("wait");
    // Not Ana's question: her inbox keeps the row in Sleeping, not Needs you.
    expect(await asksAna(s)).toBe(false);
  });

  test("with no options it asks for a free answer", async () => {
    const s = await setup();
    await askAshot(s, {});
    const [card] = await cards(s);
    expect(card.kind).toBe("form");
    expect(card.form.fields).toEqual([{ key: "answer", label: "Your answer", type: "text" }]);
  });

  test("the answer is the wake: it reaches the session, clears the wait, and the day's check does nothing", async () => {
    const s = await setup();
    await askAshot(s);
    const [card] = await cards(s);
    await answer(s, ASHOT_TOKEN, card, 1);
    const wakes = await s.wakes(s.ids.lead);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("EU");
    const lead = await s.row(s.ids.lead);
    expect(lead.waiting_on).toBeUndefined();
    expect(lead.parked_wake_kind).toBe("none");
    expect(await s.runScheduled(ESCALATE)).toBe(1);
    expect(await cards(s)).toHaveLength(1);
  });

  test("a day unanswered: a card reaches the session's own person and files the row under Needs you; the person's answer takes it back", async () => {
    const s = await setup();
    await askAshot(s);
    expect(await s.runScheduled(ESCALATE)).toBe(1);
    const [card, escalation] = await cards(s);
    expect(escalation).toMatchObject({ status: "pending", asked_user_ids: [s.ids.ana.user], silent: true, blocking: true });
    expect(escalation.question).toBe(`@ashot hasn't answered "Which region do we launch in?" for a day`);
    expect(escalation.options.map((o: any) => o.label)).toEqual(["Nudge @ashot", "Answer it yourself", "Drop the wait"]);
    expect((await s.row(s.ids.lead)).waiting_on.escalation_id).toBe(escalation._id);
    expect(await asksAna(s)).toBe(true);

    await answer(s, ASHOT_TOKEN, card, 0);
    expect((await s.row(s.ids.lead)).waiting_on).toBeUndefined();
    expect((await cards(s)).find((d) => d._id === escalation._id)?.status).toBe("withdrawn");
    expect(await asksAna(s)).toBe(false);
  });

  test("nudge raises the card again and starts a new day, waking nothing", async () => {
    const s = await setup();
    await askAshot(s);
    await s.runScheduled(ESCALATE);
    const [card, escalation] = await cards(s);
    await answer(s, TOKEN, escalation, 0);
    const raised = (await cards(s)).find((d) => d._id === card._id);
    expect(raised.status).toBe("pending");
    expect(raised.created_at).toBeGreaterThanOrEqual(card.created_at);
    const w = (await s.row(s.ids.lead)).waiting_on;
    expect(w.decision_id).toBe(card._id);
    expect(w.escalation_id).toBeUndefined();
    expect(await s.wakes(s.ids.lead)).toEqual([]);
    // The new day: another unanswered day asks again.
    expect(await s.runScheduled(ESCALATE)).toBe(1);
    expect((await cards(s)).filter((d) => d.question.includes("hasn't answered") && d.status === "pending")).toHaveLength(1);
  });

  test("answer it yourself puts the question in the session's person's queue, and their answer wakes it", async () => {
    const s = await setup();
    await askAshot(s);
    await s.runScheduled(ESCALATE);
    const [card, escalation] = await cards(s);
    await answer(s, TOKEN, escalation, 1);
    expect((await cards(s)).find((d) => d._id === card._id).asked_user_ids.map(String).sort()).toEqual([String(s.ids.ana.user), String(s.ids.ashot)].sort());
    expect(await s.wakes(s.ids.lead)).toEqual([]);
    await answer(s, TOKEN, card, 0);
    expect((await s.wakes(s.ids.lead))[0]).toContain("US");
    expect((await s.row(s.ids.lead)).waiting_on).toBeUndefined();
  });

  test("drop the wait takes the card back and wakes the session without an answer", async () => {
    const s = await setup();
    await askAshot(s);
    await s.runScheduled(ESCALATE);
    const [card, escalation] = await cards(s);
    await answer(s, TOKEN, escalation, 2);
    expect((await cards(s)).find((d) => d._id === card._id).status).toBe("withdrawn");
    expect((await s.row(s.ids.lead)).waiting_on).toBeUndefined();
    const wakes = await s.wakes(s.ids.lead);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("Ana dropped your wait on @ashot");
  });

  test("a wait that moved on takes back the card and cancels its day", async () => {
    const s = await setup();
    await askAshot(s);
    await s.pin("Doing something else", "working");
    expect(await s.runScheduled(ESCALATE)).toBe(1);
    const [card] = await cards(s);
    expect(card.status).toBe("withdrawn");
    expect(await cards(s)).toHaveLength(1);
    expect(await s.wakes(s.ids.lead)).toEqual([]);
  });

  test("the same person and question again keeps the card and its day; a new question replaces both cards", async () => {
    const s = await setup();
    await askAshot(s);
    const [card] = await cards(s);
    await askAshot(s);
    expect(await cards(s)).toHaveLength(1);
    expect((await cards(s))[0]).toMatchObject({ _id: card._id, status: "pending", created_at: card.created_at });
    expect((await s.row(s.ids.lead)).waiting_on.decision_id).toBe(card._id);
    // One day, from the first ask: the re-pin armed nothing new that would escalate twice.
    expect(await s.runScheduled(ESCALATE)).toBe(1);
    const escalation = (await cards(s)).find((d) => d.question.includes("hasn't answered"));
    expect(escalation.status).toBe("pending");

    await askAshot(s, { options: OPTIONS, ask: "Which region now?" });
    const after = await cards(s);
    expect(after.find((d) => d._id === card._id).status).toBe("withdrawn");
    expect(after.find((d) => d._id === escalation._id).status).toBe("withdrawn");
    const fresh = after.find((d) => d.question === "Which region now?");
    expect(fresh.status).toBe("pending");
    const w = (await s.row(s.ids.lead)).waiting_on;
    expect(w.decision_id).toBe(fresh._id);
    expect(w.escalation_id).toBeUndefined();
  });
});

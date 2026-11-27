// Priority change cards end to end (plan pl-1131): a pass run with the
// person's priority_cards experiment on writes only its direct part and posts
// one card; answering the card writes what was ticked. With the experiment off
// a run writes everything, as it always has. Synthetic data only.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { PriorityCard } from "@codecast/shared/contracts/priorityCard";
import { effectivePriorityOrder } from "@codecast/shared/contracts/priorities";
import type { MergePlan, PriorityPassInput } from "./lib/priorityPass";
import { PRIORITY_PASS_SCHEMA, PRIORITY_PASS_SCHEMA_WHY, PRIORITY_PASS_SYSTEM, priorityPassRequest } from "./lib/priorityPass";
import { finalizeAnswer, reroutePendingDecisionsForConversation, settleClientResolution, withdrawCore } from "./sessionDecisions";
import { isStackedAsk, liftsAskingSession } from "@codecast/shared/contracts";
import { PRIORITY_CARD_HANDOFF_REFUSED, PRIORITY_CARD_REFUSED } from "./lib/priorityCardAccess";
import { escalateCore, passCore } from "./decisionHandoff";
import { addToStackCore, createStackCore } from "./decisionStacks";
import { hashToken } from "./apiTokens";
import { userMayRead } from "./lib/decisionAccess";
import { api } from "./_generated/api";
import { loadPendingDecisionConvIds } from "./conversations";
import { ringsPhone } from "./lib/decisionRing";
import { DAY, H, pass, stubModel, world } from "./priorityPassRun.testkit";
import type { Doc, Id } from "./_generated/dataModel";

setDefaultTimeout(60_000);
const model = stubModel();

type World = Awaited<ReturnType<typeof world>>;
const TYPED = "get grader faults under five percent, then calibrate the grader";

const create = (now: number, ref: string, title: string, ai_rank: number, steps: MergePlan["creates"][number]["steps"] = []) =>
  ({ ref, first_seen_at: now, title, summary: "", status: "active" as const, ai_rank, serves: null, steps, last_active_at: now - H, done_at: null, pass_at: now });

/** Seeds Ana's priorities in Acme with one ok run five hours ago, so the next run reads the last few hours. */
async function seed(w: World, creates: MergePlan["creates"], sessions: MergePlan["sessions"] = []) {
  const at = w.now - 5 * H;
  await w.t.mutation(pass.applyPlan, { user_id: w.ana, workspace: w.team, started_at: at, from_cursor: 0, cursor_at: at, model: "m", plan: { creates, updates: [], merges: [], sessions, unmap: [], notes: [], rewritten: [] } });
}
const cardsOn = (w: World) => w.t.run((ctx) => ctx.db.patch(w.ana, { experiments: ["priority_cards"] }));
const rows = async (w: World): Promise<Doc<"priorities">[]> => (await w.priorities()).filter((p: Doc<"priorities">) => p.workspace === w.team);
const cards = (w: World): Promise<Doc<"session_decisions">[]> => w.t.run(async (ctx) => (await ctx.db.query("session_decisions").collect()).filter((d) => d.priority_card));
const ANA = (w: World) => ({ kind: "user" as const, id: String(w.ana), user_id: w.ana });
const TOKEN = "cli_" + "priority_card_test";
const tick = () => new Promise((r) => setTimeout(r, 5));

/** Grader with one milestone and Ana's team session on it; she typed TYPED in it an hour ago. */
async function graderWorld() {
  const w = await world();
  await seed(w, [create(w.now, "new-1", "Trusted evals", 1, [{ key: "s1", title: "Grader faults under 10%", tier: "critical", tier_set_by: "pass", refs: [], done: false }])], [{ session: "jx7team", priority: "new-1", step_key: "s1" }]);
  await w.send(w.ana, w.teamConv, w.now - H, TYPED);
  return w;
}
/** A reply that renames Grader and its milestone, adds a milestone, and writes a new summary. */
const graderReply = (extra: unknown[] = []) => JSON.stringify({
  priorities: [{
    short_id: "pri-1", title: "Evals people trust", summary: "Calibrating the grader", status: "active", serves: null, rank: 1,
    why: ["Then Calibrate the grader", "a line nobody typed", "calibrate the grader"],
    steps: [
      { key: "s1", title: "Grader faults under 5%", tier: "critical", refs: [], why: ["get grader faults under five percent"] },
      { title: "Calibrate the grader", tier: "critical", refs: [], why: ["then calibrate   the grader"] },
    ],
    sessions: [{ session: "jx7team", step: "s1" }],
  }, ...extra],
  unassigned: [],
});

describe("the request", () => {
  test("off, the system prompt and schema are today's; on, they ask for why", () => {
    const input = { person: "Ana", workspace: "Acme", now: 1, window_start: 0, priorities: [], initiatives: [], step_tasks: [], sessions: [], calls: [] } as PriorityPassInput;
    const off = priorityPassRequest(input).req;
    expect(off.system).toBe(PRIORITY_PASS_SYSTEM);
    expect(off.output_schema).toBe(PRIORITY_PASS_SCHEMA as any);
    expect(JSON.stringify(off.output_schema)).not.toContain("why");
    expect(priorityPassRequest(input, {})).toEqual(priorityPassRequest(input));
    const on = priorityPassRequest(input, { why: true }).req;
    expect(on.prompt).toBe(off.prompt);
    expect(on.system.startsWith(PRIORITY_PASS_SYSTEM)).toBe(true);
    expect(on.system).toContain("verbatim");
    expect(on.output_schema).toBe(PRIORITY_PASS_SCHEMA_WHY as any);
    expect((PRIORITY_PASS_SCHEMA_WHY.properties.priorities.items.properties as any).why).toBeDefined();
    expect((PRIORITY_PASS_SCHEMA_WHY.properties.priorities.items.properties.steps.items.properties as any).why).toBeDefined();
  });
});

describe("a pass run", () => {
  test("off: every change is written and no card is posted", async () => {
    const w = await graderWorld();
    model.reply = () => graderReply();
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    const [g] = await rows(w);
    expect([g.title, g.summary, g.steps.map((s) => s.title)]).toEqual(["Evals people trust", "Calibrating the grader", ["Grader faults under 5%", "Calibrate the grader"]]);
    expect(await cards(w)).toEqual([]);
  });

  test("on: only the direct part is written, and one card holds the rest with its evidence", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    const bodies: string[] = [];
    const stubbed = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: { body: string }) => { bodies.push(init.body); return stubbed(url as any, init as any); }) as any;
    model.reply = () => graderReply();
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(bodies.at(-1)).toContain("verbatim");

    const [g] = await rows(w);
    // The summary is direct; the renames and the new milestone wait on the card.
    expect([g.title, g.summary, g.steps.map((s) => s.title)]).toEqual(["Trusted evals", "Calibrating the grader", ["Grader faults under 10%"]]);
    const [d] = await cards(w);
    expect(d).toMatchObject({ kind: "multi", silent: true, blocking: true, status: "pending", user_id: w.ana, asked_user_ids: [w.ana], holder_key: `user:${w.ana}`, team_id: w.acme });
    expect(d.question).toMatch(/^Should your priorities follow your last \d+ hours of work\?$/);
    expect(d.options.map((o) => o.label)).toEqual(["Rename: Evals people trust", "Rename: Grader faults under 10% → Grader faults under 5%", "New milestone: Calibrate the grader"]);
    const inbox = await w.t.run((ctx) => ctx.db.query("decision_inbox").withIndex("by_decision", (q) => q.eq("decision_id", d._id)).collect());
    expect(inbox.map((r) => [r.user_id, r.status])).toEqual([[w.ana, "pending"]]);

    const card = d.priority_card as PriorityCard;
    expect(card.changes.map((c) => c.kind)).toEqual(["rename", "rename_milestone", "new_milestone"]);
    expect(card.suggested).toEqual(card.changes.map((c) => c.id));
    expect(card.groups).toEqual([{ priority: "pri-1", rank: 1, title: "Trusted evals", changes: card.changes.map((c) => c.id) }]);
    // A verbatim excerpt is kept with its session, in the person's own words (case and whitespace forgiven);
    // one nobody typed is dropped, and so is one too short to mean anything.
    const quote = { kind: "quote", text: "then calibrate the grader", session: "jx7team", session_title: "Session jx7team", at: w.now - H };
    expect(card.changes[0].evidence).toEqual([quote]);
    expect(card.changes[1].evidence).toEqual([{ ...quote, text: "get grader faults under five percent" }]);
    expect(card.changes[2].evidence).toEqual([quote]);
    expect(card.words).toEqual([{ priority: "pri-1", rank: 1, title: "Trusted evals", share: 1 }]);
    expect(card.run).toMatchObject({ sessions: 1, calls: 0, runs_since_last_card: 2 });
    expect(card.run.cost_usd).toBeGreaterThan(0);
    expect(card.run.runs_today).toBeGreaterThanOrEqual(1);
  });

  test("on, proposing nothing posts no card", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    model.reply = () => JSON.stringify({ priorities: [], unassigned: [] });
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(await cards(w)).toEqual([]);
  });

  test("a change already on an open card is not proposed again; the next card counts the runs since the last", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    model.reply = () => graderReply();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    // The same changes again: nothing new, no second card.
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true });
    expect(await cards(w)).toHaveLength(1);
    // The same changes and a new priority: a card with only the new priority and its milestone.
    model.reply = () => graderReply([{ title: "Recipes", summary: "new", status: "active", serves: null, rank: 2, steps: [{ title: "Paste a recipe", tier: "critical", refs: [] }], sessions: [] }]);
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true });
    const all = await cards(w);
    expect(all).toHaveLength(2);
    const second = all[1].priority_card as PriorityCard;
    expect(second.changes.map((c) => c.kind)).toEqual(["new_priority", "new_milestone"]);
    expect(all[1].options.map((o) => o.label)).toEqual(["New priority at #2: Recipes", "New milestone: Paste a recipe"]);
    expect(second.run.runs_since_last_card).toBe(2);
    // The same new priority again, by title: not repeated.
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true });
    expect(await cards(w)).toHaveLength(2);
  });

  test("it sits in the person's own most recent session in the workspace, never a teammate's, the workspace agent's included", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    await w.t.run(async (ctx) => {
      await ctx.db.insert("anchors", { scope_type: "team", team_id: w.acme, bot_user_id: w.ben, host_user_id: w.ben, conversation_id: w.benConv, name: "Acme agent", status: "active", created_at: 1 });
      await ctx.db.patch(w.teamConv, { updated_at: w.now });
    });
    model.reply = () => graderReply();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [d] = await cards(w);
    expect([d.conversation_id, d.session_title]).toEqual([w.teamConv, "Session jx7team"]);
  });

  test("it sits in the person's queue without making its session ask: no lift, no ring, and its agent neither lists nor takes it back", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.teamConv, { updated_at: w.now });
      await ctx.db.insert("api_tokens", { user_id: w.ana, token_hash: await hashToken(TOKEN), name: "cli", created_at: 1, last_used_at: 1 } as any);
    });
    const before = await w.conversation(w.teamConv);
    model.reply = () => graderReply();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [d] = await cards(w);
    expect(d.conversation_id).toBe(w.teamConv);
    // In Ana's queue (a stacked ask with her inbox row), but it lifts no session as asking, hers or anyone's.
    expect([isStackedAsk(d), liftsAskingSession(d)]).toEqual([true, false]);
    const asking = (u: Id<"users">) => w.t.run(async (ctx) => [...(await loadPendingDecisionConvIds(ctx, u))]);
    expect(await asking(w.ana)).toEqual([]);
    // No phone rings, nothing is sent into the session, and its row is untouched.
    expect(ringsPhone(d)).toBe(false);
    expect(await w.t.run((ctx) => ctx.db.query("pending_messages").collect())).toEqual([]);
    expect(await w.conversation(w.teamConv)).toEqual(before);
    // The session's agent (Ana's token): `cast decide ls` does not show it, a re-ask does not touch it, `cast decide cancel` cannot take it.
    const listed = await w.t.mutation(api.sessionDecisions.listForSession, { api_token: TOKEN, session_id: "jx7team" });
    expect(listed.decisions).toEqual([]);
    expect((await w.t.mutation(api.sessionDecisions.listForSession, { api_token: TOKEN, mine: true })).decisions).toEqual([]);
    const asked = await w.t.mutation(api.sessionDecisions.ask, { api_token: TOKEN, session_id: "jx7team", question: d.question, options: [{ label: "Yes" }, { label: "No" }] } as any);
    expect(asked.other_open ?? []).toEqual([]);
    expect(asked.id).not.toBe(d._id);
    expect(await w.t.mutation(api.sessionDecisions.withdraw, { api_token: TOKEN, decision_id: d.short_id!, session_id: "jx7team" })).toEqual({ error: "Decision not found" });
    expect((await w.t.run((ctx) => ctx.db.get(d._id)))?.status).toBe("pending");
  });

  test("a session owner change leaves the card with its person", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    model.reply = () => graderReply();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [d] = await cards(w);
    await w.t.run(async (ctx) => {
      await ctx.db.patch(d.conversation_id, { user_id: w.ben });
      await reroutePendingDecisionsForConversation(ctx as any, d.conversation_id, Date.now());
    });
    const after = (await w.t.run((ctx) => ctx.db.get(d._id)))!;
    expect(after.asked_user_ids).toEqual([w.ana]);
  });

  test("a run that read the priorities before a card was answered writes nothing: the answer stands, the cursor stays", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    model.reply = () => graderReply();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [d] = await cards(w);
    const [stale] = await rows(w);
    await tick();
    // A run starts reading here; the card is answered while it reads.
    const started_at = Date.now();
    await tick();
    await w.t.run((ctx) => finalizeAnswer(ctx as any, d, { status: "answered", answer_json: [0, 1, 2], answer_index: 0 }, ANA(w), { deliver: false }));
    const answered = (await rows(w))[0];
    expect(answered.steps.map((s) => s.title)).toEqual(["Grader faults under 5%", "Calibrate the grader"]);
    // Its plan was made from the priorities as they were: their milestones as they stood then.
    const plan = { creates: [], updates: [{ short_id: "pri-1", patch: { steps: stale.steps, summary: "stale" }, seen_steps: stale.steps.map((s) => s.key) }], merges: [], sessions: [], unmap: [], notes: [], rewritten: [] };
    const empty = { changes: [], groups: [], held: { v: 1, order: [], creates: [], changes: [], sessions: [] }, typed: [], sessions: 0, calls: 0 };
    const result = await w.t.mutation(pass.applyPlan, { user_id: w.ana, workspace: w.team, started_at, from_cursor: 7, cursor_at: started_at, model: "m", plan, card: empty });
    expect(result).toBeNull();
    const [after] = await rows(w);
    expect([after.summary, after.steps.map((s) => s.title)]).toEqual([answered.summary, ["Grader faults under 5%", "Calibrate the grader"]]);
    expect(await w.latestRun()).toMatchObject({ status: "skipped", error: "superseded", cursor_at: 7 });
  });

  test("corrections the run read wait on its card: applied when the person answers or dismisses it, pending while it is open or once it is withdrawn", async () => {
    const correctionWorld = async () => {
      const w = await graderWorld();
      await cardsOn(w);
      const [g] = await rows(w);
      const id = await w.t.run((ctx) => ctx.db.insert("priority_corrections", { user_id: w.ana, workspace: w.team, priority_id: g._id, text: "Calibration is part of grading", status: "pending", created_at: w.now - 2 * H, snapshot: { short_id: g.short_id, title: g.title, summary: g.summary, status: g.status, steps: g.steps } }));
      model.reply = () => graderReply();
      await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
      const [d] = await cards(w);
      return { w, d, id, status: async () => (await w.t.run((ctx) => ctx.db.get(id)))!.status };
    };
    const open = await correctionWorld();
    expect(await open.status()).toBe("pending");
    expect((open.d.priority_card as any).held.corrections).toEqual([open.id]);
    await open.w.t.run((ctx) => finalizeAnswer(ctx as any, open.d, { status: "dismissed" }, ANA(open.w), { deliver: false }));
    expect(await open.status()).toBe("applied");

    const answered = await correctionWorld();
    await answered.w.t.run((ctx) => finalizeAnswer(ctx as any, answered.d, { status: "answered", answer_json: [2], answer_index: 2 }, ANA(answered.w), { deliver: false }));
    expect(await answered.status()).toBe("applied");

    const withdrawn = await correctionWorld();
    await withdrawn.w.t.run((ctx) => withdrawCore(ctx as any, withdrawn.d, Date.now()));
    expect(await withdrawn.status()).toBe("pending");
  });
});

describe("the card stays the person's (the rule on isPriorityCard)", () => {
  async function posted() {
    const w = await graderWorld();
    await cardsOn(w);
    await w.t.run((ctx) => ctx.db.patch(w.teamConv, { updated_at: w.now }));
    model.reply = () => graderReply();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [d] = await cards(w);
    return { w, d };
  }

  test("nobody passes, escalates or stacks it, the person included; the person's answer still writes", async () => {
    const { w, d } = await posted();
    // Ana is refused the hand-off; Ben, who reads her session, cannot even read the card.
    for (const [by, error] of [[w.ana, PRIORITY_CARD_HANDOFF_REFUSED], [w.ben, "Unauthorized: not your decision"]] as const) {
      expect(await w.t.run((ctx) => passCore(ctx as any, by, d.short_id!, { kind: "user", id: String(w.ben) }, "yours"))).toEqual({ error });
      expect(await w.t.run((ctx) => escalateCore(ctx as any, by, d.short_id!, "up it goes"))).toEqual({ error });
    }
    const stack = await w.t.run((ctx) => createStackCore(ctx as any, w.ana, { title: "Morning" }));
    expect(await w.t.run((ctx) => addToStackCore(ctx as any, w.ana, (stack as any).short_id ?? String((stack as any).id ?? (stack as any)._id), d.short_id!))).toEqual({ error: PRIORITY_CARD_HANDOFF_REFUSED });
    const after = (await w.t.run((ctx) => ctx.db.get(d._id)))!;
    expect([after.asked_user_ids, after.passed_to, after.escalated, after.stack_id]).toEqual([[w.ana], undefined, undefined, undefined]);
    await w.t.run((ctx) => finalizeAnswer(ctx as any, after, { status: "answered", answer_json: [0], answer_index: 0 }, ANA(w), { deliver: false }));
    expect((await rows(w))[0].title).toBe("Evals people trust");
  });

  test("a run that repeats an open card's changes leaves the corrections that card holds pending", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    const [g] = await rows(w);
    const id = await w.t.run((ctx) => ctx.db.insert("priority_corrections", { user_id: w.ana, workspace: w.team, priority_id: g._id, text: "Calibration is part of grading", status: "pending", created_at: w.now - 2 * H, snapshot: { short_id: g.short_id, title: g.title, summary: g.summary, status: g.status, steps: g.steps } }));
    model.reply = () => graderReply();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    // The same changes again: no new card; the correction it read is the open card's, still pending.
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true });
    expect(await cards(w)).toHaveLength(1);
    expect((await w.t.run((ctx) => ctx.db.get(id)))!.status).toBe("pending");
  });

  test("it never sits in a hosted assistant's session, a run's, or a killed or closed one", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    await w.t.run(async (ctx) => {
      const run = await ctx.db.insert("conversations", { user_id: w.ana, agent_type: "claude_code", session_id: "jx7runl", short_id: "jx7runl", title: "Run log", team_id: w.acme, is_private: false, team_visibility: "full", started_at: w.now, updated_at: w.now + 4, message_count: 1, status: "active", is_workflow_primary: true, workflow_run_id: "run-1" } as any);
      void run;
      await ctx.db.insert("conversations", { user_id: w.ana, agent_type: "codecast", session_id: "jx7host", short_id: "jx7host", title: "Assistant", team_id: w.acme, is_private: false, team_visibility: "full", started_at: w.now, updated_at: w.now + 3, message_count: 1, status: "active" } as any);
      await ctx.db.patch(w.teamConv, { updated_at: w.now + 2, inbox_killed_at: w.now });
      await ctx.db.patch(w.oldConv, { updated_at: w.now + 1, inbox_closed_at: w.now, inbox_dismissed_at: w.now });
      // Ben's session is newer still, and the team's: never his.
      await ctx.db.patch(w.benConv, { updated_at: w.now + 5 });
      await ctx.db.insert("conversations", { user_id: w.ana, agent_type: "claude_code", session_id: "jx7open", short_id: "jx7open", title: "Session jx7open", team_id: w.acme, is_private: false, team_visibility: "full", started_at: w.now, updated_at: w.now, message_count: 1, status: "active" } as any);
    });
    model.reply = () => graderReply();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [d] = await cards(w);
    expect(d.session_title).toBe("Session jx7open");
  });

  test("a session the person launched a run from still takes the card; the run's own log and stations never do", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    await w.t.run(async (ctx) => {
      // Both of Ana's team sessions launched a run, so each carries its pointer.
      await ctx.db.patch(w.teamConv, { workflow_run_id: "run-1" as any, updated_at: w.now });
      await ctx.db.patch(w.oldConv, { workflow_run_id: "run-2" as any });
      // The run's log and one of its stations are newer still.
      await ctx.db.insert("conversations", { user_id: w.ana, agent_type: "claude_code", session_id: "jx7runl", short_id: "jx7runl", title: "Run log", team_id: w.acme, is_private: false, team_visibility: "full", started_at: w.now, updated_at: w.now + 2, message_count: 1, status: "active", is_workflow_primary: true, workflow_run_id: "run-1" } as any);
      await ctx.db.insert("conversations", { user_id: w.ana, agent_type: "claude_code", session_id: "jx7stat", short_id: "jx7stat", title: "Station", team_id: w.acme, is_private: false, team_visibility: "full", started_at: w.now, updated_at: w.now + 1, message_count: 1, status: "active", is_workflow_sub: true, parent_conversation_id: w.teamConv, workflow_run_id: "run-1" } as any);
    });
    model.reply = () => graderReply();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [d] = await cards(w);
    expect(d?.conversation_id).toBe(w.teamConv);
  });

  test("an open card is found among the person's newest open decisions, however many older ones they hold", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    // A thousand older open decisions, written before the card.
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 1000; i++) {
        await ctx.db.insert("session_decisions", { conversation_id: w.oldConv, session_id: "jx7old", user_id: w.ana, question: `q${i}`, options: [{ label: "A" }], blocking: false, status: "pending", created_at: w.now - 2 * DAY + i } as any);
      }
    });
    model.reply = () => graderReply();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true });
    expect(await cards(w)).toHaveLength(1);
  });

  test("the next card counts the runs since the last one, however many other decisions the person answered between", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    model.reply = () => graderReply();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [first] = await cards(w);
    await w.t.run((ctx) => finalizeAnswer(ctx as any, first, { status: "dismissed" }, ANA(w), { deliver: false }));
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 250; i++) {
        await ctx.db.insert("session_decisions", { conversation_id: w.oldConv, session_id: "jx7old", user_id: w.ana, question: `q${i}`, options: [{ label: "A" }], blocking: true, status: "dismissed", created_at: Date.now() + 1 + i, resolved_at: Date.now() + 1 + i } as any);
      }
    });
    await tick();
    model.reply = () => graderReply([{ title: "Recipes", summary: "new", status: "active", serves: null, rank: 2, steps: [], sessions: [] }]);
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true });
    const second = (await cards(w)).find((d) => d._id !== first._id)!;
    expect((second.priority_card as PriorityCard).run.runs_since_last_card).toBe(1);
  });
});

describe("who may answer and read the card", () => {
  test("only its person answers or dismisses it; an agent answering for them, or a teammate, is refused", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    model.reply = () => graderReply();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [d] = await cards(w);
    const ben = { kind: "user" as const, id: String(w.ben), user_id: w.ben };
    for (const [verdict, by] of [[{ status: "dismissed" as const }, ben], [{ status: "answered" as const, answer_json: [0], answer_index: 0 }, ben], [{ status: "answered" as const, answer_json: [0], answer_index: 0 }, { ...ANA(w), via: w.oldConv }]] as const) {
      await expect(w.t.run((ctx) => finalizeAnswer(ctx as any, d, verdict as any, by as any, { deliver: false }))).rejects.toThrow(PRIORITY_CARD_REFUSED);
    }
    expect((await w.t.run((ctx) => ctx.db.get(d._id)))?.status).toBe("pending");
    expect((await rows(w))[0].title).toBe("Trusted evals");
  });

  test("a teammate who can read the session does not receive the decision at all; its person reads it whole", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.teamConv, { updated_at: w.now });
      await ctx.db.insert("api_tokens", { user_id: w.ben, token_hash: await hashToken(TOKEN), name: "cli", created_at: 1, last_used_at: 1 } as any);
    });
    model.reply = () => graderReply();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [d] = await cards(w);
    const ana = w.t.withIdentity({ subject: w.ana });
    const ben = w.t.withIdentity({ subject: w.ben });
    expect((await ana.query(api.sessionDecisions.get, { decision_id: d.short_id! }))?.priority_card).toBeDefined();
    expect((await ana.query(api.sessionDecisions.getWithDoc, { decision_id: d.short_id! }))?.decision).toHaveProperty("priority_card");
    expect((await ana.query(api.sessionDecisions.listForUser, {})).find((x: any) => x._id === d._id)?.priority_card).toBeDefined();
    // Ben reads Ana's session, and gets nothing of the card: no row, no question, no count.
    expect(await ben.query(api.sessionDecisions.get, { decision_id: d.short_id! })).toBeNull();
    expect(await ben.query(api.sessionDecisions.getWithDoc, { decision_id: d.short_id! })).toBeNull();
    expect(await ben.query(api.sessionDecisions.getWithDocMany, { decision_ids: [String(d._id)] })).toEqual([]);
    expect((await ben.query(api.decisionTeamList.listForTeam, { workspace: w.team })).some((x: any) => x._id === d._id)).toBe(false);
    expect((await ben.query(api.sessionDecisions.listForUser, {})).some((x: any) => x._id === d._id)).toBe(false);
    expect(await ben.query(api.sessionDecisions.findAskMessage, { decision_id: d._id })).toBeNull();
    expect(await w.t.query(api.sessionDecisions.showForCli, { api_token: TOKEN, decision_id: d.short_id! })).toEqual({ error: "Unauthorized: not your decision" });
    expect(await w.t.run((ctx) => userMayRead(ctx as any, w.ben, d))).toBe(false);
    // Answered, it is no bubble of Ana's session for Ben either.
    await w.t.run((ctx) => finalizeAnswer(ctx as any, d, { status: "answered", answer_json: [0], answer_index: 0 }, ANA(w), { deliver: false }));
    expect((await ana.query(api.sessionDecisions.findByAnswer, { conversation_id: w.teamConv, answer: d.options[0].label }))?._id).toBe(d._id);
    expect(await ben.query(api.sessionDecisions.findByAnswer, { conversation_id: w.teamConv, answer: d.options[0].label })).toBeNull();
  });
});

describe("answering the card", () => {
  async function posted() {
    const w = await graderWorld();
    await cardsOn(w);
    model.reply = () => graderReply();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [d] = await cards(w);
    return { w, d };
  }
  const answer = (w: World, d: Doc<"session_decisions">, ticks: number[], by = ANA(w)) =>
    w.t.run((ctx) => finalizeAnswer(ctx as any, d, { status: "answered", answer_json: ticks, answer_index: ticks[0] }, by, { deliver: false }));
  const outcome = async (w: World, id: Id<"session_decisions">) => ((await w.t.run((ctx) => ctx.db.get(id)))!.priority_card as PriorityCard).outcome;

  test("all: every change is written, and the card records it", async () => {
    const { w, d } = await posted();
    await answer(w, d, [0, 1, 2]);
    const [g] = await rows(w);
    expect([g.title, g.steps.map((s) => [s.key, s.title])]).toEqual(["Evals people trust", [["s1", "Grader faults under 5%"], ["s2", "Calibrate the grader"]]]);
    const ids = (d.priority_card as PriorityCard).changes.map((c) => c.id);
    expect(await outcome(w, d._id)).toMatchObject({ accepted: ids, skipped: [] });
  });

  test("some: only the ticked changes are written", async () => {
    const { w, d } = await posted();
    await answer(w, d, [2]);
    const [g] = await rows(w);
    expect([g.title, g.steps.map((s) => s.title)]).toEqual(["Trusted evals", ["Grader faults under 10%", "Calibrate the grader"]]);
  });

  test("none, or a dismissal: nothing is written", async () => {
    const { w, d } = await posted();
    const before = await rows(w);
    await w.t.run(async (ctx) => {
      await ctx.db.patch(d._id, { status: "answered", answer_json: [] });
      await settleClientResolution(ctx as any, d, { status: "answered", answer_json: [] }, w.ana, Date.now());
    });
    expect((await rows(w)).map((p) => [p.title, p.steps])).toEqual(before.map((p) => [p.title, p.steps]));
    expect(await outcome(w, d._id)).toMatchObject({ accepted: [], skipped: [] });

    const other = await posted();
    const was = await rows(other.w);
    await other.w.t.run((ctx) => finalizeAnswer(ctx as any, other.d, { status: "dismissed" }, ANA(other.w), { deliver: false }));
    expect((await rows(other.w)).map((p) => [p.title, p.steps])).toEqual(was.map((p) => [p.title, p.steps]));
    // The web's "Accept none" is a dismissal: the card reads as answered with nothing accepted.
    expect(await outcome(other.w, other.d._id)).toMatchObject({ accepted: [], skipped: [] });
  });

  test("words with no ticks write nothing and become a correction the next pass reads", async () => {
    const { w, d } = await posted();
    const words = "Calibration is its own priority";
    await w.t.run(async (ctx) => {
      await ctx.db.patch(d._id, { status: "answered", answer_text: words });
      await settleClientResolution(ctx as any, d, { status: "answered", answer_text: words }, w.ana, Date.now());
    });
    const [g] = await rows(w);
    expect(g.title).toBe("Trusted evals");
    const corrections = await w.t.run((ctx) => ctx.db.query("priority_corrections").collect());
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({ priority_id: g._id, status: "pending", user_id: w.ana, workspace: w.team });
    expect(corrections[0].text).toContain(d.short_id!);
    expect(corrections[0].text).toContain("Rename: Evals people trust");
    expect(corrections[0].text.endsWith(words)).toBe(true);
    const { input } = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: w.team });
    expect(input.corrections?.map((c: any) => c.text)).toEqual([corrections[0].text]);
    expect(await outcome(w, d._id)).toMatchObject({ accepted: [], skipped: [], text: words });
  });

  test("a change the person made since is skipped; the rest land", async () => {
    const { w, d } = await posted();
    const [g] = await rows(w);
    await w.t.run((ctx) => ctx.db.patch(g._id, { steps: g.steps.map((s) => ({ ...s, title: "My words", title_set_by: "person" as const })) }));
    await answer(w, d, [0, 1, 2]);
    const [after] = await rows(w);
    expect([after.title, after.steps.map((s) => s.title)]).toEqual(["Evals people trust", ["My words", "Calibrate the grader"]]);
    const ids = (d.priority_card as PriorityCard).changes.map((c) => c.id);
    expect(await outcome(w, d._id)).toMatchObject({ accepted: [ids[0], ids[2]], skipped: [ids[1]] });
  });

  test("a new priority accepted takes the sessions the run put on it; unticked, they stay where they were", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    await w.send(w.ana, w.oldConv, w.now - H, "paste a recipe into the app");
    model.reply = () => graderReply([{ title: "Recipes", summary: "new", status: "active", serves: null, rank: 2, steps: [{ title: "Paste a recipe", tier: "critical", refs: [] }], sessions: [{ session: "jx7old", step: "Paste a recipe" }] }]);
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [d] = await cards(w);
    expect((await w.conversation(w.oldConv))?.priority_id).toBeUndefined();
    const labels = d.options.map((o) => o.label);
    await answer(w, d, [labels.indexOf("New priority at #2: Recipes"), labels.indexOf("New milestone: Paste a recipe")]);
    const recipes = (await rows(w)).find((p) => p.title === "Recipes")!;
    expect(recipes.steps.map((s) => s.title)).toEqual(["Paste a recipe"]);
    expect(await w.conversation(w.oldConv)).toMatchObject({ priority_id: recipes._id, priority_step_key: recipes.steps[0].key });
    expect((await rows(w)).find((p) => p.short_id === "pri-1")!.title).toBe("Trusted evals");
  });

  test("a move lands at the slot the card showed, as the person's own, a placed priority included", async () => {
    const w = await world();
    await seed(w, [create(w.now, "new-1", "Alpha", 1), create(w.now, "new-2", "Beta", 2), create(w.now, "new-3", "Gamma", 3)]);
    const gamma = (await rows(w)).find((p) => p.title === "Gamma")!;
    await w.t.run((ctx) => ctx.db.patch(gamma._id, { person_pos: 3, ai_rank: undefined }));
    await cardsOn(w);
    model.reply = () => JSON.stringify({ priorities: [{ short_id: gamma.short_id, title: "Gamma", summary: "", status: "active", serves: null, rank: 1, steps: [], sessions: [] }], unassigned: [] });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true });
    // The run moved nothing.
    expect(effectivePriorityOrder(await rows(w)).map((p) => p.title)).toEqual(["Alpha", "Beta", "Gamma"]);
    const [d] = await cards(w);
    expect(d.options.map((o) => o.label)).toEqual(["Moved: to #1 from #3"]);
    await answer(w, d, [0]);
    const after = await rows(w);
    expect(effectivePriorityOrder(after).map((p) => p.title)).toEqual(["Gamma", "Alpha", "Beta"]);
    expect(after.find((p) => p.title === "Gamma")!.person_pos).not.toBe(3);
  });
});

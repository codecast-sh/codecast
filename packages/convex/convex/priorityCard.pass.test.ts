// Priority change cards end to end (plan pl-1131): a pass run with the
// person's priority_cards experiment on writes only its direct part and posts
// one card; answering the card writes what was ticked. With the experiment off
// a run writes everything, as it always has. Synthetic data only.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { PriorityCard } from "@codecast/shared/contracts/priorityCard";
import { effectivePriorityOrder } from "@codecast/shared/contracts/priorities";
import type { MergePlan, PriorityPassInput } from "./lib/priorityPass";
import { PRIORITY_PASS_SCHEMA, PRIORITY_PASS_SCHEMA_WHY, PRIORITY_PASS_SYSTEM, priorityPassRequest } from "./lib/priorityPass";
import { finalizeAnswer, settleClientResolution } from "./sessionDecisions";
import { isStackedAsk } from "@codecast/shared/contracts";
import { loadPendingDecisionConvIds } from "./conversations";
import { ringsPhone } from "./lib/decisionRing";
import { H, pass, stubModel, world } from "./priorityPassRun.testkit";
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
    why: ["calibrate the grader", "a line nobody typed"],
    steps: [
      { key: "s1", title: "Grader faults under 5%", tier: "critical", refs: [], why: ["get grader faults under five percent"] },
      { title: "Calibrate the grader", tier: "critical", refs: [], why: ["calibrate   the grader"] },
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
    // A verbatim excerpt is kept with its session; one nobody typed is dropped; whitespace is forgiven.
    const quote = { kind: "quote", text: "calibrate the grader", session: "jx7team", session_title: "Session jx7team", at: w.now - H };
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

  test("the card is asked from the workspace's agent's session when it has one", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    await w.t.run((ctx) => ctx.db.insert("anchors", { scope_type: "team", team_id: w.acme, bot_user_id: w.ben, host_user_id: w.ben, conversation_id: w.benConv, name: "Acme agent", status: "active", created_at: 1 }));
    model.reply = () => graderReply();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [d] = await cards(w);
    expect([d.conversation_id, d.session_title]).toEqual([w.benConv, "Session jx7ben"]);
  });

  test("it sits in the person's queue, and leaves the session it hangs on as it was", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    await w.t.run((ctx) => ctx.db.insert("anchors", { scope_type: "team", team_id: w.acme, bot_user_id: w.ben, host_user_id: w.ben, conversation_id: w.benConv, name: "Acme agent", status: "active", created_at: 1 }));
    const before = await w.conversation(w.benConv);
    model.reply = () => graderReply();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [d] = await cards(w);
    // In Ana's QUESTIONS (a stacked ask), under the session it was asked from; not in Ben's, whose session it is.
    expect(isStackedAsk(d)).toBe(true);
    const asking = (u: Id<"users">) => w.t.run(async (ctx) => [...(await loadPendingDecisionConvIds(ctx, u))]);
    expect(await asking(w.ana)).toEqual([String(w.benConv)]);
    expect(await asking(w.ben)).toEqual([]);
    // No phone rings, nothing is sent into the session, and its row is untouched.
    expect(ringsPhone(d)).toBe(false);
    expect(await w.t.run((ctx) => ctx.db.query("pending_messages").collect())).toEqual([]);
    expect(await w.conversation(w.benConv)).toEqual(before);
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

  test("only the person it asked writes: a teammate's answer writes nothing", async () => {
    const { w, d } = await posted();
    await answer(w, d, [0, 1, 2], { kind: "user", id: String(w.ben), user_id: w.ben });
    expect((await rows(w))[0].title).toBe("Trusted evals");
    expect(await outcome(w, d._id)).toBeUndefined();
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

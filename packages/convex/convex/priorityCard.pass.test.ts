// Priority change cards end to end (plan pl-1131, sd-5035): a pass run with the
// person's priority_cards experiment on writes everything a run without it
// writes, except its merges, which wait on one card; answering the card
// writes the merges ticked, and a merge declined is never proposed again.
// Synthetic data only.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { PriorityCard } from "@codecast/shared/contracts/priorityCard";
import { effectivePriorityOrder } from "@codecast/shared/contracts/priorities";
import type { MergePlan, PriorityPassInput } from "./lib/priorityPass";
import { PRIORITY_PASS_SCHEMA, PRIORITY_PASS_SCHEMA_WHY, PRIORITY_PASS_SYSTEM, priorityPassRequest } from "./lib/priorityPass";
import { finalizeAnswer, reroutePendingDecisionsForConversation, settleClientResolution } from "./sessionDecisions";
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
const step = (key: string, title: string) => ({ key, title, tier: "critical" as const, tier_set_by: "pass" as const, refs: [], done: false });

/** Seeds Ana's priorities in Acme with one ok run five hours ago, so the next run reads the last few hours. */
async function seed(w: World, creates: MergePlan["creates"], sessions: MergePlan["sessions"] = []) {
  const at = w.now - 5 * H;
  await w.t.mutation(pass.applyPlan, { user_id: w.ana, workspace: w.team, started_at: at, from_cursor: 0, cursor_at: at, model: "m", plan: { creates, updates: [], merges: [], sessions, unmap: [], notes: [], rewritten: [] } });
}
const cardsOn = (w: World) => w.t.run((ctx) => ctx.db.patch(w.ana, { experiments: ["priority_cards"] }));
const rows = async (w: World): Promise<Doc<"priorities">[]> => (await w.priorities()).filter((p: Doc<"priorities">) => p.workspace === w.team);
const row = async (w: World, shortId: string) => (await rows(w)).find((p) => p.short_id === shortId)!;
const cards = (w: World): Promise<Doc<"session_decisions">[]> => w.t.run(async (ctx) => (await ctx.db.query("session_decisions").collect()).filter((d) => d.priority_card));
const ANA = (w: World) => ({ kind: "user" as const, id: String(w.ana), user_id: w.ana });
const TOKEN = "cli_" + "priority_card_test";
const tick = () => new Promise((r) => setTimeout(r, 5));

/**
 * Ana's three priorities: Trusted evals (pri-1, her team session on its milestone), Grader calibration (pri-2, her
 * old session on "Calibrate the grader") and Docs (pri-3). She typed TYPED in her team session an hour ago.
 */
async function graderWorld() {
  const w = await world();
  await seed(w, [
    create(w.now, "new-1", "Trusted evals", 1, [step("s1", "Grader faults under 10%")]),
    create(w.now, "new-2", "Grader calibration", 2, [step("s1", "Calibrate the grader")]),
    create(w.now, "new-3", "Docs", 3),
  ], [{ session: "jx7team", priority: "new-1", step_key: "s1" }, { session: "jx7old", priority: "new-2", step_key: "s1" }]);
  await w.send(w.ana, w.teamConv, w.now - H, TYPED);
  return w;
}
/** Trusted evals renamed, its milestone renamed, and Grader calibration merged into it (its milestone and session with it). */
const evals = (over: Record<string, unknown> = {}) => ({
  short_id: "pri-1", title: "Evals people trust", summary: "Calibrating the grader", status: "active", serves: null, rank: 1,
  why: ["Then Calibrate the grader", "a line nobody typed", "calibrate the grader"],
  merges: ["pri-2"],
  steps: [
    { key: "s1", title: "Grader faults under 5%", tier: "critical", refs: [], why: ["get grader faults under five percent"] },
    { key: "pri-2/s1", title: "Calibrate the grader", tier: "critical", refs: [] },
  ],
  sessions: [{ session: "jx7team", step: "s1" }, { session: "jx7old", step: "pri-2/s1" }],
  ...over,
});
const reply = (...priorities: unknown[]) => JSON.stringify({ priorities, unassigned: [] });
/** The merge reply, with Docs moved to the top and a new priority, which are written at once. */
const mergeReply = () => reply(evals(), { short_id: "pri-3", title: "Docs", summary: "", status: "active", serves: null, rank: 1, steps: [], sessions: [] }, { title: "Recipes", summary: "new", status: "active", serves: null, rank: 4, steps: [{ title: "Paste a recipe", tier: "critical", refs: [] }], sessions: [] });

async function posted() {
  const w = await graderWorld();
  await cardsOn(w);
  await w.t.run((ctx) => ctx.db.patch(w.teamConv, { updated_at: w.now }));
  model.reply = () => reply(evals());
  await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
  const [d] = await cards(w);
  return { w, d };
}
const answer = (w: World, d: Doc<"session_decisions">, ticks: number[], by = ANA(w)) =>
  w.t.run((ctx) => finalizeAnswer(ctx as any, d, { status: "answered", answer_json: ticks, answer_index: ticks[0] }, by, { deliver: false }));
const outcome = async (w: World, id: Id<"session_decisions">) => ((await w.t.run((ctx) => ctx.db.get(id)))!.priority_card as PriorityCard).outcome;

describe("the request", () => {
  test("off, the system prompt and schema are today's; on, they ask for why, and name the merges the person declined", () => {
    const input = { person: "Ana", workspace: "Acme", now: 1, window_start: 0, priorities: [], initiatives: [], step_tasks: [], sessions: [], calls: [] } as PriorityPassInput;
    const off = priorityPassRequest(input).req;
    expect(off.system).toBe(PRIORITY_PASS_SYSTEM);
    expect(off.output_schema).toBe(PRIORITY_PASS_SCHEMA as any);
    expect(JSON.stringify(off.output_schema)).not.toContain("why");
    expect(priorityPassRequest(input, {})).toEqual(priorityPassRequest(input));
    const on = priorityPassRequest(input, { why: true, declinedMerges: [] }).req;
    expect(on.prompt).toBe(off.prompt);
    expect(on.system.startsWith(PRIORITY_PASS_SYSTEM)).toBe(true);
    expect(on.system).toContain("verbatim");
    expect(on.output_schema).toBe(PRIORITY_PASS_SCHEMA_WHY as any);
    expect((PRIORITY_PASS_SCHEMA_WHY.properties.priorities.items.properties as any).why).toBeDefined();
    expect((PRIORITY_PASS_SCHEMA_WHY.properties.priorities.items.properties.steps.items.properties as any).why).toBeDefined();
    expect(priorityPassRequest(input, { why: true, declinedMerges: [{ absorbed: "pri-2", into: "pri-1" }] }).req.prompt).toContain("# Merges the person declined (never merge these two, either way round)\n- pri-2 and pri-1");
  });
});

describe("a pass run", () => {
  test("off: every change is written, the merge included, and no card is posted", async () => {
    const w = await graderWorld();
    model.reply = () => mergeReply();
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect([(await row(w, "pri-1")).title, (await row(w, "pri-2")).status]).toEqual(["Evals people trust", "merged"]);
    expect(await cards(w)).toEqual([]);
  });

  test("on, with no merge: it writes exactly what a run without the experiment writes, and posts no card", async () => {
    const noMerge = () => reply(evals({ merges: undefined, steps: [{ key: "s1", title: "Grader faults under 5%", tier: "critical", refs: [] }, { title: "Calibrate it", tier: "polish", refs: [] }], sessions: [{ session: "jx7team", step: "s1" }] }),
      { short_id: "pri-3", title: "Docs", summary: "", status: "active", serves: null, rank: 1, steps: [], sessions: [] },
      { title: "Recipes", summary: "new", status: "active", serves: null, rank: 4, steps: [{ title: "Paste a recipe", tier: "critical", refs: [] }], sessions: [] });
    const run = async (on: boolean) => {
      const w = await graderWorld();
      if (on) await cardsOn(w);
      model.reply = noMerge;
      await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
      // Each world has its own clock and ids; everything else must match.
      const timeless = ({ _id, _creationTime, created_at, updated_at, pass_at, first_seen_at, last_active_at, user_id, workspace, ...p }: any) => p;
      const placed = await Promise.all([w.teamConv, w.oldConv].map(async (id) => { const c = await w.conversation(id); return [c?.priority_id ? (await w.t.run((ctx) => ctx.db.get(c.priority_id!)))?.short_id : null, c?.priority_step_key]; }));
      return { priorities: (await rows(w)).map(timeless).sort((a, b) => a.short_id.localeCompare(b.short_id)), placed, cards: (await cards(w)).length, counts: (await w.latestRun())?.counts };
    };
    const [off, on] = [await run(false), await run(true)];
    expect(on).toEqual(off);
    expect(on.cards).toBe(0);
    // What it wrote: the rename, the move, the new priority and the new milestone, at once.
    expect(on.priorities.map((p: any) => [p.short_id, p.title, p.steps.map((s: any) => s.title)])).toEqual([
      ["pri-1", "Evals people trust", ["Grader faults under 5%", "Calibrate it"]], ["pri-2", "Grader calibration", ["Calibrate the grader"]], ["pri-3", "Docs", []], ["pri-4", "Recipes", ["Paste a recipe"]],
    ]);
  });

  test("on, with a merge: every other change is written at once; the merge waits on one card, and nothing of it happens", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    const bodies: string[] = [];
    const stubbed = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: { body: string }) => { bodies.push(init.body); return stubbed(url as any, init as any); }) as any;
    model.reply = () => mergeReply();
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(bodies.at(-1)).toContain("verbatim");

    // Written at once: the renames, the move (as the pass's rank) and the new priority with its milestone.
    const evalsNow = await row(w, "pri-1");
    expect([evalsNow.title, evalsNow.summary, evalsNow.steps.map((s) => s.title)]).toEqual(["Evals people trust", "Calibrating the grader", ["Grader faults under 5%"]]);
    expect(effectivePriorityOrder(await rows(w)).map((p) => p.title)).toEqual(["Docs", "Evals people trust", "Grader calibration", "Recipes"]);
    expect((await row(w, "pri-4")).steps.map((s) => s.title)).toEqual(["Paste a recipe"]);
    // Nothing of the merge: Grader calibration stands with its milestone, and its session stays on it.
    const grader = await row(w, "pri-2");
    expect([grader.status, grader.steps.map((s) => s.title)]).toEqual(["active", ["Calibrate the grader"]]);
    expect((await w.conversation(w.oldConv))?.priority_id).toBe(grader._id);

    const [d] = await cards(w);
    expect(d).toMatchObject({ kind: "multi", silent: true, blocking: true, status: "pending", user_id: w.ana, asked_user_ids: [w.ana], holder_key: `user:${w.ana}`, team_id: w.acme });
    expect(d.question).toBe("Merge “Grader calibration” into “Evals people trust”?");
    expect(d.options.map((o) => o.label)).toEqual(["Merge: absorbs Grader calibration"]);
    const inbox = await w.t.run((ctx) => ctx.db.query("decision_inbox").withIndex("by_decision", (q) => q.eq("decision_id", d._id)).collect());
    expect(inbox.map((r) => [r.user_id, r.status])).toEqual([[w.ana, "pending"]]);
    const card = d.priority_card as PriorityCard;
    expect(card.changes.map((c) => [c.kind, c.priority, c.target])).toEqual([["merge", "pri-1", "pri-2"]]);
    expect(card.groups).toEqual([{ priority: "pri-1", rank: 2, title: "Evals people trust", changes: [card.changes[0].id] }]);
    // A verbatim excerpt is kept, in the person's own words; one nobody typed, or too short to mean anything, is dropped.
    expect(card.changes[0].evidence).toEqual([{ kind: "quote", text: "then calibrate the grader", session: "jx7team", session_title: "Session jx7team", at: w.now - H }]);
    expect(card.words).toEqual([{ priority: "pri-1", rank: 2, title: "Evals people trust", share: 1 }]);
    expect(card.run).toMatchObject({ sessions: 1, calls: 0, runs_since_last_card: 2 });
    expect(card.run.cost_usd).toBeGreaterThan(0);
  });

  test("accepting the merge carries the absorbed priority's milestone and session onto the survivor", async () => {
    const { w, d } = await posted();
    await answer(w, d, [0]);
    const evalsNow = await row(w, "pri-1");
    expect([(await row(w, "pri-2")).status, evalsNow.steps.map((s) => [s.key, s.title])]).toEqual(["merged", [["s1", "Grader faults under 5%"], ["s2", "Calibrate the grader"]]]);
    expect(await w.conversation(w.oldConv)).toMatchObject({ priority_id: evalsNow._id, priority_step_key: "s2" });
    expect(await outcome(w, d._id)).toMatchObject({ accepted: [(d.priority_card as PriorityCard).changes[0].id], skipped: [] });
  });

  test("a merge declined is never proposed again, and the next prompt names it", async () => {
    for (const decline of ["dismiss", "untick"] as const) {
      const { w, d } = await posted();
      if (decline === "dismiss") await w.t.run((ctx) => finalizeAnswer(ctx as any, d, { status: "dismissed" }, ANA(w), { deliver: false }));
      else await w.t.run(async (ctx) => {
        await ctx.db.patch(d._id, { status: "answered", answer_text: "keep them apart" });
        await settleClientResolution(ctx as any, d, { status: "answered", answer_text: "keep them apart" }, w.ana, Date.now());
      });
      await w.send(w.ana, w.teamConv, Date.now(), "calibrating the grader again today");
      await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true });
      expect(await cards(w)).toHaveLength(1);
      expect((await row(w, "pri-2")).status).toBe("active");
      expect(model.prompts.at(-1)).toContain(`# Merges the person declined (never merge these two, either way round)\n- pri-2 "Grader calibration" and pri-1 "Evals people trust"`);
    }
  });

  test("a merge into a new priority waits whole: nothing of it is written; accepting makes it and merges; declining leaves nothing", async () => {
    const grading = () => reply({ title: "Grading", summary: "new", status: "active", serves: null, rank: 1, merges: ["pri-2"], steps: [{ key: "pri-2/s1", title: "Calibrate the grader", tier: "critical", refs: [] }, { title: "Grade essays", tier: "critical", refs: [] }], sessions: [{ session: "jx7old", step: "pri-2/s1" }, { session: "jx7team", step: "Grade essays" }] });
    for (const answerIt of [true, false]) {
      const w = await graderWorld();
      await cardsOn(w);
      model.reply = grading;
      await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
      // Nothing of it: no Grading, Grader calibration as it was, both sessions where they were.
      expect((await rows(w)).some((p) => p.title === "Grading")).toBe(false);
      expect((await row(w, "pri-2")).status).toBe("active");
      expect((await w.conversation(w.teamConv))?.priority_id).toBe((await row(w, "pri-1"))._id);
      const [d] = await cards(w);
      expect((d.priority_card as PriorityCard).changes.map((c) => [c.kind, c.priority, c.target, c.parent])).toEqual([["merge", "new-1", "pri-2", undefined]]);
      expect(d.question).toBe("Merge “Grader calibration” into “Grading”?");
      if (answerIt) {
        await answer(w, d, [0]);
        const made = (await rows(w)).find((p) => p.title === "Grading")!;
        expect([(await row(w, "pri-2")).status, made.steps.map((s) => s.title)]).toEqual(["merged", ["Grade essays", "Calibrate the grader"]]);
        expect((await w.conversation(w.oldConv))?.priority_id).toBe(made._id);
        expect((await w.conversation(w.teamConv))?.priority_id).toBe(made._id);
      } else {
        await w.t.run((ctx) => finalizeAnswer(ctx as any, d, { status: "dismissed" }, ANA(w), { deliver: false }));
        expect((await rows(w)).some((p) => p.title === "Grading")).toBe(false);
        // Declined: the same new priority absorbing it is not proposed again.
        await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true });
        expect(await cards(w)).toHaveLength(1);
        expect(model.prompts.at(-1)).toContain(`- pri-2 "Grader calibration" and a new priority "grading"`);
      }
    }
  });

  test("a milestone the survivor would carry is held back by the same match the merge makes, by its task as much as its words", async () => {
    const w = await world();
    await seed(w, [
      create(w.now, "new-1", "Trusted evals", 1, [step("s1", "Grader faults under 10%")]),
      create(w.now, "new-2", "Grader calibration", 2, [{ ...step("s1", "Calibrate grader"), refs: [{ kind: "task", id: "ct-7" }] }, { ...step("s2", "Benchmark nightly"), dropped: true }]),
      create(w.now, "new-3", "Docs", 3),
    ], [{ session: "jx7team", priority: "new-1", step_key: "s1" }, { session: "jx7old", priority: "new-2", step_key: "s1" }]);
    await w.send(w.ana, w.teamConv, w.now - H, TYPED);
    await cardsOn(w);
    // No key: the step matches pri-2/s1 by its task; another repeats a milestone the person dropped on Grader calibration.
    model.reply = () => reply(evals({ steps: [{ key: "s1", title: "Grader faults under 5%", tier: "critical", refs: [] }, { title: "Grader calibration", tier: "critical", refs: [{ kind: "task", id: "ct-7" }] }, { title: "Benchmark nightly", tier: "polish", refs: [] }], sessions: [{ session: "jx7team", step: "s1" }] }));
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    expect((await row(w, "pri-1")).steps.map((s) => s.title)).toEqual(["Grader faults under 5%"]);
    expect(await cards(w)).toHaveLength(1);
  });

  test("a session the reply moves off the absorbed priority to an unrelated one moves at once; one it puts on the survivor waits", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    await w.t.run(async (ctx) => {
      const grader = (await ctx.db.query("priorities").collect()).find((p) => p.short_id === "pri-2")!;
      await ctx.db.patch(w.personalConv, { team_id: w.acme, is_private: false, team_visibility: "full", priority_id: grader._id, priority_step_key: "s1", priority_set_by: "pass" } as any);
    });
    await w.send(w.ana, w.personalConv, w.now - H, "the docs need a pass");
    model.reply = () => reply(evals(), { short_id: "pri-3", title: "Docs", summary: "", status: "active", serves: null, rank: 3, steps: [], sessions: [{ session: "jx7mine" }] });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    expect((await w.conversation(w.personalConv))?.priority_id).toBe((await row(w, "pri-3"))._id);
    expect((await w.conversation(w.oldConv))?.priority_id).toBe((await row(w, "pri-2"))._id);
  });

  test("accepting is the person's own merge of the absorbed priority as it stands then: a milestone it gained since comes too, none twice", async () => {
    const { w, d } = await posted();
    const grader = await row(w, "pri-2");
    const evalsNow = await row(w, "pri-1");
    await w.t.run(async (ctx) => {
      await ctx.db.patch(grader._id, { steps: [...grader.steps, step("s2", "Grader faults under 5%"), step("s3", "Publish the rubric")], step_key_max: 3 });
    });
    await answer(w, d, [0]);
    const after = await row(w, "pri-1");
    expect(after.steps.map((s) => s.title)).toEqual([...evalsNow.steps.map((s) => s.title), "Calibrate the grader", "Publish the rubric"]);
    expect((await row(w, "pri-2")).status).toBe("merged");
  });

  test("a decline outlives hundreds of other decisions answered since", async () => {
    const { w, d } = await posted();
    await w.t.run((ctx) => finalizeAnswer(ctx as any, d, { status: "dismissed" }, ANA(w), { deliver: false }));
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 400; i++) {
        for (const status of ["answered", "dismissed"] as const) {
          await ctx.db.insert("session_decisions", { conversation_id: w.oldConv, session_id: "jx7old", user_id: w.ana, question: `q${i}`, options: [{ label: "A" }], blocking: true, status, created_at: Date.now() + 1 + i, resolved_at: Date.now() + 1 + i } as any);
        }
      }
    });
    await tick();
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true });
    expect(await cards(w)).toHaveLength(1);
    expect((await row(w, "pri-2")).status).toBe("active");
  });

  test("a merge goes stale when either priority was set aside or merged by hand since: accepting it writes nothing", async () => {
    for (const change of ["absorbed set aside", "survivor set aside", "absorbed merged by hand"] as const) {
      const { w, d } = await posted();
      const target = change.startsWith("survivor") ? await row(w, "pri-1") : await row(w, "pri-2");
      await w.t.run((ctx) => ctx.db.patch(target._id, change.endsWith("merged by hand") ? { status: "merged", status_set_by: "person" } : { status: "set_aside" }));
      await answer(w, d, [0]);
      expect((await row(w, "pri-1")).steps.map((s) => s.title)).toEqual(["Grader faults under 5%"]);
      expect(await outcome(w, d._id)).toMatchObject({ accepted: [], skipped: [(d.priority_card as PriorityCard).changes[0].id] });
    }
  });

  test("on, proposing nothing posts no card", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    model.reply = () => reply();
    expect((await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team })).status).toBe("ok");
    expect(await cards(w)).toEqual([]);
  });

  test("a merge already on an open card is not proposed again", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    model.reply = () => reply(evals());
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true });
    expect(await cards(w)).toHaveLength(1);
  });

  test("it sits in the person's own most recent session in the workspace, never a teammate's, the workspace agent's included", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    await w.t.run(async (ctx) => {
      await ctx.db.insert("anchors", { scope_type: "team", team_id: w.acme, bot_user_id: w.ben, host_user_id: w.ben, conversation_id: w.benConv, name: "Acme agent", status: "active", created_at: 1 });
      await ctx.db.patch(w.teamConv, { updated_at: w.now });
    });
    model.reply = () => reply(evals());
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
    model.reply = () => reply(evals());
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    const [d] = await cards(w);
    expect(d.conversation_id).toBe(w.teamConv);
    // In Ana's queue (a stacked ask with her inbox row), but it lifts no session as asking, hers or anyone's.
    expect([isStackedAsk(d), liftsAskingSession(d)]).toEqual([true, false]);
    const asking = (u: Id<"users">) => w.t.run(async (ctx) => [...(await loadPendingDecisionConvIds(ctx, u))]);
    expect(await asking(w.ana)).toEqual([]);
    // No phone rings, nothing is sent into the session, and its row is untouched but for the run's own placement of it.
    expect(ringsPhone(d)).toBe(false);
    expect(await w.t.run((ctx) => ctx.db.query("pending_messages").collect())).toEqual([]);
    const { priority_step_key: _a, updated_at: _b, ...was } = before as any;
    const { priority_step_key: _c, updated_at: _d, ...now } = (await w.conversation(w.teamConv)) as any;
    expect(now).toEqual(was);
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
    const { w, d } = await posted();
    await w.t.run(async (ctx) => {
      await ctx.db.patch(d.conversation_id, { user_id: w.ben });
      await reroutePendingDecisionsForConversation(ctx as any, d.conversation_id, Date.now());
    });
    const after = (await w.t.run((ctx) => ctx.db.get(d._id)))!;
    expect(after.asked_user_ids).toEqual([w.ana]);
  });

  test("a run that read the priorities before a card was answered writes nothing: the answer stands, the cursor stays", async () => {
    const { w, d } = await posted();
    const stale = await row(w, "pri-1");
    await tick();
    // A run starts reading here; the card is answered while it reads.
    const started_at = Date.now();
    await tick();
    await answer(w, d, [0]);
    const answered = await row(w, "pri-1");
    const plan = { creates: [], updates: [{ short_id: "pri-1", patch: { steps: stale.steps, summary: "stale" }, seen_steps: stale.steps.map((s) => s.key) }], merges: [], sessions: [], unmap: [], notes: [], rewritten: [] };
    const result = await w.t.mutation(pass.applyPlan, { user_id: w.ana, workspace: w.team, started_at, from_cursor: 7, cursor_at: started_at, model: "m", plan, cards_on: true });
    expect(result).toBeNull();
    const after = await row(w, "pri-1");
    expect([after.summary, after.steps.map((s) => s.title)]).toEqual([answered.summary, ["Grader faults under 5%", "Calibrate the grader"]]);
    expect(await w.latestRun()).toMatchObject({ status: "skipped", error: "superseded", cursor_at: 7 });
  });

  test("the corrections a run read are applied at once, as without the experiment, whether or not it posts a card", async () => {
    for (const merging of [true, false]) {
      const w = await graderWorld();
      await cardsOn(w);
      const g = await row(w, "pri-1");
      const id = await w.t.run((ctx) => ctx.db.insert("priority_corrections", { user_id: w.ana, workspace: w.team, priority_id: g._id, text: "Calibration is part of grading", status: "pending", created_at: w.now - 2 * H, snapshot: { short_id: g.short_id, title: g.title, summary: g.summary, status: g.status, steps: g.steps } }));
      model.reply = () => reply(merging ? evals() : evals({ merges: undefined }));
      await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
      expect(await cards(w)).toHaveLength(merging ? 1 : 0);
      expect((await w.t.run((ctx) => ctx.db.get(id)))!.status).toBe("applied");
    }
  });
});

describe("the card stays the person's (the rule on isPriorityCard)", () => {
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
    await answer(w, after, [0]);
    expect((await row(w, "pri-2")).status).toBe("merged");
  });

  test("it never sits in a hosted assistant's session, a run's, or a killed or closed one", async () => {
    const w = await graderWorld();
    await cardsOn(w);
    await w.t.run(async (ctx) => {
      await ctx.db.insert("conversations", { user_id: w.ana, agent_type: "claude_code", session_id: "jx7runl", short_id: "jx7runl", title: "Run log", team_id: w.acme, is_private: false, team_visibility: "full", started_at: w.now, updated_at: w.now + 4, message_count: 1, status: "active", is_workflow_primary: true, workflow_run_id: "run-1" } as any);
      await ctx.db.insert("conversations", { user_id: w.ana, agent_type: "codecast", session_id: "jx7host", short_id: "jx7host", title: "Assistant", team_id: w.acme, is_private: false, team_visibility: "full", started_at: w.now, updated_at: w.now + 3, message_count: 1, status: "active" } as any);
      await ctx.db.patch(w.teamConv, { updated_at: w.now + 2, inbox_killed_at: w.now });
      await ctx.db.patch(w.oldConv, { updated_at: w.now + 1, inbox_closed_at: w.now, inbox_dismissed_at: w.now });
      // Ben's session is newer still, and the team's: never his.
      await ctx.db.patch(w.benConv, { updated_at: w.now + 5 });
      await ctx.db.insert("conversations", { user_id: w.ana, agent_type: "claude_code", session_id: "jx7open", short_id: "jx7open", title: "Session jx7open", team_id: w.acme, is_private: false, team_visibility: "full", started_at: w.now, updated_at: w.now, message_count: 1, status: "active" } as any);
    });
    model.reply = () => reply(evals());
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
    model.reply = () => reply(evals());
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
    model.reply = () => reply(evals());
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team });
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true });
    expect(await cards(w)).toHaveLength(1);
  });

  test("the next card counts the runs since the last one, however many other decisions the person answered between", async () => {
    const { w, d: first } = await posted();
    await w.t.run((ctx) => finalizeAnswer(ctx as any, first, { status: "dismissed" }, ANA(w), { deliver: false }));
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 250; i++) {
        await ctx.db.insert("session_decisions", { conversation_id: w.oldConv, session_id: "jx7old", user_id: w.ana, question: `q${i}`, options: [{ label: "A" }], blocking: true, status: "dismissed", created_at: Date.now() + 1 + i, resolved_at: Date.now() + 1 + i } as any);
      }
    });
    await tick();
    // Another merge: Docs into Trusted evals.
    model.reply = () => reply(evals({ merges: ["pri-3"], steps: [{ key: "s1", title: "Grader faults under 5%", tier: "critical", refs: [] }], sessions: [{ session: "jx7team", step: "s1" }] }));
    await w.t.action(pass.runPass, { user_id: w.ana, workspace: w.team, force: true });
    const second = (await cards(w)).find((d) => d._id !== first._id)!;
    expect((second.priority_card as PriorityCard).changes.map((c) => c.target)).toEqual(["pri-3"]);
    expect((second.priority_card as PriorityCard).run.runs_since_last_card).toBe(1);
  });
});

describe("who may answer and read the card", () => {
  test("only its person answers or dismisses it; an agent answering for them, or a teammate, is refused", async () => {
    const { w, d } = await posted();
    const ben = { kind: "user" as const, id: String(w.ben), user_id: w.ben };
    for (const [verdict, by] of [[{ status: "dismissed" as const }, ben], [{ status: "answered" as const, answer_json: [0], answer_index: 0 }, ben], [{ status: "answered" as const, answer_json: [0], answer_index: 0 }, { ...ANA(w), via: w.oldConv }]] as const) {
      await expect(w.t.run((ctx) => finalizeAnswer(ctx as any, d, verdict as any, by as any, { deliver: false }))).rejects.toThrow(PRIORITY_CARD_REFUSED);
    }
    expect((await w.t.run((ctx) => ctx.db.get(d._id)))?.status).toBe("pending");
    expect((await row(w, "pri-2")).status).toBe("active");
  });

  test("a teammate who can read the session does not receive the decision at all; its person reads it whole", async () => {
    const { w, d } = await posted();
    await w.t.run(async (ctx) => ctx.db.insert("api_tokens", { user_id: w.ben, token_hash: await hashToken(TOKEN), name: "cli", created_at: 1, last_used_at: 1 } as any));
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
    await answer(w, d, [0]);
    expect((await ana.query(api.sessionDecisions.findByAnswer, { conversation_id: w.teamConv, answer: d.options[0].label }))?._id).toBe(d._id);
    expect(await ben.query(api.sessionDecisions.findByAnswer, { conversation_id: w.teamConv, answer: d.options[0].label })).toBeNull();
  });
});

describe("answering the card", () => {
  test("none, or a dismissal: nothing is written", async () => {
    const { w, d } = await posted();
    const before = await rows(w);
    await w.t.run(async (ctx) => {
      await ctx.db.patch(d._id, { status: "answered", answer_json: [] });
      await settleClientResolution(ctx as any, d, { status: "answered", answer_json: [] }, w.ana, Date.now());
    });
    expect((await rows(w)).map((p) => [p.status, p.steps])).toEqual(before.map((p) => [p.status, p.steps]));
    expect(await outcome(w, d._id)).toMatchObject({ accepted: [], skipped: [] });

    const other = await posted();
    const was = await rows(other.w);
    await other.w.t.run((ctx) => finalizeAnswer(ctx as any, other.d, { status: "dismissed" }, ANA(other.w), { deliver: false }));
    expect((await rows(other.w)).map((p) => [p.status, p.steps])).toEqual(was.map((p) => [p.status, p.steps]));
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
    expect((await row(w, "pri-2")).status).toBe("active");
    const g = await row(w, "pri-1");
    const corrections = await w.t.run((ctx) => ctx.db.query("priority_corrections").collect());
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({ priority_id: g._id, status: "pending", user_id: w.ana, workspace: w.team });
    expect(corrections[0].text).toContain(d.short_id!);
    expect(corrections[0].text).toContain("Merge: absorbs Grader calibration");
    expect(corrections[0].text.endsWith(words)).toBe(true);
    const { input } = await w.t.query(pass.passInputs, { user_id: w.ana, workspace: w.team });
    expect(input.corrections?.map((c: any) => c.text)).toEqual([corrections[0].text]);
    expect(await outcome(w, d._id)).toMatchObject({ accepted: [], skipped: [], text: words });
  });
});

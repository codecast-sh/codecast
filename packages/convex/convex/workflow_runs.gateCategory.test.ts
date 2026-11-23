// Who may answer a run's decision (docs/architecture/decisions-as-documents.md D1): a gate's own ask, the card a
// gate adopts from its presenting station, and the runner's failure card fall back to a person when the flow declares
// no category; a re-ask or an edit keeps the category a card has, and a run's card is only ever tightened.
import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { pauseAtGateCore } from "./workflow_runs";
import { askCore, edit } from "./sessionDecisions";
import { isHumanOnlyCategory } from "./lib/decisionCategory";
import { HOST, TEAM, TOKEN, RUN, seed, pause } from "./workflow_runs.gate.testkit";

// A station hand as spawn.ts makes one: a random session id, its short id the row id's head, nested under the run's
// log (conversations_primary in the testkit). The runner reports it to the gate by that short id.
const STATION_SESSION = randomUUID();
const station = { _id: "conversations_card", session_id: STATION_SESSION, short_id: "conver1", parent_conversation_id: "conversations_primary", user_id: HOST, team_id: TEAM, message_count: 40 };
const cardChoices = [
  { key: "S", label: "[S] Ship", target: "trial_ship" },
  { key: "R", label: "[R] Revise", target: "revise_build" },
  { key: "D", label: "[D] Drop", target: "trial_drop" },
];
const stationAsks = (ctx: any, extra: Record<string, unknown> = {}) =>
  askCore(ctx, { userId: HOST }, { session_id: STATION_SESSION, question: "Ship it?", options: [{ label: "Ship it" }, { label: "Drop it" }], blocking: true, ...extra });
const gate = (ctx: any, extra: Record<string, unknown> = {}) =>
  pauseAtGateCore(ctx, { userId: HOST }, { run_id: RUN as any, node_id: "decide", prompt: "Ship this change?", choices: cardChoices, asker_session_id: "conver1", ...extra });
const editAs = (ctx: any, id: string, fields: Record<string, unknown>) => (edit as any)._handler(ctx, { api_token: TOKEN, decision_id: id, ...fields });

describe("a run's decisions are a person's unless the flow says otherwise", () => {
  test("a gate that declares no category asks a person, and so does the runner's failure card", async () => {
    const { ctx, tables } = await seed();
    await pause(ctx);
    expect(tables.session_decisions[0].category).toBe("unknown");
    expect(tables.session_decisions[0].holder.kind).toBe("user");
    // runner.ts queueTaskDecision: /cli/decide from the spawner, bound to the run, with no category.
    const failed = await askCore(ctx, { userId: HOST }, {
      session_id: "sess-spawner",
      task: "ct-7",
      workflow_run_id: RUN as any,
      gate_node_id: "implement",
      question: "Ship the thing: retries exhausted. What next?",
      options: [{ label: "Reopen for another implement round" }, { label: "Drop the task" }, { label: "I will take it myself" }],
      context_md: "The build failed three times.",
      blocking: true,
    });
    expect(failed.category).toBe("unknown");
    expect(isHumanOnlyCategory(failed.category)).toBe(true);
  });

  test("a station's card is a person's from the moment it is posted, even proposed as review", async () => {
    for (const proposed of [undefined, "review"]) {
      const { ctx, tables } = await seed();
      tables.conversations.push(station);
      await stationAsks(ctx, proposed ? { category: proposed } : {});
      expect(tables.session_decisions[0].category).toBe("unknown");
    }
    const { ctx, tables } = await seed();
    tables.conversations.push(station);
    await stationAsks(ctx, { category: "production" });
    expect(tables.session_decisions[0].category).toBe("production");
  });

  test("a run launched from the composer: its host session is the primary, and its stations' cards are a person's while it runs", async () => {
    const { ctx, tables } = await seed();
    // useWorkflowLaunch passes existing_conversation_id: the person's session hosts the run with only workflow_run_id.
    tables.conversations.push({ _id: "conversations_host", session_id: "sess-host", user_id: HOST, team_id: TEAM, message_count: 9, workflow_run_id: RUN });
    tables.workflow_runs[0].primary_conversation_id = "conversations_host";
    tables.conversations.push({ ...station, parent_conversation_id: "conversations_host" });
    await stationAsks(ctx);
    expect(tables.session_decisions[0].category).toBe("unknown");
    // Once the run ends, a worker of the host session asks as an ordinary agent.
    tables.workflow_runs[0].status = "completed";
    await stationAsks(ctx, { question: "Which parser?" });
    expect(tables.session_decisions[1].category).toBe("review");
  });

  test("a gate only tightens: a person's category the station named stands under a review gate", async () => {
    const { ctx, tables } = await seed();
    tables.conversations.push(station);
    await stationAsks(ctx, { category: "production" });
    await gate(ctx, { category: "review" });
    expect(tables.session_decisions[0].category).toBe("production");
  });

  test("the gate sets who may answer the card it adopts: its declared category, else a person", async () => {
    for (const [declared, expected] of [[undefined, "unknown"], ["production", "production"], ["review", "review"]] as const) {
      const { ctx, tables } = await seed();
      tables.conversations.push(station);
      await stationAsks(ctx);
      expect((await gate(ctx, declared ? { category: declared } : {}) as any)?.error).toBeUndefined();
      const row = tables.session_decisions[0];
      expect(tables.workflow_runs[0].gate_decision_id).toBe(row._id);
      expect(row.category).toBe(expected);
      expect(isHumanOnlyCategory(row.category)).toBe(expected !== "review");
      expect(row.holder.kind).toBe("user");
    }
  });

  test("a station's re-ask keeps the gate's category, and its own --category may only tighten it", async () => {
    const { ctx, tables } = await seed();
    tables.conversations.push(station);
    await stationAsks(ctx);
    await gate(ctx);
    expect(tables.session_decisions[0].category).toBe("unknown");
    await stationAsks(ctx, { context_md: "One more case." });
    await stationAsks(ctx, { category: "review" });
    expect(tables.session_decisions).toHaveLength(1);
    expect(tables.session_decisions[0].category).toBe("unknown");
    await stationAsks(ctx, { category: "production" });
    expect(tables.session_decisions[0].category).toBe("production");
  });

  test("cast decide edit on a run's card may only tighten it", async () => {
    const { ctx, tables } = await seed();
    const r: any = await pause(ctx);
    const id = String(tables.session_decisions[0]._id);
    expect(r.ok).toBe(true);
    expect((await editAs(ctx, id, { category: "review" })).error).toBeUndefined();
    expect(tables.session_decisions[0].category).toBe("unknown");
    expect((await editAs(ctx, id, { category: "production" })).error).toBeUndefined();
    expect(tables.session_decisions[0].category).toBe("production");
  });
});

describe("an agent's own card", () => {
  test("a re-ask and an edit without --category keep its category; an edit with one sets it", async () => {
    const { ctx, tables } = await seed();
    const ask = (extra: Record<string, unknown> = {}) =>
      askCore(ctx, { userId: HOST }, { session_id: "sess-spawner", question: "Drop the old table?", options: [{ label: "Drop it" }, { label: "Keep it" }], ...extra });
    const posted = await ask({ category: "production" });
    await ask({ context_md: "It has been empty since March." });
    expect(tables.session_decisions).toHaveLength(1);
    expect(tables.session_decisions[0].category).toBe("production");
    expect((await editAs(ctx, String(posted.id), { context_md: "Still empty." })).error).toBeUndefined();
    expect(tables.session_decisions[0].category).toBe("production");
    expect((await editAs(ctx, String(posted.id), { category: "scope" })).error).toBeUndefined();
    expect(tables.session_decisions[0].category).toBe("scope");
  });

  test("no category is review; a word outside the vocabulary is a person's", async () => {
    const { ctx } = await seed();
    const ask = (question: string, category?: string) =>
      askCore(ctx, { userId: HOST }, { session_id: "sess-spawner", question, options: [{ label: "Yes" }, { label: "No" }], ...(category ? { category } : {}) });
    expect((await ask("Which parser?")).category).toBe("review");
    for (const word of ["deploy", "security", "money"]) expect((await ask(`Q ${word}?`, word)).category).toBe("unknown");
  });
});

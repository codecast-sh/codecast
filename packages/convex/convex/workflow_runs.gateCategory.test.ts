// Who may answer a run's decision (docs/architecture/decisions-as-documents.md D1): a gate's own ask, the card a
// gate adopts from its presenting station, and the runner's failure card fall back to a person when the flow declares
// no category; an edit keeps the category a row has.
import { describe, expect, test } from "bun:test";
import { pauseAtGateCore } from "./workflow_runs";
import { askCore, edit } from "./sessionDecisions";
import { isHumanOnlyCategory } from "./lib/decisionCategory";
import { HOST, TEAM, TOKEN, RUN, seed, pause } from "./workflow_runs.gate.testkit";

const station = { _id: "conversations_card", session_id: "sess-card", user_id: HOST, team_id: TEAM, message_count: 40 };
const cardChoices = [
  { key: "S", label: "[S] Ship", target: "trial_ship" },
  { key: "R", label: "[R] Revise", target: "revise_build" },
  { key: "D", label: "[D] Drop", target: "trial_drop" },
];

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

  test("the gate sets who may answer the card it adopts: its declared category, else a person", async () => {
    for (const [declared, expected] of [[undefined, "unknown"], ["production", "production"], ["review", "review"]] as const) {
      const { ctx, tables } = await seed();
      tables.conversations.push(station);
      // A presenting station posts a plain cast decide, with no category.
      await askCore(ctx, { userId: HOST }, { session_id: "sess-card", question: "Ship it?", options: [{ label: "Ship it" }, { label: "Drop it" }], blocking: true });
      expect(tables.session_decisions[0].category).toBe("review");
      await pauseAtGateCore(ctx, { userId: HOST }, { run_id: RUN as any, node_id: "decide", prompt: "Ship this change?", choices: cardChoices, asker_session_id: "sess-card", ...(declared ? { category: declared } : {}) });
      const row = tables.session_decisions[0];
      expect(row.category).toBe(expected);
      expect(isHumanOnlyCategory(row.category)).toBe(expected !== "review");
      expect(row.holder.kind).toBe("user");
    }
  });

  test("a card a run's station posts without a category is a person's before any gate takes it up, and keeps the gate's on a re-ask", async () => {
    const { ctx, tables } = await seed();
    tables.conversations.push({ ...station, workflow_run_id: RUN, is_workflow_sub: true });
    const ask = () => askCore(ctx, { userId: HOST }, { session_id: "sess-card", question: "Ship it?", options: [{ label: "Ship it" }, { label: "Drop it" }], blocking: true });
    await ask();
    expect(tables.session_decisions[0].category).toBe("unknown");
    await pauseAtGateCore(ctx, { userId: HOST }, { run_id: RUN as any, node_id: "decide", prompt: "Ship this change?", choices: cardChoices, asker_session_id: "sess-card", category: "review" });
    expect(tables.session_decisions[0].category).toBe("review");
    await ask();
    expect(tables.session_decisions).toHaveLength(1);
    expect(tables.session_decisions[0].category).toBe("review");
  });

  test("cast decide edit keeps a row's category unless it names a new one", async () => {
    const { ctx, tables } = await seed();
    const posted = await askCore(ctx, { userId: HOST }, { session_id: "sess-spawner", question: "Drop the old table?", options: [{ label: "Drop it" }, { label: "Keep it" }], category: "approach" });
    // A pending row asked while card words still pinned a category.
    Object.assign(tables.session_decisions[0], { category: "data" });
    const edit_ = (fields: Record<string, any>) => (edit as any)._handler(ctx, { api_token: TOKEN, decision_id: String(posted.id), ...fields });
    expect((await edit_({ context_md: "It has been empty since March." })).error).toBeUndefined();
    expect(tables.session_decisions[0].category).toBe("data");
    expect((await edit_({ category: "scope" })).error).toBeUndefined();
    expect(tables.session_decisions[0].category).toBe("scope");
  });
});

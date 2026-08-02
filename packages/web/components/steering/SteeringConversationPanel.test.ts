import { describe, expect, test } from "bun:test";
import { buildSteeringContext } from "./SteeringConversationPanel";

const item = (fields: Record<string, any>) => ({
  _id: fields._id,
  _creationTime: 1,
  user_id: "u1",
  short_id: fields.short_id ?? fields._id,
  kind: fields.kind ?? "objective",
  title: fields.title,
  status: fields.status ?? "active",
  priority: "none",
  created_at: 1,
  updated_at: 1,
  ...fields,
});

describe("buildSteeringContext", () => {
  test("grounds the agent in lineage, children, strategy, links, and trust boundary", () => {
    const objective = item({ _id: "o1", title: "Repeatable demand" });
    const bet = item({
      _id: "b1",
      kind: "bet",
      title: "Persistent partners work",
      parent_item_id: "o1",
      hypothesis: "Teams make better decisions with durable context",
    });
    const question = item({
      _id: "q1",
      kind: "question",
      title: "Does judgment improve?",
      parent_item_id: "b1",
      why_it_matters: "Recall alone is not enough",
    });
    const initiative = item({
      _id: "i1",
      kind: "initiative",
      title: "Dogfood three decisions",
      parent_item_id: "q1",
    });
    const context = buildSteeringContext({
      type: "steering_item",
      entity: question,
      items: [objective, bet, question, initiative] as any,
      strategy: { title: "Trustworthy operating partners", status: "active" },
      linkedExecution: ["investigates: Plan Steering dogfood"],
      relationships: ["outgoing tests: Bet Persistent partners work"],
    });

    expect(context).toContain("reason deeply");
    expect(context).toContain("Never mutate Strategy or Steering Items autonomously");
    expect(context).toContain("objective: Repeatable demand");
    expect(context).toContain("bet: Persistent partners work");
    expect(context).toContain("initiative: Dogfood three decisions");
    expect(context).toContain("Current Strategy: Trustworthy operating partners");
    expect(context).toContain("investigates: Plan Steering dogfood");
    expect(context).toContain("outgoing tests: Bet Persistent partners work");
  });

  test("does not claim inferred evidence or execution", () => {
    const objective = item({ _id: "o1", title: "Repeatable demand" });
    const context = buildSteeringContext({
      type: "steering_item",
      entity: objective,
      items: [objective] as any,
    });
    expect(context).toContain("Do not infer priorities, attention, progress, evidence, or health");
    expect(context).toContain("Explicitly linked execution: none visible");
  });
});

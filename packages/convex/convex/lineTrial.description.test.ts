// A trial problem's description, written from its strongest finding, follows
// the findings as they move (signals.refreshCauseDescription).
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { causeDescription, refreshCauseDescription } from "./signals";

const TEAM = "teams_acme" as any;

describe("a problem's description follows its findings", () => {
  const W = `team:${TEAM}`;
  const seed = (detail: string) => causeDescription({ kind: "prompt_miss", source: "judge:comms", detail_md: detail });
  const tasks = () => [
    { _id: "tasks_a", short_id: "ct-7", workspace: W, title: "missed-call emails", status: "open", description: seed("Steve: we never connected and that's on us.") },
    { _id: "tasks_b", short_id: "ct-8", workspace: W, title: "edited", status: "open", description: "A person's own words." },
  ];
  const signals = [
    { _id: "s1", short_id: "sg-1", workspace: W, kind: "prompt_miss", source: "judge:comms", detail_md: "Steve: we never connected and that's on us.", severity: 9, observed_at: 1, task_id: "tasks_c" },
    { _id: "s2", short_id: "sg-2", workspace: W, kind: "prompt_miss", source: "judge:comms", detail_md: "Sorry we missed you, just wanted to try you.", severity: 6, observed_at: 2, task_id: "tasks_a" },
    { _id: "s3", short_id: "sg-3", workspace: W, kind: "prompt_miss", source: "judge:comms", detail_md: "We tried calling, no news yet.", severity: 7, observed_at: 1, task_id: "tasks_a" },
  ];
  test("once the finding it was written from leaves, it is written from the strongest finding left", async () => {
    const db = makeFakeDb({ tasks: tasks(), signals });
    expect(await refreshCauseDescription({ db } as any, "tasks_a" as any, [signals[0] as any])).toBe(true);
    expect((await db.get("tasks_a" as any)).description).toBe(seed("We tried calling, no news yet."));
  });
  test("a description a person wrote, or one whose finding did not leave, stays", async () => {
    const db = makeFakeDb({ tasks: tasks(), signals });
    expect(await refreshCauseDescription({ db } as any, "tasks_b" as any, [signals[0] as any])).toBe(false);
    expect(await refreshCauseDescription({ db } as any, "tasks_a" as any, [signals[1] as any])).toBe(false);
  });
});

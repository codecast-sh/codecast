import { describe, expect, test } from "bun:test";
import { decisionQueueItems, waitingOnPerson } from "../decisionQueue";

// A row a role holds under a grant stays pending in the person's inbox (they
// may still answer first) but it is the lead's to clear: the Questions badge
// and "waiting on you" leave it out while the queue lists it under "With a lead".
const row = (id: string, extra: Record<string, any> = {}) => ({
  _id: id, conversation_id: `c-${id}`, session_id: "s", question: id, options: [{ label: "A" }],
  blocking: true, status: "pending" as const, created_at: 1, ...extra,
});

describe("waitingOnPerson", () => {
  test("drops rows a role holds, keeps the rest", () => {
    const items = decisionQueueItems(
      { a: row("a"), b: row("b", { holder: { kind: "role", id: "r1" } }), c: row("c", { holder: { kind: "user", id: "u1" } }) } as any,
      {},
    );
    expect(items.map((i) => `${i.decisionId}:${i.heldByRole}`).sort()).toEqual(["a:false", "b:true", "c:false"]);
    expect(waitingOnPerson(items).map((i) => i.decisionId).sort()).toEqual(["a", "c"]);
  });
});

import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { recordSuggestionOutcome } from "./composerSuggestions";

// Pills are the owner's alone, and so is the report of what became of one.

const ANA = "users_ana";
const BEN = "users_ben";

function world() {
  return makeFakeDb({
    users: [{ _id: ANA }, { _id: BEN }],
    conversations: [{ _id: "conv_1", user_id: ANA, is_private: false }],
    suggestion_outcomes: [],
  });
}
const report = (db: any, userId: string, conversation_id = "conv_1") =>
  (recordSuggestionOutcome as any)._handler(
    { db, auth: { getUserIdentity: async () => ({ subject: `${userId}|sess`, tokenIdentifier: "x" }) } },
    { conversation_id, anchor_message_uuid: "m1", suggestion: "ship it", outcome: "sent" },
  );

describe("composerSuggestions.recordSuggestionOutcome", () => {
  test("another user's session takes no outcome", async () => {
    const db = world();
    await report(db, BEN);
    await report(db, ANA, "conv_missing");
    expect(db._tables.suggestion_outcomes).toEqual([]);
  });

  test("the owner's outcome is recorded", async () => {
    const db = world();
    await report(db, ANA);
    expect(db._tables.suggestion_outcomes.length).toBe(1);
    expect(db._tables.suggestion_outcomes[0].user_id).toBe(ANA);
  });
});

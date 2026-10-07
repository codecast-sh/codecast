// When a hosted reply leaves the next move to the person (replyAsksPerson):
// the engine files the turn under Your turn and the composer reads "Reply…".
import { describe, expect, test } from "bun:test";
import { replyAsksPerson } from "./assistant";

describe("replyAsksPerson", () => {
  test("a question in the last paragraph, anywhere in it", () => {
    expect(replyAsksPerson("Here are three options.\n\nWhich one appeals to you? I'll look into it next.")).toBe(true);
    expect(replyAsksPerson("Done. I saved it as a note.")).toBe(false);
    expect(replyAsksPerson("")).toBe(false);
  });

  test("questions asked mid-reply still wait on the person, even under a sign-off", () => {
    const trip = [
      "A weekend away sounds lovely. Two things first:",
      "**Where are you starting from?** That decides how far you can go.",
      "**What's your rough budget for the whole weekend?**",
      "Once I know those, I can sketch out a plan.",
    ].join("\n\n");
    expect(replyAsksPerson(trip)).toBe(true);
    expect(replyAsksPerson("Quick check:\n\nDo you want me to keep the reason short?\n\nEither way I'll draft it after.")).toBe(true);
  });

  test("questions inside quotes, quoted lines and code are someone else's words", () => {
    expect(replyAsksPerson('I drafted your reply:\n\n> Could we move it to Friday?\n\nIt is saved as a note.')).toBe(false);
    expect(replyAsksPerson('The subject line reads "Are you free Friday?" and I filed it.\n\nNothing else came in.')).toBe(false);
    expect(replyAsksPerson("Here is the query:\n\n```\nWHERE x = ?\n```\n\nIt ran fine.")).toBe(false);
  });
});

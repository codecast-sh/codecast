import { describe, expect, it } from "bun:test";
import { hostedComposerWords, hostedLastExchange } from "../hostedComposer";

const ask = { role: "user", content: "Every weekday at 9am, remind me to stretch.", timestamp: 1_000 };
const decline = (at: number) => ({
  d1: { _id: "d1", conversation_id: "c1", status: "answered", answer_index: 1, resolved_at: at, options: [{ label: "Approve" }, { label: "Decline" }] },
}) as any;

describe("hostedLastExchange", () => {
  it("reads the last word of a hosted conversation", () => {
    expect(hostedLastExchange([], undefined, "c1", 2_000)).toBeNull();
    expect(hostedLastExchange([ask], undefined, "c1", 2_000)).toBe("sent");
    expect(hostedLastExchange([ask, { role: "assistant", content: "Done. It starts Monday." }], undefined, "c1", 2_000)).toBe("answered");
    expect(hostedLastExchange([ask, { role: "assistant", content: "Which time suits you?" }], undefined, "c1", 2_000)).toBe("asked");
  });

  it("invites a change after a no, only while the no is fresh", () => {
    expect(hostedLastExchange([ask], decline(1_500), "c1", 2_000)).toBe("declined");
    expect(hostedLastExchange([ask], decline(1_500), "c1", 1_500 + 11 * 60_000)).toBe("sent");
    // A no to another conversation's card says nothing here.
    expect(hostedLastExchange([ask], decline(1_500), "c2", 2_000)).toBe("sent");
  });
});

describe("hostedComposerWords", () => {
  it("says the web composer's resting words for each exchange", () => {
    expect(hostedComposerWords("declined", true)).toBe("Answer the card above, or tell me what to change");
    expect(hostedComposerWords("declined", false)).toBe("Tell me what to change");
    expect(hostedComposerWords("asked", false)).toBe("Reply…");
    expect(hostedComposerWords("stopped", false)).toBe("Or ask something else");
    expect(hostedComposerWords("answered", false)).toBe("Reply, or ask a follow-up");
    expect(hostedComposerWords(null, false)).toBe("Ask anything, or hand me a chore");
  });
});

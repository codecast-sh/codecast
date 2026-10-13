import { describe, expect, it } from "bun:test";
import { hostedComposerWords, hostedLastExchange } from "../hostedComposer";
import { MODE_WORDS } from "../surfaceRules";

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
    const w = MODE_WORDS.hosted;
    expect(hostedComposerWords("declined", true)).toBe(w.composerApproval);
    expect(hostedComposerWords("declined", false)).toBe(w.composerDeclined);
    expect(hostedComposerWords("asked", false)).toBe("Reply…");
    expect(hostedComposerWords("stopped", false)).toBe(w.composerAfterStop);
    expect(hostedComposerWords("answered", false)).toBe(w.composerFollowUp);
    expect(hostedComposerWords(null, false)).toBe(w.composerPlaceholder);
  });
});

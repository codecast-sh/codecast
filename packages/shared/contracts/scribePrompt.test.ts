import { describe, expect, test } from "bun:test";
import { SCRIBE_CLAIM_TTL_MS, SCRIBE_REMINDER, scribeChunkHeader, scribeInstructions, scribeStatus } from "./scribePrompt";
import { HUDDLE_REPLY_NOTE, HUDDLE_WORK_NOTE } from "./transcriptChunk";

describe("scribeInstructions", () => {
  test("a group huddle keeps the group half and drops the solo half", () => {
    const text = scribeInstructions({ solo: false });
    expect(text).toStartWith("You are the board scribe for this conversation.");
    expect(text).toContain("- **Group:** attribute every stance.");
    expect(text).not.toContain("- **Solo:**");
    expect(text).toContain("## Pace");
  });

  test("a solo huddle keeps the solo half and drops the group half", () => {
    const text = scribeInstructions({ solo: true });
    expect(text).toContain("- **Solo:** the person is thinking, not negotiating.");
    expect(text).not.toContain("- **Group:**");
  });

  test("the call id stands in for <call> only when it is known", () => {
    expect(scribeInstructions({ solo: false })).toContain("--from-call <call>");
    const known = scribeInstructions({ solo: false, callShortId: "cl-42" });
    expect(known).toContain("--from-call cl-42");
    expect(known).not.toContain("<call>");
    expect(known).toContain("<doc>");
  });

  test("the workspace is named after the opening paragraph", () => {
    const text = scribeInstructions({ solo: false, workspaceName: "Union" });
    expect(text).toContain("You draw. You do not talk.\n\nThis huddle is in the Union workspace.\n\n## What arrives");
    expect(scribeInstructions({ solo: false })).not.toContain("workspace.");
  });
});

describe("scribeStatus", () => {
  const now = 1_000_000;
  test("a scribe route is listening, whatever the claim says", () => {
    expect(scribeStatus({ routes: [{ role: "scribe" }], scribe_claim: { at: now } }, now)).toBe("listening");
  });
  test("a fresh claim is joining, a stale one is absent", () => {
    expect(scribeStatus({ routes: [{}], scribe_claim: { at: now - 1000 } }, now)).toBe("joining");
    expect(scribeStatus({ routes: [], scribe_claim: { at: now - SCRIBE_CLAIM_TTL_MS } }, now)).toBe("absent");
  });
  test("no transcript or no claim is absent", () => {
    expect(scribeStatus(null, now)).toBe("absent");
    expect(scribeStatus({ routes: [] }, now)).toBe("absent");
  });
});

describe("scribeChunkHeader", () => {
  const base = { name: "Scribe", lane: "context" as const, held: false, call: "cl-9", board: "d1" };
  const others = (h: string) => {
    expect(h).not.toContain(HUDDLE_WORK_NOTE);
    expect(h).not.toContain(HUDDLE_REPLY_NOTE);
    expect(h).not.toContain("cast publish");
  };

  test("a rebrief carries the lane, the board, the call and the reminder, and no other feed's notes", () => {
    const h = scribeChunkHeader({ ...base, full: true });
    expect(h).toContain("Nobody named you");
    expect(h).toContain("doc:d1");
    expect(h).toContain("cl-9");
    expect(h).toContain(SCRIBE_REMINDER);
    others(h);
  });

  test("between rebriefs it is one line, without the reminder", () => {
    const h = scribeChunkHeader({ ...base, lane: "ask", full: false });
    expect(h).toContain("Someone named you");
    expect(h).not.toContain("\n");
    expect(h).not.toContain(SCRIBE_REMINDER);
    others(h);
  });
});

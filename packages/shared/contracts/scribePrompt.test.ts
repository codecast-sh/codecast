import { describe, expect, test } from "bun:test";
import { SCRIBE_CLAIM_TTL_MS, scribeInstructions, scribeStatus } from "./scribePrompt";

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

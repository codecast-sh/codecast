import { describe, expect, test } from "bun:test";
import { DORMANT_CLAIM_TTL_MS } from "./agentStatus";
import { ridesLead, shelfPlacement, TRIAGE_REASONS, triageOf, triageSectionOf, triageTally, type TriageFacts } from "./triage";

const NOW = 1_800_000_000_000;
const base: TriageFacts = { messageCount: 5, updatedAt: NOW - 60_000 };
const t = (bucket: string, work_state: any, facts: Partial<TriageFacts> = {}, unread = true) =>
  triageOf({ placement: { bucket, work_state }, facts: { ...base, ...facts }, unread, now: NOW });

describe("triageOf", () => {
  test("every reason names a lane, and only you-lane reasons carry an ask", () => {
    for (const [, r] of Object.entries(TRIAGE_REASONS)) expect(r.lane === "you").toBe(r.ask !== null);
  });

  test("an explicit ask stays after it is read; a plain turn end settles on read", () => {
    expect(t("needs_input", "needs_input", { settleVerdict: "needs_input" }, false).reason).toBe("asked");
    expect(t("needs_input", "needs_input", {}, false)).toMatchObject({ lane: "settled", reason: "idle" });
    expect(t("needs_input", "needs_input", {}, true)).toMatchObject({ lane: "you", ask: "review", reason: "turn_ended" });
  });

  test("a usage limit parks, a sign-in is a fix", () => {
    expect(t("needs_input", "needs_input", { apiError: true, apiErrorKind: "limit" }).lane).toBe("parked");
    expect(t("needs_input", "needs_input", { apiError: true, apiErrorKind: "auth" })).toMatchObject({ ask: "fix", reason: "login" });
  });

  test("the shelf never changes lane or ask", () => {
    const pinned = t("pinned", "needs_input", { pinned: true, awaitingInput: true });
    expect(pinned).toMatchObject({ lane: "you", ask: "answer", shelf: "pinned" });
    expect(triageSectionOf(pinned)).toBe("pinned");
  });

  test("a stash surfaces only for an answer or a fix", () => {
    expect(triageSectionOf(t("stashed", "needs_input", { stashed: true, agentStatus: "stopped" }))).toBe("you");
    expect(triageSectionOf(t("stashed", "done", { stashed: true }))).toBe("stashed");
  });

  test("parked reasons name their wake and when it resolves", () => {
    expect(t("dormant", "dormant", { loopArmed: true, loopWakeAt: NOW + 5 })).toMatchObject({ reason: "loop", until: NOW + 5 });
    expect(t("dormant", "dormant", { agentStatus: "dormant" }).until).toBe(base.updatedAt + DORMANT_CLAIM_TTL_MS);
    expect(t("snoozed", "dormant", { snoozedUntil: NOW + 9 })).toMatchObject({ shelf: "snoozed", until: NOW + 9 });
  });

  test("the tally counts asks only where the person sees them", () => {
    const rows = [
      t("questions", "needs_input", { awaitingInput: true }),
      t("done", "done"),
      t("stashed", "done", { stashed: true }),
      t("working", "working", { agentStatus: "working" }),
    ];
    expect(triageTally(rows)).toMatchObject({ you: 2, needs_you: 2, answer: 1, review: 1, agent: 1, stashed: 1 });
  });

  test("a row filed under its lead's bucket rides it", () => {
    expect(ridesLead({ bucket: "dormant", work_state: "needs_input" })).toBe(true);
    expect(ridesLead({ bucket: "needs_input", work_state: "needs_input" })).toBe(false);
    expect(ridesLead({ bucket: "questions", work_state: "needs_input" })).toBe(false);
    expect(ridesLead(shelfPlacement("stashed"))).toBe(false);
  });
});

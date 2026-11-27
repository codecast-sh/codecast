// An idle compaction writes its summary into a parked session as a user-role
// line that nobody delivered. Neither of the daemon's turn-start readers may
// count it, or the session's dormant or done pin reads as an earlier turn's and
// the session files under Needs You with no ask (ct-102518).
import { describe, expect, test } from "bun:test";
import { declaredSettleVerdict, latestTurnStartTs, markTurnStarted, transcriptTailTurnStartTs } from "./daemon.js";

const SUMMARY = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";
const NOTICE = "Compacted while idle, before the prompt cache expired";

describe("an idle compaction starts no turn", () => {
  test("in a synced batch: the pin before it still speaks", () => {
    const sid = "idle-compaction-keeps-pin";
    const now = Date.now();
    markTurnStarted(sid, now - 600_000);
    const pin = { at: now - 300_000, status: "dormant" as const };
    const batch = [
      { role: "user", timestamp: now - 60_000, content: `${SUMMARY}\n\nSummary: …` },
      { role: "system", timestamp: now - 58_000, content: NOTICE },
    ];
    expect(latestTurnStartTs(batch)).toBeNull();
    expect(declaredSettleVerdict(sid, now, undefined, pin)).toBe("dormant");
  });

  test("in a transcript tail read after a restart: the turn before it is still the newest", () => {
    const line = (o: object) => JSON.stringify(o) + "\n";
    const T1 = "2026-08-31T10:00:00.000Z";
    const T2 = "2026-08-31T11:00:00.000Z";
    const tail =
      line({ type: "user", sessionId: "s1", timestamp: T1, message: { role: "user", content: "ship it" } }) +
      line({ type: "system", subtype: "compact_boundary", sessionId: "s1", timestamp: T2, content: "Conversation compacted" }) +
      line({ type: "user", isCompactSummary: true, sessionId: "s1", timestamp: T2, message: { role: "user", content: SUMMARY } }) +
      line({ type: "system", subtype: "informational", sessionId: "s1", timestamp: T2, content: NOTICE });
    expect(transcriptTailTurnStartTs(tail, "s1")).toBe(Date.parse(T1));
  });
});

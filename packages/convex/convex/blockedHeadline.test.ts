import { describe, expect, test } from "bun:test";
import { actedBlockedConversations, blockedHeadlineCause, blockedIncidentNotice } from "./ccAccountsShared";

const conv = (kind: string, extra: Record<string, unknown> = {}) => ({
  pending_api_error: true,
  pending_api_error_kind: kind,
  ...extra,
});

describe("blockedHeadlineCause", () => {
  // The 2026-09-06 report: every blocked session was a subagent worker parked
  // on a usage limit, and the banner read "44 sessions blocked on safety
  // review". The label came off the ACTED set, which the default checkbox had
  // emptied, so every count was zero and the first entry won by default.
  test("names the limit when the whole set is skipped subagent workers", () => {
    const fleet = Array.from({ length: 44 }, (_, i) =>
      conv("limit", { _id: `c${i}`, is_subagent: true, parent_conversation_id: "parent" }),
    );
    expect(actedBlockedConversations(fleet, false)).toEqual([]);
    expect(blockedHeadlineCause(fleet)).toBe("usage limits");
  });

  test("names the largest slice", () => {
    expect(blockedHeadlineCause([conv("auth"), conv("auth"), conv("limit")])).toBe("login");
    expect(blockedHeadlineCause([conv("safety"), conv("safety"), conv("limit")])).toBe("safety review");
    expect(blockedHeadlineCause([conv("connection"), conv("connection"), conv("auth")])).toBe("dropped connections");
    expect(blockedHeadlineCause([conv("fatal"), conv("fatal"), conv("throttle")])).toBe("api errors");
    expect(blockedHeadlineCause([conv("throttle"), conv("throttle"), conv("fatal")])).toBe("rate-limit bursts");
  });

  // A full context window is parked until /compact reaches the session: it
  // headlines when it is the largest slice, and a fleet revive leaves it out
  // exactly as it leaves out a safety stop — a continue would re-send the
  // same oversized prompt.
  test("full context windows headline and stay out of the acted set", () => {
    expect(blockedHeadlineCause([conv("context"), conv("context"), conv("limit")])).toBe("full context windows");
    expect(blockedHeadlineCause([conv("context"), conv("limit")])).toBe("usage limits");
    const full = conv("context", { _id: "full" });
    const limit = conv("limit", { _id: "limit" });
    expect(actedBlockedConversations([full, limit], false)).toEqual([limit]);
    expect(actedBlockedConversations([full, limit], true)).toEqual([limit]);
  });

  // A park with no kind recorded is the original limit shape.
  test("counts an unstamped park as a usage limit", () => {
    expect(blockedHeadlineCause([{}, {}, conv("auth")])).toBe("usage limits");
  });

  // Ties go to the ordinary cause: one safety stop beside one limit park must
  // not headline the whole fleet as a safety review.
  test("a tie never escalates to safety review", () => {
    expect(blockedHeadlineCause([conv("safety"), conv("limit")])).toBe("usage limits");
    expect(blockedHeadlineCause([conv("safety"), conv("auth")])).toBe("login");
  });
});

describe("blockedIncidentNotice", () => {
  // The 2026-11-07 push: "3 sessions blocked on login · 2 signed out · 1
  // needs safety review (1 subagent)". The safety stop was a Codex reviewer
  // worker; its parent session owns it, and the person had nothing to do.
  test("counts and anchors on top-level sessions; a parked worker is not the person's to act on", () => {
    const notice = blockedIncidentNotice([
      conv("auth", { _id: "a", updated_at: 10 }),
      conv("auth", { _id: "b", updated_at: 20 }),
      conv("safety", { _id: "w", updated_at: 30, is_subagent: true, parent_conversation_id: "b" }),
    ]);
    expect(notice).toMatchObject({
      title: "2 sessions blocked on login",
      message: "2 signed out. Sign in to revive them.",
      newestPark: 20,
    });
    expect(notice!.anchor._id).toBe("b");
  });

  test("a fleet of parked workers alone raises no push", () => {
    expect(blockedIncidentNotice([conv("safety", { is_subagent: true }), conv("limit", { parent_conversation_id: "p" })])).toBeNull();
  });

  test("a top-level safety stop says it waits for the person", () => {
    expect(blockedIncidentNotice([conv("safety", { updated_at: 1 }), conv("limit", { updated_at: 2 })])!.message)
      .toBe("1 hit a usage limit · 1 stopped for safety review. Safety stops wait for you.");
  });
});

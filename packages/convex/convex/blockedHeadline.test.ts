import { describe, expect, test } from "bun:test";
import { actedBlockedConversations, blockedHeadlineCause } from "./ccAccountsShared";

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

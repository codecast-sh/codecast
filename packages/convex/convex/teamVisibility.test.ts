import { describe, expect, test } from "bun:test";
import {
  TEAM_VISIBILITY_LEVELS,
  TEAM_VISIBILITY_RANK,
  currentMembershipVisibility,
  effectiveMembershipVisibility,
  hasPinnedPast,
  nextMembershipVisibility,
  type MembershipVisibilityFacts,
  type TeamVisibilityLevel,
  type VisibilityChangeMode,
} from "./teamVisibility";

// "Share in full going forward" is a time split on one membership: sessions
// started before a boundary keep the level they had. These pin the rules the
// server and the web store both apply, so a raise never shows an old session
// more than the member allowed and a lowering always applies to everything.

const T1 = 1_000;
const T2 = 2_000;
const T3 = 3_000;

describe("effectiveMembershipVisibility", () => {
  test("no history: every session reads at the current level; a missing level is summary", () => {
    expect(effectiveMembershipVisibility({ visibility: "full" }, 5)).toBe("full");
    expect(effectiveMembershipVisibility({}, 5)).toBe("summary");
    expect(effectiveMembershipVisibility(null, 5)).toBe("summary");
    expect(effectiveMembershipVisibility({ visibility: "bogus" }, 5)).toBe("summary");
  });

  test("a session started before the boundary keeps the pinned level; at or after it reads current", () => {
    const m: MembershipVisibilityFacts = { visibility: "full", visibility_history: [{ before: T1, visibility: "summary" }] };
    expect(effectiveMembershipVisibility(m, T1 - 1)).toBe("summary");
    expect(effectiveMembershipVisibility(m, T1)).toBe("full");
    expect(effectiveMembershipVisibility(m, T1 + 1)).toBe("full");
  });

  test("a session with no start time reads at the current level", () => {
    const m: MembershipVisibilityFacts = { visibility: "full", visibility_history: [{ before: T1, visibility: "hidden" }] };
    expect(effectiveMembershipVisibility(m, undefined)).toBe("full");
    expect(effectiveMembershipVisibility(m, null)).toBe("full");
  });

  test("several segments: the first boundary after the start wins", () => {
    const m: MembershipVisibilityFacts = {
      visibility: "full",
      visibility_history: [{ before: T1, visibility: "hidden" }, { before: T2, visibility: "summary" }],
    };
    expect(effectiveMembershipVisibility(m, T1 - 1)).toBe("hidden");
    expect(effectiveMembershipVisibility(m, T1)).toBe("summary");
    expect(effectiveMembershipVisibility(m, T2 - 1)).toBe("summary");
    expect(effectiveMembershipVisibility(m, T2)).toBe("full");
  });
});

describe("nextMembershipVisibility", () => {
  test("raising for everything forgets the past", () => {
    const m = { visibility: "summary", visibility_history: [{ before: T1, visibility: "hidden" as const }] };
    expect(nextMembershipVisibility(m, "full", "everything", T2)).toEqual({ visibility: "full", visibility_history: undefined });
  });

  test("raising going forward pins the sessions started before now at the level they had", () => {
    const next = nextMembershipVisibility({ visibility: "summary" }, "full", "going_forward", T1);
    expect(next).toEqual({ visibility: "full", visibility_history: [{ before: T1, visibility: "summary" }] });
    expect(effectiveMembershipVisibility(next, T1 - 1)).toBe("summary");
    expect(effectiveMembershipVisibility(next, T1)).toBe("full");
  });

  test("the current level going forward is a no-op; the current level for everything lifts the pinned past", () => {
    const m = { visibility: "full", visibility_history: [{ before: T1, visibility: "summary" as const }] };
    expect(nextMembershipVisibility(m, "full", "going_forward", T2)).toEqual(m);
    // "Include past sessions": same level, everything.
    expect(nextMembershipVisibility(m, "full", "everything", T2)).toEqual({ visibility: "full", visibility_history: undefined });
  });

  test("lowering applies to everything: every segment drops to at most the new level", () => {
    const m = { visibility: "full", visibility_history: [{ before: T1, visibility: "summary" as const }] };
    // full -> hidden: the pinned summary segment must not keep showing titles.
    expect(nextMembershipVisibility(m, "hidden", "everything", T2)).toEqual({ visibility: "hidden", visibility_history: undefined });
    // The mode is ignored on the way down.
    expect(nextMembershipVisibility(m, "hidden", "going_forward", T2)).toEqual({ visibility: "hidden", visibility_history: undefined });
  });

  test("lowering to the pinned level makes the split redundant and drops it", () => {
    const m = { visibility: "full", visibility_history: [{ before: T1, visibility: "summary" as const }] };
    expect(nextMembershipVisibility(m, "summary", "everything", T2)).toEqual({ visibility: "summary", visibility_history: undefined });
  });

  test("lowering above a pinned level keeps that pin", () => {
    const m = { visibility: "full", visibility_history: [{ before: T1, visibility: "hidden" as const }] };
    expect(nextMembershipVisibility(m, "summary", "everything", T2)).toEqual({
      visibility: "summary",
      visibility_history: [{ before: T1, visibility: "hidden" }],
    });
  });

  test("the three-segment sequence: hidden, then full going forward, then summary for all, then full going forward", () => {
    let m: MembershipVisibilityFacts = { visibility: "hidden" };
    m = nextMembershipVisibility(m, "full", "going_forward", T1);
    m = nextMembershipVisibility(m, "summary", "everything", T2);
    m = nextMembershipVisibility(m, "full", "going_forward", T3);
    expect(m).toEqual({
      visibility: "full",
      visibility_history: [{ before: T1, visibility: "hidden" }, { before: T3, visibility: "summary" }],
    });
    expect(effectiveMembershipVisibility(m, T1 - 1)).toBe("hidden");
    expect(effectiveMembershipVisibility(m, T2)).toBe("summary");
    expect(effectiveMembershipVisibility(m, T3)).toBe("full");
  });

  test("a going-forward raise right after another merges into one segment", () => {
    let m: MembershipVisibilityFacts = { visibility: "hidden" };
    m = nextMembershipVisibility(m, "summary", "going_forward", T1);
    // Between T1 and T2 the level was summary; raising to full pins [T1,T2) at summary.
    m = nextMembershipVisibility(m, "full", "going_forward", T2);
    expect(m.visibility_history).toEqual([{ before: T1, visibility: "hidden" }, { before: T2, visibility: "summary" }]);
    // Lowering back to summary leaves only the hidden pin: the summary segment equals the current level.
    m = nextMembershipVisibility(m, "summary", "everything", T3);
    expect(m.visibility_history).toEqual([{ before: T1, visibility: "hidden" }]);
  });

  test("invariant: the current level is the highest of every segment, for any sequence", () => {
    const modes: VisibilityChangeMode[] = ["everything", "going_forward"];
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let run = 0; run < 200; run++) {
      let m: MembershipVisibilityFacts = { visibility: TEAM_VISIBILITY_LEVELS[rand(4)] };
      for (let step = 1; step <= 8; step++) {
        const target = TEAM_VISIBILITY_LEVELS[rand(4)] as TeamVisibilityLevel;
        m = nextMembershipVisibility(m, target, modes[rand(2)], step * 100);
        const current = currentMembershipVisibility(m);
        for (const segment of m.visibility_history ?? []) {
          expect(TEAM_VISIBILITY_RANK[segment.visibility]).toBeLessThanOrEqual(TEAM_VISIBILITY_RANK[current]);
        }
        // Boundaries ascend and no two adjacent segments repeat a level.
        const history = m.visibility_history ?? [];
        for (let i = 1; i < history.length; i++) {
          expect(history[i].before).toBeGreaterThan(history[i - 1].before);
          expect(history[i].visibility).not.toBe(history[i - 1].visibility);
        }
        if (history.length > 0) expect(history[history.length - 1].visibility).not.toBe(current);
      }
    }
  });

  test("hasPinnedPast reads the history", () => {
    expect(hasPinnedPast({ visibility: "full" })).toBe(false);
    expect(hasPinnedPast({ visibility: "full", visibility_history: [] })).toBe(false);
    expect(hasPinnedPast({ visibility: "full", visibility_history: [{ before: T1, visibility: "summary" }] })).toBe(true);
  });
});

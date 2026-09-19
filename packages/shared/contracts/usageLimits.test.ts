import { describe, expect, test } from "bun:test";
import {
  fallbackProfiles,
  isUsageExhausted,
  rankByHeadroom,
  switchUsagePercent,
  worstUsagePercent,
  usageStanding,
  standingLabel,
  describeDecision,
  recoveryModeOf,
  RESUME_BURST_SPACING_MS,
  pendingProposal,
  type CcUsage,
} from "./usageLimits";

const now = 1_000_000_000_000;

function usage(partial: Partial<CcUsage> & { session?: CcUsage["session"]; weekly?: CcUsage["weekly"] }): CcUsage {
  return { fetched_at: now - 60_000, ...partial };
}

describe("switchUsagePercent", () => {
  test("matches worstUsagePercent on a fresh snapshot with future resets", () => {
    const snap = usage({
      session: { percent: 16, resets_at: now + 3600_000 },
      weekly: { percent: 42, resets_at: now + 86_400_000 },
      weekly_scoped: { percent: 77, resets_at: now + 86_400_000, label: "Fable" },
    });
    expect(switchUsagePercent(snap, now)).toBe(77);
    expect(worstUsagePercent(snap, now)).toBe(77);
  });

  test("a rolled window measured AFTER the reset is empty, not unknown", () => {
    const snap = usage({
      fetched_at: now - 10_000,
      session: { percent: 0, resets_at: now - 60_000 },
      weekly: { percent: 19, resets_at: now + 86_400_000 },
    });
    expect(switchUsagePercent(snap, now)).toBe(19);
  });

  test("a rolled window whose snapshot predates the reset is unknown", () => {
    // 6h-old probe, Fable reset 3h ago, leftover session 2% — display reads 2,
    // switch must not treat that as "most headroom".
    const snap: CcUsage = {
      fetched_at: now - 6 * 3600_000,
      session: { percent: 2, resets_at: now + 3600_000 },
      weekly: { percent: 54, resets_at: now - 3 * 3600_000 },
      weekly_scoped: { percent: 100, resets_at: now - 3 * 3600_000, label: "Fable" },
    };
    expect(worstUsagePercent(snap, now)).toBe(2);
    expect(switchUsagePercent(snap, now)).toBeNull();
    expect(isUsageExhausted(snap, now)).toBe(false);
  });
});

describe("rankByHeadroom", () => {
  test("known remaining Fable beats a stale rolled snapshot that displays as 2%", () => {
    const staleRolled = {
      name: "stale",
      email: "stale@x.com",
      usage: {
        fetched_at: now - 6 * 3600_000,
        session: { percent: 2, resets_at: now + 3600_000 },
        weekly: { percent: 54, resets_at: now - 3 * 3600_000 },
        weekly_scoped: { percent: 100, resets_at: now - 3 * 3600_000, label: "Fable" },
      } satisfies CcUsage,
    };
    const known = {
      name: "known",
      email: "known@x.com",
      usage: {
        fetched_at: now - 60_000,
        session: { percent: 0, resets_at: now + 3600_000 },
        weekly: { percent: 37, resets_at: now + 86_400_000 },
        weekly_scoped: { percent: 69, resets_at: now + 86_400_000, label: "Fable" },
      } satisfies CcUsage,
    };
    const ranked = rankByHeadroom([staleRolled, known], now);
    expect(ranked.map((p) => p.name)).toEqual(["known", "stale"]);
    const fallbacks = fallbackProfiles([staleRolled, known, { name: "active", email: "a@x.com" }], "a@x.com", now);
    expect(fallbacks.map((p) => p.name)).toEqual(["known", "stale"]);
  });
});

describe("usageStanding — the one standing the bars and the switcher share", () => {
  test("a fresh account reads its worst live window, not pegged, not stale", () => {
    const snap = usage({
      session: { percent: 16, resets_at: now + 3600_000 },
      weekly_scoped: { percent: 77, resets_at: now + 86_400_000, label: "Fable" },
    });
    expect(usageStanding(snap, now)).toEqual({ percent: 77, pegged: false, stale: false });
    expect(standingLabel(snap, now)).toBe("77% used");
  });

  test("a spent account is pegged, and labels as 'at limit'", () => {
    const snap = usage({
      session: { percent: 12, resets_at: now + 3600_000 },
      weekly_scoped: { percent: 100, resets_at: now + 86_400_000, label: "Fable" },
    });
    expect(usageStanding(snap, now).pegged).toBe(true);
    expect(standingLabel(snap, now)).toBe("at limit");
  });

  test("a rolled window whose snapshot predates the reset reads STALE, not a confident percent — the same fact the switcher ranks last", () => {
    const snap: CcUsage = {
      fetched_at: now - 6 * 3600_000,
      session: { percent: 2, resets_at: now + 3600_000 },
      weekly_scoped: { percent: 100, resets_at: now - 3 * 3600_000, label: "Fable" },
    };
    // The bar's raw per-window number still displays 2, but the STANDING both
    // sides read is "unknown/stale" — so no green summary beside a skip.
    expect(worstUsagePercent(snap, now)).toBe(2);
    const s = usageStanding(snap, now);
    expect(s.percent).toBeNull();
    expect(s.stale).toBe(true);
    expect(standingLabel(snap, now)).toBe("stale");
  });

  test("no usage data at all is 'no data', distinct from stale", () => {
    expect(usageStanding(undefined, now)).toEqual({ percent: null, pegged: false, stale: false });
    expect(standingLabel(undefined, now)).toBe("no data");
  });
})

describe("describeDecision — why the account changed", () => {
  test("a switch names the pegged window, the session count and where it moved", () => {
    expect(
      describeDecision({
        kind: "switch",
        at: now,
        from_email: "claude6@x.com",
        pegged_window: "Fable (7d)",
        parked_count: 3,
        target_name: "fresh",
        target_percent: 47,
      }),
    ).toBe("Fable (7d) hit its limit on claude6@x.com, parking 3 sessions — switched to fresh (47% used) and continued them.");
  });

  test("a proposal says it is waiting, not that it acted", () => {
    const s = describeDecision({
      kind: "propose",
      at: now,
      from_email: "claude6@x.com",
      pegged_window: "Session (5h)",
      parked_count: 1,
      target_name: "fresh",
      target_percent: 12,
    })!;
    expect(s).toContain("Recommended: fresh (12% used)");
    expect(s).toContain("waiting for you to approve");
    expect(s).toContain("parking 1 session."); // singular, no trailing "s"
  });

  test("with no pegged window it never invents a cause", () => {
    const s = describeDecision({ kind: "switch", at: now, from_email: "a@x.com", parked_count: 2, target_name: "b" })!;
    expect(s).toContain("a@x.com could not continue");
    expect(s).not.toContain("undefined");
  });

  test("a stale target percent is simply omitted, never shown as a number", () => {
    const s = describeDecision({ kind: "switch", at: now, parked_count: 1, target_name: "b" })!;
    expect(s).not.toContain("%");
  });

  test("no decision recorded yet explains nothing", () => {
    expect(describeDecision(undefined)).toBeNull();
  });
})

describe("recoveryModeOf — ask-first is the default", () => {
  test("a machine that never chose asks before switching", () => {
    expect(recoveryModeOf({})).toBe("ask");
  });

  test("an explicit auto-switch opt-in is kept", () => {
    expect(recoveryModeOf({ cc_auto_switch: true })).toBe("auto");
  });

  test("turning asking off leaves same-account resume", () => {
    expect(recoveryModeOf({ cc_recovery_ask: false })).toBe("resume");
  });

  test("opting out of resume entirely is off, whatever the ask flag says", () => {
    expect(recoveryModeOf({ cc_auto_continue: false })).toBe("off");
    expect(recoveryModeOf({ cc_auto_continue: false, cc_recovery_ask: false })).toBe("off");
  });

  test("ask-first wins over a legacy row carrying both flags", () => {
    expect(recoveryModeOf({ cc_recovery_ask: true, cc_auto_switch: true })).toBe("ask");
  });
})

describe("resume pacing — one rate for every revive path", () => {
  test("the burst spacing keeps a mass revive under a few full-context requests a minute", () => {
    // The failure it prevents: 8 sessions resumed 6s apart is 10 large
    // requests inside a minute, which tripped the provider's per-minute cap
    // and re-parked the fleet a switch had just revived.
    const perMinute = 60_000 / RESUME_BURST_SPACING_MS;
    expect(perMinute).toBeLessThanOrEqual(3);
    // Eight sessions must now take over two minutes, not 48 seconds.
    expect(7 * RESUME_BURST_SPACING_MS).toBeGreaterThan(120_000);
  });
})

describe("pendingProposal — the ask the banner and the card surface", () => {
  const propose = (at: number) => ({ kind: "propose" as const, at, target_name: `t${at}` });
  test("finds the newest proposal on an online primary machine", () => {
    expect(
      pendingProposal([
        { online: true, auto_switch_state: { last_decision: propose(1) } },
        { online: true, auto_switch_state: { last_decision: propose(5) } },
      ])?.at,
    ).toBe(5);
  });
  test("ignores offline and remote machines, and decisions that are not asks", () => {
    expect(
      pendingProposal([
        { online: false, auto_switch_state: { last_decision: propose(9) } },
        { online: true, is_remote: true, auto_switch_state: { last_decision: propose(8) } },
        { online: true, auto_switch_state: { last_decision: { kind: "continue", at: 7 } } },
      ]),
    ).toBeNull();
  });
})

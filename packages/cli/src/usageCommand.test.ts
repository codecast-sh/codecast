import { describe, expect, test } from "bun:test";
import {
  buildUsageReport,
  describeRecovery,
  renderUsageReport,
  USAGE_WARN_PERCENT,
} from "./usageCommand";

const now = 1_800_000_000_000;
const H = 60 * 60 * 1000;
const c = { dim: "", reset: "", cyan: "", red: "", yellow: "", green: "" };

describe("buildUsageReport", () => {
  test("the 2026-08-15 shape: 5h pegged, 7d comfortable — reports the session window and its reset", () => {
    const profiles = [
      {
        name: "work",
        email: "w@x.com",
        active: true,
        usage: {
          fetched_at: now - 4 * 60_000,
          session: { percent: 100, resets_at: now + 1.5 * H },
          weekly: { percent: 39, resets_at: now + 12 * H },
        },
      },
      { name: "spare", email: "s@x.com", usage: { fetched_at: now - 60_000, session: { percent: 0 }, weekly: { percent: 20 } } },
    ];
    const r = buildUsageReport(profiles, now, { auto_switch: false, auto_continue: true });
    expect(r.active?.name).toBe("work");
    expect(r.worst).toBe(100);
    expect(r.exhausted).toBe(true);
    expect(r.next_reset).toBe(now + 1.5 * H);
    expect(r.fallbacks.map((f) => f.name)).toEqual(["spare"]);
    expect(describeRecovery(r)).toContain("resume on their own when the window resets");
    expect(describeRecovery(r)).toContain("next reset in 1h 30m");
    expect(describeRecovery(r)).toContain("(auto-switch off)");
  });

  test("auto-switch on with a fallback: describes the hop; no fallback: falls back to the resume story", () => {
    const active = {
      name: "work",
      email: "w@x.com",
      active: true,
      usage: { fetched_at: now, session: { percent: 90, resets_at: now + H } },
    };
    const withSpare = buildUsageReport(
      [active, { name: "spare", email: "s@x.com", usage: { fetched_at: now, session: { percent: 5 } } }],
      now,
      { auto_switch: true, auto_continue: true },
    );
    expect(describeRecovery(withSpare)).toContain("auto-switch hops to the freshest of 1 saved account(s)");
    const alone = buildUsageReport([active], now, { auto_switch: true, auto_continue: true });
    expect(describeRecovery(alone)).toContain("resume on their own");
    expect(describeRecovery(alone)).toContain("no other saved account with headroom");
    const nothing = buildUsageReport([active], now, { auto_switch: false, auto_continue: false });
    expect(describeRecovery(nothing)).toContain("park until you continue them");
    const unknown = buildUsageReport([active], now, null);
    expect(describeRecovery(unknown)).toContain("recovery flags unknown");
  });

  test("a rolled window reads as reset (0%) and never sets next_reset; a pegged fallback is excluded", () => {
    const r = buildUsageReport(
      [
        {
          name: "work",
          email: "w@x.com",
          active: true,
          usage: { fetched_at: now - 6 * H, session: { percent: 100, resets_at: now - H }, weekly: { percent: 30 } },
        },
        { name: "pegged", email: "p@x.com", usage: { fetched_at: now, weekly: { percent: 100, resets_at: now + H } } },
      ],
      now,
      null,
    );
    expect(r.active?.windows[0]).toMatchObject({ label: "Session (5h)", percent: 0, rolled: true });
    expect(r.exhausted).toBe(false);
    expect(r.next_reset).toBeUndefined();
    expect(r.fallbacks).toEqual([]);
    expect(renderUsageReport(r, c)).toContain("Session (5h)   reset");
  });

  test("no active account renders the waiting note", () => {
    const r = buildUsageReport([], now, null);
    expect(r.active).toBeNull();
    expect(renderUsageReport(r, c)).toContain("No active Claude account with usage data yet");
    expect(USAGE_WARN_PERCENT).toBe(85);
  });
});

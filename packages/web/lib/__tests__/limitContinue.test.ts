import { describe, expect, test } from "bun:test";
import { standingLabel } from "@codecast/shared/contracts";
import { accountName, limitContinueTarget } from "../limitContinue";

const now = Date.UTC(2026, 10, 12, 12);
const later = now + 3 * 86_400_000;
const usage = (week: number, fable: number) => ({
  fetched_at: now - 60_000,
  weekly: { percent: week, resets_at: later },
  weekly_scoped: { label: "Fable", percent: fable, resets_at: later },
});

const device = {
  active_email: "ashot@example.com",
  profiles: [
    { name: "default", email: "ashot@example.com", usage: usage(40, 10) },
    { name: "pool-peter", email: "peter@example.com", usage: usage(100, 100) },
    { name: "pool-cameron", email: "cameron@example.com", usage: usage(72, 100) },
    { name: "pool-riley", email: "riley@example.com", usage: usage(89, 20) },
  ],
};

describe("limitContinueTarget", () => {
  test("an opus session continues on the roomiest account; the Fable week does not count", () => {
    const { active, best } = limitContinueTarget(device, now, true, { pinned: "pool-peter", models: ["claude-opus-5-5"] });
    expect(active?.email).toBe("peter@example.com");
    expect(best?.name).toBe("pool-cameron");
    expect(standingLabel(best!.usage, now, ["claude-opus-5-5"])).toBe("72% used");
  });

  test("a Fable session skips accounts whose Fable week is spent and shows the Fable standing", () => {
    const { best } = limitContinueTarget(device, now, true, { pinned: "pool-peter", models: ["claude-fable-5-2"] });
    expect(best?.name).toBe("pool-riley");
    expect(standingLabel(best!.usage, now, ["claude-fable-5-2"])).toBe("89% used");
  });

  test("names an account by its email, as the accounts panel does", () => {
    expect(accountName({ name: "pool-cameron", email: "cameron@example.com" })).toBe("cameron@example.com");
    expect(accountName(undefined, "pool-peter")).toBe("pool-peter");
  });
});

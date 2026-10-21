import { expect, test } from "bun:test";
import { rankAccounts, REVIEWS_DEFAULTS } from "./agentReviewsHost";

const NOW = Date.UTC(2026, 9, 21, 8, 41);
const HOUR = 3_600_000;
const cfg = { ...REVIEWS_DEFAULTS, slots: 18 };
const none = new Map<string, number>();

// Probed at 08:39, before the 5-hour window rolled at 08:40: that window is now unmeasured.
const rolled = (week: number) => ({
  fetched_at: NOW - 2 * 60_000,
  session: { percent: 40, resets_at: NOW - 60_000 },
  weekly: { percent: week, resets_at: NOW + 70 * HOUR },
});

test("a 5-hour window that rolled since the last probe does not hide a week at its stop", () => {
  expect(rankAccounts([{ name: "claude2", usage: rolled(85) }], cfg, none, none, NOW)).toEqual([]);
});

test("the same rollover on a week with room leaves the account open", () => {
  expect(rankAccounts([{ name: "fresh", usage: rolled(30) }], cfg, none, none, NOW)).toEqual(["fresh"]);
});

test("the profile this machine's sessions run on is never picked, even when the config names it", () => {
  expect(rankAccounts([{ name: "claude", active: true, usage: rolled(10) }], { ...cfg, accounts: ["claude"] }, none, none, NOW)).toEqual([]);
});

import { expect, test } from "bun:test";
import { isSnoozed, nextSnoozes, snoozeChoices, splitSnoozed } from "./opsSnooze";
import { freshness } from "./opsFreshness";
import type { AttentionItem } from "./opsHomeModel";

const NOW = Date.UTC(2026, 10, 3, 12);
const H = 3600_000;

const issue = (over: Partial<AttentionItem> = {}): AttentionItem => ({ kind: "issue", key: "issue:g1", state: "new", severity: 2, at: NOW, volume: 20, sourceId: "s1", taskId: null, task: null, sessionId: null, group: {} as any, replay: null, replays: 0, ...over } as AttentionItem);
const watch = (muted_until?: number): AttentionItem => ({ kind: "watch", key: "watch:w1", state: "alerting", severity: 3, at: NOW, volume: Infinity, sourceId: "s1", taskId: null, task: null, sessionId: null, group: null, watch: { muted_until } as any } as AttentionItem);

test("a snooze holds for its window, then the item comes back", () => {
  const s = nextSnoozes({}, issue(), snoozeChoices("issue")[0], NOW);
  expect(isSnoozed(issue(), s, NOW + H - 1)).toBe(true);
  expect(isSnoozed(issue(), s, NOW + H)).toBe(false);
});

test("a snoozed item comes back early when it gets worse: a new state, or an issue that doubles", () => {
  const change = snoozeChoices("issue").find((c) => c.ms === null)!;
  const s = nextSnoozes({}, issue(), change, NOW);
  expect(isSnoozed(issue({ volume: 35 }), s, NOW + 30 * 24 * H)).toBe(true);
  expect(isSnoozed(issue({ volume: 40 }), s, NOW)).toBe(false);
  expect(isSnoozed(issue({ state: "escalating" }), s, NOW)).toBe(false);
});

test("a watch is snoozed by its own mute, the one the whole team shares", () => {
  expect(isSnoozed(watch(NOW + H), {}, NOW)).toBe(true);
  expect(isSnoozed(watch(NOW - 1), {}, NOW)).toBe(false);
  expect(snoozeChoices("watch").every((c) => c.ms !== null)).toBe(true);
});

test("writing a snooze drops the ones that ran out, and waking removes it", () => {
  const old = { "issue:gone": { until: NOW - 1, state: "new" as const, volume: 1, at: NOW - H }, "issue:kept": { until: null, state: "new" as const, volume: 1, at: NOW - H } };
  const s = nextSnoozes(old, issue(), snoozeChoices("issue")[1], NOW);
  expect(Object.keys(s).sort()).toEqual(["issue:g1", "issue:kept"]);
  expect(Object.keys(nextSnoozes(s, issue(), null, NOW))).toEqual(["issue:kept"]);
  const { live, snoozed } = splitSnoozed([issue(), issue({ key: "issue:g2" })], s, NOW);
  expect([live.map((i) => i.key), snoozed.map((i) => i.key)]).toEqual([["issue:g2"], ["issue:g1"]]);
});

test("freshness is one state: offline, a failed feed, the source furthest behind by name, else up to date with its last poll; nothing with no source", () => {
  const polled = [{ name: "web-posthog", provider: "posthog" as const, status: "active" as const, last_poll_at: NOW - 2 * 60_000 }];
  expect(freshness({ connected: true, offlineSince: null, feedError: false, sources: polled, now: NOW })).toMatchObject({ stale: false, label: "Polled 2m ago", source: null });
  expect(freshness({ connected: false, offlineSince: NOW - 3 * 60_000, feedError: false, sources: polled, now: NOW })).toMatchObject({ stale: true, label: "Offline for 3m" });
  expect(freshness({ connected: true, offlineSince: null, feedError: true, sources: polled, now: NOW })!.stale).toBe(true);
  const behind = [...polled, { name: "old-sentry", provider: "sentry" as const, status: "active" as const, last_poll_at: NOW - 45 * 60_000 }];
  expect(freshness({ connected: true, offlineSince: null, feedError: false, sources: behind, now: NOW })).toMatchObject({ stale: true, label: "Stale: old-sentry 45m", source: "old-sentry" });
  expect(freshness({ connected: true, offlineSince: null, feedError: false, sources: [{ name: "web", provider: "sdk", status: "active" }], now: NOW })!.label).toBe("Up to date");
  expect(freshness({ connected: true, offlineSince: null, feedError: false, sources: [], now: NOW })).toBeNull();
  // Scoped to one source, the chip speaks for that source alone: another source's late poll is not this view's.
  expect(freshness({ connected: true, offlineSince: null, feedError: false, sources: behind, now: NOW, scope: "web-posthog" })).toMatchObject({ stale: false, label: "Polled 2m ago" });
  expect(freshness({ connected: true, offlineSince: null, feedError: false, sources: behind, now: NOW, scope: "old-sentry" })).toMatchObject({ stale: true, label: "Polled 45m ago", source: null });
});

test("a poll under a minute old reads Polled just now, never Polled now ago", () => {
  const fresh = [{ name: "union", provider: "app" as const, status: "active" as const, last_poll_at: NOW - 20_000 }];
  expect(freshness({ connected: true, offlineSince: null, feedError: false, sources: fresh, now: NOW })!.label).toBe("Polled just now");
  expect(freshness({ connected: true, offlineSince: null, feedError: false, sources: fresh, now: NOW, scope: "union" })!.label).toBe("Polled just now");
});

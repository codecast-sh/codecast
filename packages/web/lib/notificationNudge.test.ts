import { test, expect, describe } from "bun:test";
import { decideNotificationNudge, NUDGE_MISS_OVERRIDE_AFTER_MS, NUDGE_SNOOZE_MS, type NotificationMiss } from "./notificationNudge";

const NOW = 1_756_000_000_000;
const miss = (at: number, fromPerson = true): NotificationMiss => ({ at, fromPerson, actor: "Samvit" });

describe("decideNotificationNudge", () => {
  test("granted or unknown never shows", () => {
    expect(decideNotificationNudge({ readiness: "granted", snoozedAt: 0, miss: null, now: NOW }).show).toBe(false);
    expect(decideNotificationNudge({ readiness: "unknown", snoozedAt: 0, miss: null, now: NOW }).show).toBe(false);
    // Even a fresh missed message can't surface it when banners already work.
    expect(decideNotificationNudge({ readiness: "granted", snoozedAt: 0, miss: miss(NOW), now: NOW }).show).toBe(false);
  });

  test("off with no history shows the plain nudge", () => {
    const v = decideNotificationNudge({ readiness: "off", snoozedAt: 0, miss: null, now: NOW });
    expect(v).toEqual({ show: true, escalated: false });
  });

  test("dismiss snoozes, and the snooze expires", () => {
    const snoozedAt = NOW - NUDGE_SNOOZE_MS + 1000;
    expect(decideNotificationNudge({ readiness: "ask", snoozedAt, miss: null, now: NOW }).show).toBe(false);
    expect(decideNotificationNudge({ readiness: "ask", snoozedAt: NOW - NUDGE_SNOOZE_MS - 1, miss: null, now: NOW }).show).toBe(true);
  });

  test("a missed message escalates the copy when nothing is snoozed", () => {
    const m = miss(NOW - 1000);
    expect(decideNotificationNudge({ readiness: "off", snoozedAt: 0, miss: m, now: NOW }))
      .toEqual({ show: true, escalated: true, miss: m });
  });

  test("a fresh snooze holds through a missed message", () => {
    const snoozedAt = NOW - 60_000; // dismissed a minute ago
    expect(decideNotificationNudge({ readiness: "off", snoozedAt, miss: miss(NOW - 1000), now: NOW }).show).toBe(false);
  });

  test("a person's miss cuts a day-old snooze short; an agent's never does", () => {
    const snoozedAt = NOW - NUDGE_MISS_OVERRIDE_AFTER_MS; // still inside the 3-day snooze
    const person = miss(NOW - 1000);
    expect(decideNotificationNudge({ readiness: "off", snoozedAt, miss: person, now: NOW }))
      .toEqual({ show: true, escalated: true, miss: person });
    expect(decideNotificationNudge({ readiness: "off", snoozedAt, miss: miss(NOW - 1000, false), now: NOW }).show).toBe(false);
  });

  test("dismissing after a miss holds until the NEXT qualifying miss", () => {
    const m = miss(NOW - 60_000);
    const snoozedAt = NOW - 30_000; // dismissed after the miss
    expect(decideNotificationNudge({ readiness: "off", snoozedAt, miss: m, now: NOW }).show).toBe(false);
    // A miss the next minute stays snoozed; one a day later comes back escalated.
    expect(decideNotificationNudge({ readiness: "off", snoozedAt, miss: miss(NOW - 1000), now: NOW }).show).toBe(false);
    const later = NOW + NUDGE_MISS_OVERRIDE_AFTER_MS;
    expect(decideNotificationNudge({ readiness: "off", snoozedAt, miss: miss(later - 1000), now: later }).show).toBe(true);
  });
});

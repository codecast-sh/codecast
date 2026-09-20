import { afterEach, describe, expect, test } from "bun:test";
import {
  AGENT_ALERTS_OVERRIDE, agentAlertsSuppressed, claimStoredAlert,
  createNotificationDelivery, deliverAlert, installNotificationDelivery,
  type AlertClaim, type ClaimResult,
} from "./notificationDelivery";
import { AGENT_TAB_KEY } from "./desktopHandoff";

const claim: AlertClaim = { key: "sound:chat:1", ttl: 60_000, preferDesktop: true };
const originalStorage = globalThis.sessionStorage;
afterEach(() => { globalThis.sessionStorage = originalStorage; });

function storage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
}

describe("agent alerts", () => {
  test("normal tabs notify, agent tabs are quiet, and only an explicit tab override opts in", async () => {
    const session = storage();
    globalThis.sessionStorage = session as Storage;
    let sent = 0;
    expect(agentAlertsSuppressed()).toBe(false);
    session.setItem(AGENT_TAB_KEY, "1");
    expect(await deliverAlert("chat", () => { sent++; })).toBe(false);
    expect(sent).toBe(0);
    session.setItem(AGENT_ALERTS_OVERRIDE, "1");
    expect(await deliverAlert("chat", () => { sent++; })).toBe(true);
    expect(sent).toBe(1);
    session.removeItem(AGENT_ALERTS_OVERRIDE);
    expect(agentAlertsSuppressed()).toBe(true);
  });
});

describe("notification delivery", () => {
  test("ten independent browser windows announce a shared message once, then announce the next", async () => {
    const shared = storage();
    let sent = 0;
    const tabs = Array.from({ length: 10 }, () => createNotificationDelivery({
      remote: async () => null,
      fallback: async (c) => claimStoredAlert(shared, c.key, c.ttl),
      suppressed: () => false,
    }));
    const results = await Promise.all(tabs.map((tab) => tab.deliver(claim, () => { sent++; })));
    expect(results.filter(Boolean)).toHaveLength(1);
    await Promise.all(tabs.map((tab) => tab.deliver({ ...claim, key: "sound:chat:2" }, () => { sent++; })));
    expect(sent).toBe(2);
  });

  test("browser waits for desktop, then discards the event desktop handled", async () => {
    let result: ClaimResult = "desktop";
    let sent = false;
    const tab = createNotificationDelivery({
      remote: async () => result,
      fallback: async () => true,
      suppressed: () => false,
      wait: async () => { result = "duplicate"; },
    });
    expect(await tab.deliver(claim, () => { sent = true; })).toBe(false);
    expect(sent).toBe(false);
  });

  test("browser takes over a pending event when desktop closes", async () => {
    let result: ClaimResult = "desktop";
    const tab = createNotificationDelivery({
      remote: async () => result,
      fallback: async () => true,
      suppressed: () => false,
      wait: async () => { result = "claimed"; },
    });
    expect(await tab.deliver(claim, () => {})).toBe(true);
  });

  test("stop, late agent attachment, and slow discovery cancel queued alerts", async () => {
    for (const reason of ["stop", "agent", "timeout"]) {
      let now = 0;
      let quiet = false;
      let resolve!: (value: ClaimResult) => void;
      const tab = createNotificationDelivery({
        remote: () => new Promise((r) => { resolve = r; }),
        fallback: async () => true,
        suppressed: () => quiet,
        now: () => now,
      });
      let sent = false;
      const pending = tab.deliver(claim, () => { sent = true; });
      await Promise.resolve();
      if (reason === "stop") tab.stop();
      if (reason === "agent") quiet = true;
      if (reason === "timeout") now = 60_000;
      resolve("claimed");
      expect(await pending).toBe(false);
      expect(sent).toBe(false);
    }
  });

  test("desktop preference waits are bounded and never replay an old ring", async () => {
    let now = 0;
    const tab = createNotificationDelivery({
      remote: async () => "desktop",
      fallback: async () => true,
      suppressed: () => false,
      now: () => now,
      wait: async (ms) => { now += ms; },
    });
    expect(await tab.deliver({ ...claim, ttl: 2_500 }, () => {})).toBe(false);
    expect(now).toBe(2_500);
  });

  test("uninstall cancels work and does not disconnect a newer coordinator", async () => {
    const make = (answer: boolean) => createNotificationDelivery({ remote: async () => null, fallback: async () => answer, suppressed: () => false });
    const stopFirst = installNotificationDelivery(make(false));
    const stopSecond = installNotificationDelivery(make(true));
    stopFirst();
    expect(await deliverAlert("new", () => {})).toBe(true);
    stopSecond();
  });

  test("claims expire and remain bounded", () => {
    const shared = storage();
    expect(claimStoredAlert(shared, "event", 1_000, 0)).toBe(true);
    expect(claimStoredAlert(shared, "event", 1_000, 999)).toBe(false);
    expect(claimStoredAlert(shared, "event", 1_000, 1_000)).toBe(true);
    for (let i = 0; i < 1_000; i++) claimStoredAlert(shared, `m:${i}`, 60_000, 2_000);
    expect(Object.keys(JSON.parse(shared.getItem("codecast-notification-claims")!))).toHaveLength(500);
  });
});

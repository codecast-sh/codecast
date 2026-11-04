import { describe, expect, test } from "bun:test";
import { connectWait, testEventBody } from "./connectWait";
import { endOldKeyLedger, removeSourceLedger } from "../consequential/ledgers";

const src = (o: Record<string, unknown> = {}) => ({ provider: "sdk", status: "active", keyed: true, ...o }) as any;
const health = (o: Record<string, unknown> = {}) => ({ state: "waiting", label: "No events yet", reason: null, lastAt: null, ...o }) as any;

describe("connectWait", () => {
  test("no source yet reads Adding", () => {
    expect(connectWait(null, undefined).state).toBe("adding");
  });
  test("a keyed source with nothing waits for the first event", () => {
    expect(connectWait(src(), health())).toEqual({ state: "waiting", label: "Waiting for the first event", reason: null });
  });
  test("anything it holds counts as arrived, even an old vendor issue", () => {
    expect(connectWait(src({ provider: "sentry", keyed: false }), health({ lastAt: 1 })).state).toBe("arrived");
    expect(connectWait(src(), health({ lastAt: 5 })).label).toBe("First event arrived");
  });
  test("a vendor poll that failed shows its reason instead of a spinner", () => {
    const w = connectWait(src({ provider: "sentry", keyed: false, status: "error", last_error: "Sentry has no project webb in acme" }), health({ state: "failing", label: "Stopped on error", reason: "Sentry has no project webb in acme" }));
    expect(w).toEqual({ state: "failing", label: "Stopped on error", reason: "Sentry has no project webb in acme" });
  });
  test("a token refusal reads as auth", () => {
    const w = connectWait(src({ provider: "posthog", keyed: false, status: "error" }), health({ state: "auth", label: "Auth failing", reason: "PostHog refused the token (401)" }));
    expect(w.state).toBe("failing");
    expect(w.label).toBe("Auth failing");
  });
  test("a last_error on an active source still shows, with a plain label", () => {
    expect(connectWait(src({ provider: "app", keyed: false, last_error: "codecast.json did not parse" }), health())).toEqual({ state: "failing", label: "Failing", reason: "codecast.json did not parse" });
  });
  test("a poll that answered with nothing is connected, not waiting", () => {
    expect(connectWait(src({ provider: "posthog", keyed: false, last_poll_at: 10 }), health()).label).toBe("Connected · nothing in the last poll");
    expect(connectWait(src({ provider: "posthog", keyed: false }), health()).label).toBe("Waiting for the first PostHog poll");
  });
  test("an app reads its manifest first", () => {
    expect(connectWait(src({ provider: "app", keyed: false }), health()).label).toBe("Reading codecast.json");
    expect(connectWait(src({ provider: "app", keyed: false, manifest_fetched_at: 3 }), health()).state).toBe("connected");
  });
  test("the test event is one codecast.test item", () => {
    expect(JSON.parse(testEventBody(42)).items).toEqual([{ type: "event", name: "codecast.test", at: 42 }]);
  });
});

describe("removeSourceLedger", () => {
  const base = { source: "union-posthog", provider: "PostHog", issues: { n: 300 }, open: { n: 253 }, tasked: { n: 4 }, watches: { n: 11 }, replays: { n: 1000, capped: true }, keyed: false };
  test("an active source opens on Pause, which keeps everything", () => {
    const l = removeSourceLedger({ ...base, choice: "Pause", canPause: true });
    expect(l.confirm).toBe("Pause");
    expect(l.alert).toBeUndefined();
    expect(l.pick?.value).toBe("Pause");
    expect(l.rows.find((r) => r.k === "To undo")?.v).toBe("Resume");
  });
  test("Remove names every count and that it cannot be undone", () => {
    const l = removeSourceLedger({ ...base, choice: "Remove", canPause: true });
    expect(l.confirm).toBe("Remove for good");
    expect(l.alert).toBe("Deleted for good, no undo");
    expect(l.figures.map((f) => f.value)).toEqual(["300", "1,000+", "11"]);
    expect(l.figures[0].label).toBe("issues · 253 open");
    expect(l.rows.find((r) => r.k === "Tasks")?.v).toBe("4 stay, unlinked");
  });
  test("a paused source offers only Remove", () => {
    const l = removeSourceLedger({ ...base, choice: "Pause", canPause: false });
    expect(l.pick).toBeUndefined();
    expect(l.confirm).toBe("Remove for good");
  });
  test("a keyed source says its key is refused", () => {
    expect(removeSourceLedger({ ...base, keyed: true, choice: "Remove", canPause: false }).rows.some((r) => r.k === "Its key")).toBe(true);
  });
});

describe("endOldKeyLedger", () => {
  const ago = () => "4m ago";
  test("an old key still carrying events warns", () => {
    const l = endOldKeyLedger({ source: "web", prefix: "ck_ab", until: 0, lastAt: 1, events: 120, ago, left: "20h" });
    expect(l.alert).toBe("Sends refused until redeploy");
    expect(l.figures.map((f) => f.value)).toEqual(["120", "4m ago"]);
  });
  test("an unused old key ends quietly", () => {
    const l = endOldKeyLedger({ source: "web", until: 0, lastAt: null, events: 0, ago, left: "20h" });
    expect(l.alert).toBeUndefined();
    expect(l.figures[1].value).toBe("Never");
  });
});

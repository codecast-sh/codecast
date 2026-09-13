import { describe, expect, test } from "bun:test";
import { resolveChannelStub } from "../calls/walkieMessage";

// The rule a burst learns its channel by when the face was pressed before
// its DM existed: the store's row or the open's own answer, whichever lands
// first; a refused open fails at once; nothing at all fails at the deadline.

const never = () => null;

describe("resolveChannelStub", () => {
  test("a row already in the store answers without waiting", async () => {
    const out = await resolveChannelStub({
      lookup: () => "hx7real",
      inFlight: null,
      done: () => false,
      deadlineMs: 50,
    });
    expect(out).toEqual({ id: "hx7real" });
  });

  test("the open's answer wins over a row that has not synced back yet", async () => {
    const t0 = Date.now();
    const out = await resolveChannelStub({
      lookup: never,
      inFlight: Promise.resolve("hx7fromserver"),
      done: () => false,
      deadlineMs: 5_000,
      tickMs: 10,
    });
    expect(out).toEqual({ id: "hx7fromserver" });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("a refused open fails now, with its reason, not at the deadline", async () => {
    const t0 = Date.now();
    const out = await resolveChannelStub({
      lookup: never,
      inFlight: Promise.reject(new Error("Jordan Lee is not a member of this team")),
      done: () => false,
      deadlineMs: 5_000,
      tickMs: 10,
      reason: (err) => (err instanceof Error ? err.message : String(err)),
    });
    expect(out).toEqual({ failed: "Jordan Lee is not a member of this team" });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("an answer with no id keeps waiting for the row", async () => {
    let calls = 0;
    const out = await resolveChannelStub({
      lookup: () => (++calls >= 3 ? "hx7late" : null),
      inFlight: Promise.resolve(null),
      done: () => false,
      deadlineMs: 5_000,
      tickMs: 5,
    });
    expect(out).toEqual({ id: "hx7late" });
  });

  test("nothing by the deadline is null", async () => {
    const out = await resolveChannelStub({
      lookup: never,
      inFlight: null,
      done: () => false,
      deadlineMs: 30,
      tickMs: 5,
    });
    expect(out).toBeNull();
  });

  test("a burst that ended stops waiting early", async () => {
    let done = false;
    setTimeout(() => (done = true), 15);
    const t0 = Date.now();
    const out = await resolveChannelStub({
      lookup: never,
      inFlight: null,
      done: () => done,
      deadlineMs: 5_000,
      tickMs: 5,
    });
    expect(out).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

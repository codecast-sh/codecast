import { describe, expect, test } from "bun:test";
import { groupIdleNotifications, summarizeIdleDigest } from "./idleDigest";

// Rows as the bell holds them: newest first.
const row = (id: string, type: string, created_at: number, read = false) =>
  ({ _id: id, type, created_at, read });
const keyOf = (r: any) => r._id;
const group = (rows: any[]) => groupIdleNotifications(rows, keyOf);

describe("the fold-up line", () => {
  test("names two sessions and counts the rest", () => {
    expect(summarizeIdleDigest(["A"])).toEqual({
      title: "1 session needs your attention",
      message: "A needs your attention",
    });
    expect(summarizeIdleDigest(["A", "B"]).message).toBe("A and B need your attention");
    expect(summarizeIdleDigest(["A", "B", "C"]).message).toBe("A, B and 1 other need your attention");
    expect(summarizeIdleDigest(["A", "B", "C", "D"]).message).toBe("A, B and 2 others need your attention");
  });
});

describe("grouping the waiting burst", () => {
  test("a fold-up row takes the sessions below it", () => {
    const rows = [
      row("d1", "sessions_need_input", 1100),
      row("i3", "session_idle", 1050),
      row("i2", "session_idle", 1020),
      row("i1", "session_idle", 1000),
    ];
    const out = group(rows);
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe("group");
    const g = out[0] as any;
    expect(g.digest._id).toBe("d1");
    expect(g.rows.map((r: any) => r._id)).toEqual(["i3", "i2", "i1"]);
    expect(g.newestAt).toBe(1100);
    expect(g.unread).toBe(4);
  });

  test("each window is its own group", () => {
    const rows = [
      row("d2", "sessions_need_input", 2100),
      row("i4", "session_idle", 2050),
      row("i3", "session_idle", 2010),
      row("d1", "sessions_need_input", 1100),
      row("i2", "session_idle", 1050),
      row("i1", "session_idle", 1010),
    ];
    const out = group(rows);
    expect(out.map((e) => e.kind)).toEqual(["group", "group"]);
    expect((out[0] as any).digest._id).toBe("d2");
    expect((out[1] as any).digest._id).toBe("d1");
  });

  test("one waiting session stays its own row", () => {
    const out = group([row("i1", "session_idle", 1000), row("c1", "chat_dm", 900)]);
    expect(out.map((e) => e.kind)).toEqual(["single", "single"]);
  });

  test("two waiting sessions group even with no fold-up row yet", () => {
    // The window is still open: the alerting row and the quiet one behind it.
    const out = group([row("i2", "session_idle", 1050), row("i1", "session_idle", 1000)]);
    expect(out.length).toBe(1);
    const g = out[0] as any;
    expect(g.digest).toBeNull();
    expect(g.rows.map((r: any) => r._id)).toEqual(["i2", "i1"]);
  });

  test("a fold-up whose sessions are all superseded stays one row", () => {
    const out = group([row("d1", "sessions_need_input", 1100), row("c1", "chat_dm", 900)]);
    expect(out.map((e) => e.kind)).toEqual(["single", "single"]);
  });

  test("rows of other kinds keep their place and break a run", () => {
    const rows = [
      row("i3", "session_idle", 1300),
      row("i2", "session_idle", 1250),
      row("c1", "chat_dm", 1200),
      row("i1", "session_idle", 1100),
    ];
    const out = group(rows);
    expect(out.map((e) => e.kind)).toEqual(["group", "single", "single"]);
    expect((out[0] as any).rows.length).toBe(2);
  });

  test("the unread count covers the fold-up and its sessions", () => {
    const rows = [
      row("d1", "sessions_need_input", 1100, true),
      row("i2", "session_idle", 1050, false),
      row("i1", "session_idle", 1000, true),
    ];
    expect((group(rows)[0] as any).unread).toBe(1);
  });
});

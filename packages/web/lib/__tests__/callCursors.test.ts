import { describe, expect, test } from "bun:test";
import {
  CURSOR_IDLE_MS,
  applyCursorMessage,
  decodeCursorMessage,
  encodeCursorMessage,
  expireCursors,
  nextCursorExpiryAt,
  shouldSendCursor,
  type CursorState,
} from "../calls/callCursors";

describe("call cursor wire", () => {
  test("a move round trips, with points clamped to the frame", () => {
    const msg = decodeCursorMessage(encodeCursorMessage({ t: "cursor", sid: "TR_1", nx: 1.4, ny: -0.2, at: 10 }));
    expect(msg).toEqual({ t: "cursor", sid: "TR_1", nx: 1, ny: 0, at: 10 });
  });

  test("a gone message keeps only the share it left", () => {
    expect(decodeCursorMessage(encodeCursorMessage({ t: "cursor", sid: "TR_1", gone: true, at: 5 }))).toEqual({ t: "cursor", sid: "TR_1", gone: true, at: 5 });
  });

  test("malformed payloads are dropped", () => {
    const enc = new TextEncoder();
    expect(decodeCursorMessage(enc.encode("nope"))).toBeNull();
    expect(decodeCursorMessage(enc.encode(JSON.stringify({ t: "other", sid: "x", nx: 0, ny: 0 })))).toBeNull();
    expect(decodeCursorMessage(enc.encode(JSON.stringify({ t: "cursor", sid: "", nx: 0, ny: 0 })))).toBeNull();
    expect(decodeCursorMessage(enc.encode(JSON.stringify({ t: "cursor", sid: "x", nx: "a", ny: 0 })))).toBeNull();
  });
});

describe("call cursor state", () => {
  const empty: CursorState = new Map();

  test("a move adds or replaces one person's cursor and keeps the name", () => {
    const s1 = applyCursorMessage(empty, "u1", "Ann Lee", { t: "cursor", sid: "TR", nx: 0.2, ny: 0.3, at: 100 }, 100);
    expect(s1.get("u1")).toEqual({ identity: "u1", name: "Ann Lee", sid: "TR", nx: 0.2, ny: 0.3, at: 100 });
    const s2 = applyCursorMessage(s1, "u1", "Ann Lee", { t: "cursor", sid: "TR", nx: 0.5, ny: 0.5, at: 200 }, 200);
    expect(s2.get("u1")?.nx).toBe(0.5);
    expect(s2.size).toBe(1);
  });

  test("a reordered older move is dropped and returns the same map", () => {
    const s1 = applyCursorMessage(empty, "u1", "Ann", { t: "cursor", sid: "TR", nx: 0.2, ny: 0.3, at: 200 }, 200);
    const s2 = applyCursorMessage(s1, "u1", "Ann", { t: "cursor", sid: "TR", nx: 0.9, ny: 0.9, at: 100 }, 250);
    expect(s2).toBe(s1);
  });

  test("gone removes the cursor; gone for nobody changes nothing", () => {
    const s1 = applyCursorMessage(empty, "u1", "Ann", { t: "cursor", sid: "TR", nx: 0.2, ny: 0.3, at: 100 }, 100);
    const s2 = applyCursorMessage(s1, "u1", "Ann", { t: "cursor", sid: "TR", gone: true, at: 150 }, 150);
    expect(s2.size).toBe(0);
    expect(applyCursorMessage(empty, "u9", "Zed", { t: "cursor", sid: "TR", gone: true, at: 1 }, 1)).toBe(empty);
  });

  test("cursors expire on the idle window, and the next expiry is the oldest one", () => {
    let s = applyCursorMessage(empty, "u1", "Ann", { t: "cursor", sid: "TR", nx: 0, ny: 0, at: 1000 }, 1000);
    s = applyCursorMessage(s, "u2", "Bob", { t: "cursor", sid: "TR", nx: 0, ny: 0, at: 3000 }, 3000);
    expect(nextCursorExpiryAt(s)).toBe(1000 + CURSOR_IDLE_MS);
    expect(expireCursors(s, 1000 + CURSOR_IDLE_MS - 1)).toBe(s);
    const later = expireCursors(s, 1000 + CURSOR_IDLE_MS);
    expect([...later.keys()]).toEqual(["u2"]);
    expect(nextCursorExpiryAt(new Map())).toBeNull();
  });

  test("sends are paced at about thirty a second", () => {
    expect(shouldSendCursor(1000, 990)).toBe(false);
    expect(shouldSendCursor(1033, 1000)).toBe(true);
  });
});

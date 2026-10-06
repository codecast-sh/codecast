import { describe, expect, test } from "bun:test";
import { SHARED_COLLECTION, checkDoc, checkPresenceState, checkShared, isCollectionName, isSharedKey } from "./appData";
import { MAX_DATA_DEPTH, MAX_DATA_DOC_BYTES, MAX_PRESENCE_STATE_BYTES } from "./limits";

const problem = (c: { ok: boolean; problem?: string }) => (c.ok ? null : c.problem);

describe("names", () => {
  test("collections are short and plain; the shared collection is out of reach", () => {
    for (const ok of ["notes", "Guest_book", "scores.2026", "room:1"]) expect(isCollectionName(ok)).toBe(true);
    for (const bad of ["", SHARED_COLLECTION, "_x", "a b", "x".repeat(65), "../x"]) expect(isCollectionName(bad)).toBe(false);
  });

  test("shared keys are any short line", () => {
    expect(isSharedKey("waves")).toBe(true);
    expect(isSharedKey("score for 🐸")).toBe(true);
    expect(isSharedKey("")).toBe(false);
    expect(isSharedKey("a\nb")).toBe(false);
  });
});

describe("checkDoc", () => {
  test("keeps the object, drops the fields the SDK adds, and measures it", () => {
    const c = checkDoc({ text: "hi", n: 2, _id: "x", _by: {}, _at: 1 });
    expect(c).toEqual({ ok: true, value: { text: "hi", n: 2 }, size: JSON.stringify({ text: "hi", n: 2 }).length });
  });

  test("a doc is a plain object", () => {
    for (const bad of [null, 1, "s", [1], new Date()]) expect(problem(checkDoc(bad))).toContain("plain object");
  });

  test("refuses what the database cannot hold, saying where", () => {
    expect(problem(checkDoc({ $set: 1 }))).toContain(`"$set"`);
    expect(problem(checkDoc({ a: { b: NaN } }))).toContain("finite");
    expect(problem(checkDoc({ f: () => 1 }))).toContain("function");
    let deep: unknown = 1;
    for (let i = 0; i <= MAX_DATA_DEPTH; i++) deep = [deep];
    expect(problem(checkDoc({ deep }))).toContain("nesting");
  });

  test("caps the size", () => {
    expect(problem(checkDoc({ s: "x".repeat(MAX_DATA_DOC_BYTES) }))).toContain(`limit is ${MAX_DATA_DOC_BYTES}`);
  });
});

describe("shared values and presence state", () => {
  test("a shared value may be any JSON value", () => {
    for (const ok of [0, "s", null, [1, 2], { a: 1 }]) expect(checkShared(ok).ok).toBe(true);
    expect(checkShared(undefined).ok).toBe(false);
  });

  test("presence state is a small object", () => {
    expect(checkPresenceState({ x: 0.5, y: 0.25 }).ok).toBe(true);
    expect(problem(checkPresenceState([1]))).toContain("plain object");
    expect(problem(checkPresenceState({ s: "x".repeat(MAX_PRESENCE_STATE_BYTES) }))).toContain("limit");
  });
});

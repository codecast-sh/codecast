import { expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";

test("normalizeId recognizes late fixture rows and retains table identity after deletion", async () => {
  const db = makeFakeDb({ conversations: [{ _id: "initial" }] });
  db._tables.conversations.push({ _id: "late" });
  for (const id of ["initial", "late", await db.insert("conversations", {})]) {
    expect(db.normalizeId("conversations", id)).toBe(id);
    expect(db.normalizeId("users", id)).toBeNull();
    await db.delete(id);
    expect(await db.get(id)).toBeNull();
    expect(db.normalizeId("conversations", id)).toBe(id);
    expect(db.normalizeId("users", id)).toBeNull();
  }
  expect(db.normalizeId("conversations", "unknown")).toBeNull();
});

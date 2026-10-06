import { expect, test } from "bun:test";
import { hasCollectionRows } from "./hasCollectionRows";

test("reuses both empty and populated immutable collections", () => {
  for (const rows of [{}, { a: {} }]) {
    let scans = 0;
    const proxy = new Proxy(rows, { ownKeys: (target) => { scans++; return Reflect.ownKeys(target); } });
    const expected = Object.keys(rows).length > 0;
    expect(hasCollectionRows(proxy)).toBe(expected);
    expect(hasCollectionRows(proxy)).toBe(expected);
    expect(scans).toBe(1);
  }
});

test("observes creates and removes and ignores inherited rows", () => {
  expect(hasCollectionRows({})).toBe(false);
  expect(hasCollectionRows({ a: {} })).toBe(true);
  expect(hasCollectionRows({})).toBe(false);
  expect(hasCollectionRows(Object.create({ a: {} }))).toBe(false);
});

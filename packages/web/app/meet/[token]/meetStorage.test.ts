import { expect, test } from "bun:test";
import { clearCreds, readCreds, readMediaPrefs, readName, writeCreds, writeMediaPrefs, writeName } from "./meetStorage";

function memory() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

test("credentials are kept per link: two links in one browser are two guests", () => {
  const s = memory();
  writeCreds("link-a", { guest_id: "g1", secret: "s".repeat(32) }, s);
  expect(readCreds("link-a", s)).toEqual({ guest_id: "g1", secret: "s".repeat(32) });
  expect(readCreds("link-b", s)).toBeNull();
  clearCreds("link-a", s);
  expect(readCreds("link-a", s)).toBeNull();
});

test("a malformed or short secret reads as no guest at all", () => {
  const s = memory();
  s.setItem("codecast:guest:link:x", JSON.stringify({ guest_id: "g1", secret: "short" }));
  expect(readCreds("x", s)).toBeNull();
  s.setItem("codecast:guest:link:y", "{not json");
  expect(readCreds("y", s)).toBeNull();
});

test("the name is remembered cleaned, and the room's own guest mark never sticks to it", () => {
  const s = memory();
  writeName("  Ada   Lovelace (guest) ", s);
  expect(readName(s)).toBe("Ada Lovelace");
  writeName("   ", s);
  expect(readName(s)).toBe("Ada Lovelace");
});

test("devices default on, and a guest's choice to keep one off is remembered", () => {
  const s = memory();
  expect(readMediaPrefs(s)).toEqual({ mic: true, camera: true });
  writeMediaPrefs({ mic: true, camera: false, micId: "m1" }, s);
  expect(readMediaPrefs(s)).toEqual({ mic: true, camera: false, micId: "m1" });
});

test("no storage at all (blocked) still answers", () => {
  expect(readCreds("x", null)).toBeNull();
  expect(readName(null)).toBe("");
  expect(readMediaPrefs(null)).toEqual({ mic: true, camera: true });
});

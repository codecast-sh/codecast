import { describe, expect, test } from "bun:test";
import { clipText, makeWellFormedDb, wellFormedValue } from "./wellFormed";

const emoji = "😀"; // two UTF-16 units

describe("wellFormed", () => {
  test("clipText never ends on half a surrogate pair", () => {
    const s = `ab${emoji}cd`;
    expect(clipText(s, 3)).toBe("ab");
    expect(clipText(s, 4)).toBe(`ab${emoji}`);
    expect(clipText(s, 10)).toBe(s);
    expect(JSON.stringify(clipText(s, 3))).not.toContain("\\ud");
  });

  test("lone halves become U+FFFD, whole pairs stay, untouched values keep their reference", () => {
    const cut = `ab${emoji}`.slice(0, 3);
    const doc = { a: cut, b: [`x${emoji.slice(1)}`, "ok"], c: { d: emoji }, n: 1 };
    const out = wellFormedValue(doc);
    expect(out).toEqual({ a: "ab�", b: ["x�", "ok"], c: { d: emoji }, n: 1 });
    expect(out.c).toBe(doc.c);
    const clean = { a: "fine", b: [emoji] };
    expect(wellFormedValue(clean)).toBe(clean);
  });

  test("the db wrapper repairs the value argument of every write overload", async () => {
    const calls: any[][] = [];
    const db: any = { normalizeId: () => null, insert: (...a: any[]) => calls.push(a), patch: (...a: any[]) => calls.push(a), replace: (...a: any[]) => calls.push(a) };
    const w = makeWellFormedDb(db);
    const half = emoji.slice(0, 1);
    await w.insert("t", { s: half });
    await w.patch("id", { s: half });
    await w.patch("t", "id", { s: half });
    await w.replace("id", { s: half });
    expect(calls).toEqual([["t", { s: "�" }], ["id", { s: "�" }], ["t", "id", { s: "�" }], ["id", { s: "�" }]]);
  });
});

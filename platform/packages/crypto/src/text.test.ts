import { describe, expect, it } from "bun:test";
import { decodeUTF8, encodeUTF8, normalizeNFKD } from "./text";

const hex = (b: Uint8Array) =>
  Array.from(b)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");

describe("text", () => {
  it("encodes UTF-8 the standard way", () => {
    expect(hex(encodeUTF8("A"))).toBe("41");
    expect(hex(encodeUTF8("ü"))).toBe("c3bc");
    expect(hex(encodeUTF8("✓"))).toBe("e29c93");
    expect(hex(encodeUTF8("🎉"))).toBe("f09f8e89");
    expect(encodeUTF8("").length).toBe(0);
  });

  it("round trips text", () => {
    for (const s of ["", "hello", "ünïcode ✓ 日本語 🎉", "line\nbreak\ttab"]) {
      expect(decodeUTF8(encodeUTF8(s))).toBe(s);
    }
  });

  it("replaces bytes that are not valid UTF-8 when decoding", () => {
    expect(decodeUTF8(new Uint8Array([0xff, 0xfe]))).toBe("\ufffd\ufffd");
  });

  it("normalizes to NFKD, so the same text compares equal however it was typed", () => {
    // A precomposed u-with-diaeresis and a u followed by a combining
    // diaeresis are the same text; NFKD decomposes both to the same form.
    expect(normalizeNFKD("\u00fc")).toBe("u\u0308");
    expect(normalizeNFKD("\u00fc")).toBe(normalizeNFKD("u\u0308"));
    // The compatibility half of NFKD folds the fi ligature into its letters.
    expect(normalizeNFKD("\ufb01")).toBe("fi");
  });
});

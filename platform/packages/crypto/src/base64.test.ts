import { describe, expect, it } from "bun:test";
import { decodeBase64, encodeBase64 } from "./base64";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const hex = (b: Uint8Array) =>
  Array.from(b)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");

describe("base64 known answers", () => {
  // RFC 4648 section 10. Every padding case is covered.
  const vectors: Array<[string, string, string]> = [
    ["", "", ""],
    ["f", "Zg==", "Zg"],
    ["fo", "Zm8=", "Zm8"],
    ["foo", "Zm9v", "Zm9v"],
    ["foob", "Zm9vYg==", "Zm9vYg"],
    ["fooba", "Zm9vYmE=", "Zm9vYmE"],
    ["foobar", "Zm9vYmFy", "Zm9vYmFy"],
  ];

  it("encodes standard base64 with padding", () => {
    for (const [plain, standard] of vectors) {
      expect(encodeBase64(bytes(plain))).toBe(standard);
    }
  });

  it("encodes base64url without padding and with the two swapped characters", () => {
    for (const [plain, , url] of vectors) {
      expect(encodeBase64(bytes(plain), "base64url")).toBe(url);
    }
    // The bytes that produce + and / in standard base64 produce - and _ here.
    const high = new Uint8Array([0xfb, 0xff, 0xbe, 0x00, 0x7f]);
    expect(encodeBase64(high)).toBe("+/++AH8=");
    expect(encodeBase64(high, "base64url")).toBe("-_--AH8");
  });

  it("decodes both encodings back to the same bytes", () => {
    for (const [plain, standard, url] of vectors) {
      expect(text(decodeBase64(standard))).toBe(plain);
      expect(text(decodeBase64(url, "base64url"))).toBe(plain);
    }
    const high = new Uint8Array([0xfb, 0xff, 0xbe, 0x00, 0x7f]);
    expect(hex(decodeBase64("-_--AH8", "base64url"))).toBe("fbffbe007f");
    expect(hex(decodeBase64("+/++AH8="))).toBe("fbffbe007f");
  });
});

describe("base64 edge cases", () => {
  it("round trips every byte value", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(hex(decodeBase64(encodeBase64(all)))).toBe(hex(all));
    expect(hex(decodeBase64(encodeBase64(all, "base64url"), "base64url"))).toBe(hex(all));
  });

  it("puts the padding back when decoding base64url", () => {
    // One byte encodes to two characters, which needs two = signs restored.
    expect(decodeBase64("AA", "base64url").length).toBe(1);
    expect(decodeBase64("AAE", "base64url").length).toBe(2);
    expect(decodeBase64("AAEC", "base64url").length).toBe(3);
    expect(decodeBase64("AA==").length).toBe(1);
  });

  it("throws on input that is not base64", () => {
    expect(() => decodeBase64("!!!!")).toThrow();
    // A url encoded string read as standard base64: - and _ are not normalized,
    // so the caller must pass the encoding it used.
    expect(() => decodeBase64("-_--AH8")).toThrow();
    // A length of 4n+1 cannot be valid base64; the padding repair cannot save it.
    expect(() => decodeBase64("abcde", "base64url")).toThrow();
  });

  it("encodes a payload far larger than one call to fromCharCode can take", () => {
    // The old code passed every byte as a separate argument to
    // String.fromCharCode. That call overflows the stack above roughly half a
    // million bytes; one megabyte throws. The output is checked against Buffer,
    // character for character, so the chunking cannot drift.
    const big = new Uint8Array(1024 * 1024);
    for (let i = 0; i < big.length; i += 65536) {
      crypto.getRandomValues(big.subarray(i, i + 65536));
    }

    expect(encodeBase64(big)).toBe(Buffer.from(big).toString("base64"));
    expect(encodeBase64(big, "base64url")).toBe(Buffer.from(big).toString("base64url"));
    expect(Buffer.from(decodeBase64(encodeBase64(big))).equals(Buffer.from(big))).toBe(true);

    // A length either side of the chunk boundary still lands right.
    for (const length of [0x8000 - 1, 0x8000, 0x8000 + 1, 0x10000 + 7]) {
      const slice = big.subarray(0, length);
      expect(encodeBase64(slice)).toBe(Buffer.from(slice).toString("base64"));
      expect(encodeBase64(slice, "base64url")).toBe(Buffer.from(slice).toString("base64url"));
    }
  });

  it("treats the empty string as zero bytes", () => {
    expect(decodeBase64("").length).toBe(0);
    expect(encodeBase64(new Uint8Array(0))).toBe("");
  });
});

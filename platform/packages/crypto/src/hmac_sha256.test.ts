import { describe, expect, it } from "bun:test";
import { encodeHex, timingSafeEqual } from "./hex";
import { hmac_sha256, hmacSha256Hex } from "./hmac_sha256";

const ascii = (s: string) => new TextEncoder().encode(s);

describe("hmac_sha256 known answers", () => {
  // RFC 4231, the published HMAC-SHA-256 test vectors.
  it("matches RFC 4231 test case 1", async () => {
    const digest = await hmac_sha256(new Uint8Array(20).fill(0x0b), ascii("Hi There"));
    expect(encodeHex(digest)).toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
    expect(digest.length).toBe(32);
  });

  it("matches RFC 4231 test case 2", async () => {
    const digest = await hmac_sha256(ascii("Jefe"), ascii("what do ya want for nothing?"));
    expect(encodeHex(digest)).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("hmacSha256Hex gives the same answer for text key and data", async () => {
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });
});

describe("encodeHex", () => {
  it("writes two lowercase characters per byte", () => {
    expect(encodeHex(new Uint8Array([0, 1, 15, 16, 171, 255]))).toBe("00010f10abff");
    expect(encodeHex(new Uint8Array())).toBe("");
  });
});

describe("timingSafeEqual", () => {
  it("is true only for identical strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

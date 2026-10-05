import { describe, expect, it } from "bun:test";
import { hmac_sha512 } from "./hmac_sha512";

const hex = (b: Uint8Array) =>
  Array.from(b)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
const ascii = (s: string) => new TextEncoder().encode(s);

describe("hmac_sha512 known answers", () => {
  // RFC 4231, the published HMAC-SHA-512 test vectors. The donor produces
  // these exactly, so a change to the primitive breaks this test.
  it("matches RFC 4231 test case 1", async () => {
    const digest = await hmac_sha512(new Uint8Array(20).fill(0x0b), ascii("Hi There"));
    expect(hex(digest)).toBe(
      "87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cde" +
        "daa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854",
    );
    expect(digest.length).toBe(64);
  });

  it("matches RFC 4231 test case 2", async () => {
    const digest = await hmac_sha512(ascii("Jefe"), ascii("what do ya want for nothing?"));
    expect(hex(digest)).toBe(
      "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea250554" +
        "9758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737",
    );
  });

  it("matches RFC 4231 test case 7, whose key is longer than the block", async () => {
    const digest = await hmac_sha512(
      new Uint8Array(131).fill(0xaa),
      ascii(
        "This is a test using a larger than block-size key and a larger than " +
          "block-size data. The key needs to be hashed before being used by the " +
          "HMAC algorithm.",
      ),
    );
    expect(hex(digest)).toBe(
      "e37b6a775dc87dbaa4dfa9f96e5e3ffddebd71f8867289865df5a32d20cdc944" +
        "b6022cac3c4982b10d5eeb55c3e4de15134676fb6de0446065c97440fa8c6a58",
    );
  });

  it("changes completely when the key or the data changes by one bit", async () => {
    const a = hex(await hmac_sha512(ascii("key"), ascii("data")));
    const b = hex(await hmac_sha512(ascii("keys"), ascii("data")));
    const c = hex(await hmac_sha512(ascii("key"), ascii("datb")));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

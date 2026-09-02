import { describe, expect, it } from "bun:test";
import { sha256Hex, verifySha256 } from "./checksum";

const abc = new TextEncoder().encode("abc");
const ABC_SHA = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("checksum", () => {
  it("hashes fixture bytes", async () => {
    expect(await sha256Hex(abc)).toBe(ABC_SHA);
    expect(await sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
  it("hashes a subarray view correctly", async () => {
    const buf = new TextEncoder().encode("xxabcyy");
    expect(await sha256Hex(buf.subarray(2, 5))).toBe(ABC_SHA);
  });
  it("verifies case insensitively and reports both digests", async () => {
    expect((await verifySha256(abc, ABC_SHA.toUpperCase())).ok).toBe(true);
    const bad = await verifySha256(abc, "00".repeat(32));
    expect(bad.ok).toBe(false);
    expect(bad.actual).toBe(ABC_SHA);
  });
});

import { describe, expect, it } from "bun:test";
import { deriveKey, deriveSecretKeyTreeChild, deriveSecretKeyTreeRoot } from "./deriveKey";

const hex = (b: Uint8Array) =>
  Array.from(b)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");

/** The seed used for every vector below: the bytes 0 through 31. */
const master = new Uint8Array(32);
for (let i = 0; i < 32; i++) master[i] = i;

describe("deriveKey known answers", () => {
  // These come from running the donor implementation
  // (codecast packages/shared/encryption/deriveKey.ts) on the seed above. They
  // pin the derivation byte for byte, so any change to the tree, the labels or
  // the child prefix breaks this test instead of silently locking data out.
  it("derives the root from the seed and the usage label", async () => {
    const root = await deriveSecretKeyTreeRoot(master, "messages");
    expect(hex(root.key)).toBe("a006cc9f7fe8387dc07c4fbc3c0d81cc5d7d514c7bff5e610e742b2d89e0d536");
    expect(hex(root.chainCode)).toBe(
      "f6e561c663d7319f25af06bdcdcd57e69d65fb2aff834804e18cda9ab4a8e80f",
    );
    expect(root.key.length).toBe(32);
    expect(root.chainCode.length).toBe(32);
  });

  it("derives a child from the chain code and the index", async () => {
    const root = await deriveSecretKeyTreeRoot(master, "messages");
    const child = await deriveSecretKeyTreeChild(root.chainCode, "session-123");
    expect(hex(child.key)).toBe("a7c9803e8386ec644971fa39d01a3e63cc57bba6a99b12ea76512945f019e852");
    expect(hex(child.chainCode)).toBe(
      "e151b500e5c7c774596426c47b27c2be8b376aa9c4ed6971bc2cdc179a8e80c9",
    );
  });

  it("walks a path", async () => {
    expect(hex(await deriveKey(master, "messages", ["session-123"]))).toBe(
      "a7c9803e8386ec644971fa39d01a3e63cc57bba6a99b12ea76512945f019e852",
    );
    expect(hex(await deriveKey(master, "messages", ["a", "b"]))).toBe(
      "72a57b5f33dfac4ec3c2b0e46367873909d51e1e05b546c4baced9469ca74a65",
    );
  });

  it("returns the root key for an empty path", async () => {
    expect(hex(await deriveKey(master, "messages", []))).toBe(
      "a006cc9f7fe8387dc07c4fbc3c0d81cc5d7d514c7bff5e610e742b2d89e0d536",
    );
  });
});

describe("deriveKey separation", () => {
  it("separates usages, paths, path order and seeds", async () => {
    const messages = hex(await deriveKey(master, "messages", ["session-123"]));
    expect(hex(await deriveKey(master, "attachments", ["session-123"]))).not.toBe(messages);
    expect(hex(await deriveKey(master, "messages", ["session-124"]))).not.toBe(messages);
    expect(hex(await deriveKey(master, "messages", ["a", "b"]))).not.toBe(
      hex(await deriveKey(master, "messages", ["b", "a"])),
    );
    const otherSeed = new Uint8Array(32).fill(9);
    expect(hex(await deriveKey(otherSeed, "messages", ["session-123"]))).not.toBe(messages);
  });

  it("is deterministic, which is the whole point", async () => {
    const once = hex(await deriveKey(master, "messages", ["x", "y", "z"]));
    const twice = hex(await deriveKey(master, "messages", ["x", "y", "z"]));
    expect(once).toBe(twice);
  });

  it("gives every derived key the 32 bytes AES-256 needs", async () => {
    expect((await deriveKey(master, "messages", ["a"])).length).toBe(32);
    expect((await deriveKey(master, "messages", ["a", "b", "c", "d"])).length).toBe(32);
  });
});

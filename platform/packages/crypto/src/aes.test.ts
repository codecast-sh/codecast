import { describe, expect, it } from "bun:test";
import {
  decryptAESGCM,
  decryptAESGCMString,
  encryptAESGCM,
  encryptAESGCMString,
} from "./aes";
import { decodeBase64, encodeBase64 } from "./base64";
import { deriveKey } from "./deriveKey";

const hex = (b: Uint8Array) =>
  Array.from(b)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");

const fromHex = (s: string) =>
  new Uint8Array((s.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

const master = new Uint8Array(32);
for (let i = 0; i < 32; i++) master[i] = i;

/** The key the frozen ciphertext below was sealed to. */
const KEY64 = "p8mAPoOG7GRJcfo50Bo+Y8xXu6apmxLqdlEpRfAZ6FI=";
/** A message the donor encrypted under that key. */
const DONOR_CIPHERTEXT =
  "7cXkTNokbyYpbvpwcwccxZHuZYuz2MzB6gI8oy6oCEcg+GEXj4ENQqvcUB9f6Qqo38dN53MYjCg3d8hUg8b7pis=";
const DONOR_PLAINTEXT = "the quick brown fox — ünïcode ✓";

describe("aes known answer", () => {
  it("decrypts a ciphertext the donor produced", async () => {
    // The IV is random, so the fixed answer runs the other way: this ciphertext
    // was written by codecast's own encryption module. Decrypting it proves the
    // cipher, the key size, the IV layout and the tag handling all still match.
    expect(await decryptAESGCMString(DONOR_CIPHERTEXT, KEY64)).toBe(DONOR_PLAINTEXT);
  });

  it("derives that same key from the frozen seed", async () => {
    expect(encodeBase64(await deriveKey(master, "messages", ["session-123"]))).toBe(KEY64);
  });
});

describe("aes round trip", () => {
  it("returns what it was given", async () => {
    for (const message of [
      "hello",
      "",
      "a much longer message ".repeat(200),
      "ünïcode ✓ 日本語 🎉",
      JSON.stringify({ nested: { data: [1, 2, 3] } }),
    ]) {
      const sealed = await encryptAESGCMString(message, KEY64);
      expect(await decryptAESGCMString(sealed, KEY64)).toBe(message);
    }
  });

  it("uses a fresh random IV every time", async () => {
    const a = await encryptAESGCMString("hello", KEY64);
    const b = await encryptAESGCMString("hello", KEY64);
    expect(a).not.toBe(b);
    // 12 byte IV, then the ciphertext, then the 16 byte tag.
    expect(decodeBase64(a).length).toBe(12 + "hello".length + 16);
    expect(decodeBase64(a).slice(0, 12)).not.toEqual(decodeBase64(b).slice(0, 12));
  });

  it("returns null rather than throwing when it cannot decrypt", async () => {
    const sealed = await encryptAESGCMString("secret", KEY64);
    const wrongKey = encodeBase64(new Uint8Array(32).fill(8));
    expect(await decryptAESGCMString(sealed, wrongKey)).toBeNull();
    expect(await decryptAESGCMString("not base64 at all!!", KEY64)).toBeNull();
    expect(await decryptAESGCMString(sealed, encodeBase64(new Uint8Array(31)))).toBeNull();
  });

  it("refuses a tampered ciphertext, which is what the GCM tag is for", async () => {
    const sealed = decodeBase64(await encryptAESGCMString("transfer 10", KEY64));
    const flipped = new Uint8Array(sealed);
    flipped[20] ^= 0x01;
    expect(await decryptAESGCMString(encodeBase64(flipped), KEY64)).toBeNull();
    // A flipped IV byte fails too: the tag covers the nonce it was computed with.
    const flippedIv = new Uint8Array(sealed);
    flippedIv[0] ^= 0x01;
    expect(await decryptAESGCMString(encodeBase64(flippedIv), KEY64)).toBeNull();
  });

  it("throws when the key is not 32 bytes, instead of encrypting weakly", async () => {
    await expect(encryptAESGCMString("x", encodeBase64(new Uint8Array(31)))).rejects.toThrow();
  });
});

describe("aes binary helpers", () => {
  it("round trips bytes that are valid UTF-8", async () => {
    const data = new TextEncoder().encode("plain ascii and ünïcode");
    const back = await decryptAESGCM(await encryptAESGCM(data, KEY64), KEY64);
    expect(back).not.toBeNull();
    expect(hex(back!)).toBe(hex(data));
  });

  it("round trips bytes that are not valid UTF-8", async () => {
    // The old code read its input as UTF-8 text, so every byte that is not valid
    // UTF-8 became the replacement character before it was ever encrypted. These
    // four bytes came back as efbfbdefbfbd0041, eight bytes, and the original two
    // were gone. The functions now encrypt the bytes they are given.
    const data = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    const back = await decryptAESGCM(await encryptAESGCM(data, KEY64), KEY64);
    expect(hex(back!)).toBe("fffe0041");
    expect(hex(back!)).not.toBe("efbfbdefbfbd0041");
  });

  it("round trips every shape of byte that UTF-8 would have rejected", async () => {
    for (const data of [
      new Uint8Array(256).map((_, i) => i), // every byte value, in order
      new Uint8Array([0x80, 0x81, 0xbf]), // continuation bytes with nothing to continue
      new Uint8Array([0xc3]), // a two byte sequence cut in half
      new Uint8Array([0xe2, 0x9c]), // a three byte sequence cut short
      new Uint8Array([0xed, 0xa0, 0x80]), // a surrogate, which UTF-8 forbids
      new Uint8Array([0xf8, 0xff, 0xfe, 0xfd]), // byte values UTF-8 never uses
      new Uint8Array([0x00, 0x00, 0x00, 0x00]),
      new Uint8Array(0),
    ]) {
      const back = await decryptAESGCM(await encryptAESGCM(data, KEY64), KEY64);
      expect(back).not.toBeNull();
      expect(hex(back!)).toBe(hex(data));
    }
  });

  it("round trips a large binary payload", async () => {
    // One megabyte of random bytes, which is what a file or an image looks like.
    // Almost none of it is valid UTF-8, and it is far past the point where the
    // base64 helpers used to overflow the stack.
    const data = new Uint8Array(1024 * 1024);
    for (let i = 0; i < data.length; i += 65536) {
      crypto.getRandomValues(data.subarray(i, i + 65536));
    }
    const sealed = await encryptAESGCM(data, KEY64);
    expect(sealed.length).toBe(12 + data.length + 16);
    const back = await decryptAESGCM(sealed, KEY64);
    expect(back).not.toBeNull();
    expect(hex(back!)).toBe(hex(data));
  });

  it("gives valid UTF-8 callers the same plaintext they had before", async () => {
    // Every caller today passes keys, tokens and text, so this is the case that
    // must not move. The two frozen ciphertexts below were written by the old
    // code. Both still decrypt, and both give back exactly the bytes the old
    // code gave back, so stored data reads the same as it always did.
    const oldSealedText = fromHex(
      "8ba8248d3a383f6e476b3b45738d9fb063ed7231db02deb0af9833736a2a6d" +
        "6a5142327f15af821f7c6926d547c717a7c32df1f0acaf5c2807"
    );
    const plain = new TextEncoder().encode("plain ascii and ünïcode ✓");
    expect(hex((await decryptAESGCM(oldSealedText, KEY64))!)).toBe(hex(plain));

    // The old code turned these four bytes into eight before encrypting. Those
    // eight bytes are what is actually sealed in here, and reading them back
    // unchanged is what backward compatibility means: the fix does not rewrite
    // history, it stops the loss from happening again.
    const oldSealedBinary = fromHex(
      "7c3af13cadaa3f703f3f3393bd9007f88d23e1c046ac7afbf34815ed96afba7de347e685"
    );
    expect(hex((await decryptAESGCM(oldSealedBinary, KEY64))!)).toBe("efbfbdefbfbd0041");

    // Text sealed by the old string path reads back as the same string.
    expect(await decryptAESGCMString(DONOR_CIPHERTEXT, KEY64)).toBe(DONOR_PLAINTEXT);
    // And new ciphertext of valid UTF-8 holds exactly the bytes the caller gave.
    const fresh = await decryptAESGCM(await encryptAESGCM(plain, KEY64), KEY64);
    expect(hex(fresh!)).toBe(hex(plain));
  });

  it("keeps the layout the old code used: 12 byte nonce, then the 16 byte tag", async () => {
    const data = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    const sealed = await encryptAESGCM(data, KEY64);
    expect(sealed.length).toBe(12 + data.length + 16);
    const again = await encryptAESGCM(data, KEY64);
    expect(hex(sealed.slice(0, 12))).not.toBe(hex(again.slice(0, 12)));
    // The string path writes the same layout, and the two paths read each other.
    const viaString = decodeBase64(await encryptAESGCMString("hello", KEY64));
    expect(viaString.length).toBe(12 + 5 + 16);
    expect(hex((await decryptAESGCM(viaString, KEY64))!)).toBe(hex(new TextEncoder().encode("hello")));
    expect(await decryptAESGCMString(encodeBase64(await encryptAESGCM(new TextEncoder().encode("hi"), KEY64)), KEY64)).toBe("hi");
  });

  it("returns zero bytes for an empty payload rather than null", async () => {
    // The old code returned null here, because it tested the decrypted text for
    // truthiness and the empty string is falsy. Nothing failed, so nothing
    // should look like a failure.
    const sealed = await encryptAESGCM(new Uint8Array(0), KEY64);
    const back = await decryptAESGCM(sealed, KEY64);
    expect(back).not.toBeNull();
    expect(back!.length).toBe(0);
  });

  it("returns null when the binary decrypt fails", async () => {
    const sealed = await encryptAESGCM(new TextEncoder().encode("hi"), KEY64);
    expect(await decryptAESGCM(sealed, encodeBase64(new Uint8Array(32).fill(3)))).toBeNull();
    // A wrong key length, a flipped byte and a payload too short to hold a tag
    // all fail the same quiet way.
    expect(await decryptAESGCM(sealed, encodeBase64(new Uint8Array(31)))).toBeNull();
    const flipped = new Uint8Array(sealed);
    flipped[flipped.length - 1] ^= 0x01;
    expect(await decryptAESGCM(flipped, KEY64)).toBeNull();
    expect(await decryptAESGCM(new Uint8Array(4), KEY64)).toBeNull();
  });

  it("throws when the key is not 32 bytes, instead of encrypting weakly", async () => {
    await expect(encryptAESGCM(new Uint8Array([1, 2, 3]), encodeBase64(new Uint8Array(31)))).rejects.toThrow();
  });
});

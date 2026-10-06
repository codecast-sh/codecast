import { describe, expect, test } from "bun:test";
import { formatMessageHash, parseMessageHash } from "./messageHash";

describe("message hash", () => {
  test("round trips a message and a paragraph", () => {
    expect(parseMessageHash(formatMessageHash("k176qce1"))).toEqual({ messageId: "k176qce1" });
    expect(formatMessageHash("k176qce1", 2)).toBe("#msg-k176qce1.p3");
    expect(parseMessageHash("#msg-k176qce1.p3")).toEqual({ messageId: "k176qce1", block: 2 });
  });
  test("ignores other fragments and a zero paragraph", () => {
    expect(parseMessageHash("#top")).toBeNull();
    expect(parseMessageHash("#msg-")).toBeNull();
    expect(parseMessageHash("#msg-abc.p0")).toEqual({ messageId: "abc.p0" });
  });
});

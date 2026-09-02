import { describe, expect, test } from "bun:test";
import { hueFor, initials } from "../avatarInitials";

// The letters a name gets when it has no picture: one rule for a teammate's
// avatar fallback and a channel's tile in the narrow rail.
describe("initials", () => {
  test("a person: first and last", () => {
    expect(initials("Ada Lovelace", 2)).toBe("AL");
    expect(initials("Ada Lovelace", 1)).toBe("A");
    expect(initials("ada", 2)).toBe("AD");
  });
  test("a channel: punctuation splits words, so a slug is not one word", () => {
    expect(initials("chat-smoke", 2)).toBe("CS");
    expect(initials("release_notes", 2)).toBe("RN");
    expect(initials("team", 2)).toBe("TE");
    expect(initials("chat-smoke", 1)).toBe("C");
  });
  test("nothing is a question mark", () => {
    expect(initials("", 2)).toBe("?");
    expect(initials("   ", 1)).toBe("?");
  });
});

describe("hueFor", () => {
  test("is stable and differs between names", () => {
    expect(hueFor("team")).toBe(hueFor("team"));
    expect(hueFor("team")).toMatch(/^#[0-9a-f]{6}$/);
    const hues = new Set(["team", "chat-smoke", "general", "ops", "design"].map(hueFor));
    expect(hues.size).toBeGreaterThan(1);
  });
});

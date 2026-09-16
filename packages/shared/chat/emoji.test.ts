import { describe, expect, test } from "bun:test";
import { emojiToShortcode, replaceShortcodes, shortcodeToEmoji } from "./emoji";

describe("emoji shortcodes", () => {
  test("rotating_light and the rest of Slack's standard set become glyphs", () => {
    expect(shortcodeToEmoji("rotating_light")).toBe("🚨");
    expect(shortcodeToEmoji(":rotating_light:")).toBe("🚨");
    expect(replaceShortcodes(":rotating_light: credits gone")).toBe("🚨 credits gone");
    expect(replaceShortcodes("ship it :rocket: :+1::skin-tone-3: :unknown_thing:")).toBe(
      "ship it 🚀 👍 :unknown_thing:",
    );
  });

  test("a time like 10:30: is not an emoji", () => {
    expect(replaceShortcodes("at 10:30:45 sharp")).toBe("at 10:30:45 sharp");
  });

  test("round trips the common reactions", () => {
    for (const name of ["+1", "heart", "eyes", "white_check_mark", "tada", "rocket", "fire", "joy", "pray"]) {
      const glyph = shortcodeToEmoji(name)!;
      expect(glyph).toBeTruthy();
      expect(emojiToShortcode(glyph)).toBe(name);
    }
  });

  test("thumbsup aliases to +1 and tones are stripped", () => {
    expect(shortcodeToEmoji(":thumbsup:")).toBe("👍");
    expect(emojiToShortcode("👍🏽")).toBe("+1");
    expect(emojiToShortcode("❤")).toBe("heart");
    expect(emojiToShortcode("xyz")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { ago, chatTime, clock, forkName, ordinal, plural } from "./format";
import { clipLine, clipText } from "../../convex/lib/text";

const NOW = new Date("2026-10-06T16:00:00").getTime();
const MIN = 60_000;

describe("format", () => {
  test("ordinals read the way people say them", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th"]);
  });

  test("a running build's clock", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(11_400)).toBe("0:11");
    expect(clock(65_000)).toBe("1:05");
  });

  test("chat times: now, minutes, then the clock", () => {
    expect(chatTime(NOW - 20_000, NOW)).toBe("now");
    expect(chatTime(NOW - 2 * MIN, NOW)).toBe("2m");
    expect(chatTime(NOW - 3 * 60 * MIN, NOW)).toMatch(/^1:00$/);
  });

  test("history ages", () => {
    expect(ago(NOW - 10_000, NOW)).toBe("just now");
    expect(ago(NOW - 6 * MIN, NOW)).toBe("6 min ago");
    expect(ago(NOW - 3 * 60 * MIN, NOW)).toBe("3 h ago");
    expect(ago(NOW - 30 * 60 * MIN, NOW)).toBe("yesterday");
  });

  test("plurals and truncation", () => {
    expect(plural(1, "person", "people")).toBe("1 person");
    expect(plural(7, "person", "people")).toBe("7 people");
    expect(plural(2, "version")).toBe("2 versions");
    expect(clipText("Wave hello to everyone", 10)).toBe("Wave hell…");
    expect(clipText("Wave  hello", 6)).toBe("Wave…");
    expect(clipText("short", 10)).toBe("short");
    expect(clipLine("  two\n  lines ", 20)).toBe("two lines");
  });

  test("a fork's suggested name", () => {
    expect(forkName("Guestbook", "Flicker", 40)).toBe("Guestbook, Flicker's take");
    expect(forkName("Guestbook, Flicker's take", "Flicker", 40)).toBe("Guestbook, Flicker's take");
    expect(forkName("Guestbook, Reed's take", "Flicker", 40)).toBe("Guestbook, Flicker's take");
    expect(forkName("A very long app name about tiny planets", "Juniper", 40)).toBe("A very long app name, Juniper's take");
  });
});

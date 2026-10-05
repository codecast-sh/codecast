import { describe, expect, test } from "bun:test";
import { hasLineControlChars, isLineCount, lineProfileContentKey, lineProfileUnchanged, splitFinderKind, type PublishedLineProfile } from "./lineProfile";

// The "unchanged = no write" rule signals.publishProfile applies to every field.
const row: PublishedLineProfile = {
  finders: [{ id: "ci", source: "ci", kind: ["bug"], fingerprint: "ci:<id>" }],
  root: "/src/app", default: true, changed_at: 1, published_at: 1, device_id: "dev-a",
  team: null, project: "App", principles: [], prompting: "p", size_budget: 400, watch_days: 7,
  commands: { check: "cast ws check", prove: null, eval: null, ship: null }, caps: { cards: 5 },
  sources: { team: "default", project: "file" }, notes: [], warnings: [], file: ".codecast/line.toml",
};
const { changed_at: _c, published_at: _p, ...next } = row;

describe("lineProfileUnchanged", () => {
  test("the same profile, with keys in another order, is unchanged", () => {
    expect(lineProfileUnchanged(row, { ...next, sources: { project: "file", team: "default" } })).toBe(true);
  });
  test("any value, the device, the root or the file changes it", () => {
    expect(lineProfileUnchanged(row, { ...next, commands: { ...next.commands!, check: "bun test" } })).toBe(false);
    expect(lineProfileUnchanged(row, { ...next, notes: ["n"] })).toBe(false);
    expect(lineProfileUnchanged(row, { ...next, default: false })).toBe(false);
    expect(lineProfileUnchanged(row, { ...next, device_id: "dev-b" })).toBe(false);
    expect(lineProfileUnchanged(row, { ...next, root: "/elsewhere" })).toBe(false);
    expect(lineProfileUnchanged(row, { ...next, file: null })).toBe(false);
    expect(lineProfileUnchanged(null, next)).toBe(false);
  });
  test("the content key ignores where the profile lives and who published it", () => {
    expect(lineProfileContentKey(row)).toBe(lineProfileContentKey({ ...next, root: "/x", device_id: "dev-b", file: null }));
  });
});

// The value rules the loader, the daemon's editor and the settings page share.
describe("value rules", () => {
  test("a count is a whole number, 1 or more", () => {
    expect([1, 400].every(isLineCount)).toBe(true);
    expect([0, -1, 1.5, NaN, "3", null].some(isLineCount)).toBe(false);
  });
  test("control characters the file cannot hold, delete included; tabs and newlines pass", () => {
    expect(hasLineControlChars("a\u0001b")).toBe(true);
    expect(hasLineControlChars("a\u007fb")).toBe(true);
    expect(hasLineControlChars("a\tb\nc")).toBe(false);
  });
  test("a finder kind as typed: any, a list, or a sentence", () => {
    expect(splitFinderKind(" Any ")).toBe("any");
    expect(splitFinderKind("bug, regression")).toEqual(["bug", "regression"]);
    expect(splitFinderKind("prompt_miss, bug or request")).toEqual(["prompt_miss", "bug", "request"]);
    expect(splitFinderKind("bug regression")).toEqual(["bug", "regression"]);
  });
});

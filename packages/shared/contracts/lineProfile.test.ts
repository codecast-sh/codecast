import { describe, expect, test } from "bun:test";
import { lineProfileContentKey, lineProfileUnchanged, type PublishedLineProfile } from "./lineProfile";

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

import { describe, expect, test } from "bun:test";
import { settingsAfterSnippet, stableModeOf } from "./harnessHooks";

// The server mirrors this onto the device row and the web paints it before the
// daemon reports, so the two can never disagree about one switch.
describe("settingsAfterSnippet", () => {
  test("a snippet lands in the snippets bag, beside the others", () => {
    expect(settingsAfterSnippet({ snippets: { a: true }, hooks_enabled: true }, { snippet: "b", enabled: false })).toEqual({
      snippets: { a: true, b: false },
      hooks_enabled: true,
    });
  });

  test("a machine setting writes its own config key, not the bag", () => {
    expect(settingsAfterSnippet({ snippets: { a: true } }, { snippet: "hooks", enabled: false })).toEqual({
      snippets: { a: true },
      hooks_enabled: false,
    });
    expect(settingsAfterSnippet(undefined, { snippet: "auto_update", enabled: true })).toEqual({ auto_update: true });
  });

  test("stable carries its mode and reach; the mode defaults from on or off", () => {
    expect(settingsAfterSnippet({}, { snippet: "stable", enabled: true, mode: "team", global: true })).toEqual({ stable_mode: "team", stable_global: true });
    expect(settingsAfterSnippet({}, { snippet: "stable", enabled: false })).toEqual({ stable_mode: "off", stable_global: false });
    expect(stableModeOf({ snippet: "stable", enabled: true })).toBe("solo");
  });
});

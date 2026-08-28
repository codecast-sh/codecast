import { describe, expect, test } from "bun:test";
import { TEAM_NAME_MAX_LENGTH, isTeamColor, isTeamIcon, validateTeamCreateArgs } from "./teams";

describe("validateTeamCreateArgs", () => {
  test("trims the name and keeps a valid icon and color", () => {
    const out = validateTeamCreateArgs({ name: "  Core  ", icon: "rocket", icon_color: "cyan" });
    expect(out).toEqual({ name: "Core", icon: "rocket", icon_color: "cyan" });
  });

  test("rejects an empty or whitespace name", () => {
    expect(() => validateTeamCreateArgs({ name: "" })).toThrow("Team name is required");
    expect(() => validateTeamCreateArgs({ name: "   " })).toThrow("Team name is required");
  });

  test("rejects a name over the limit, accepts one at the limit", () => {
    const max = "x".repeat(TEAM_NAME_MAX_LENGTH);
    expect(validateTeamCreateArgs({ name: max }).name).toBe(max);
    expect(() => validateTeamCreateArgs({ name: max + "y" })).toThrow("40 characters or fewer");
  });

  test("falls back to a random valid icon and color when absent or unknown", () => {
    for (const args of [{ name: "t" }, { name: "t", icon: "nope", icon_color: "plaid" }]) {
      const out = validateTeamCreateArgs(args);
      expect(isTeamIcon(out.icon)).toBe(true);
      expect(isTeamColor(out.icon_color)).toBe(true);
    }
  });
});

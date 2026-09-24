import { describe, expect, it } from "bun:test";
import { teamFeatureEnabled, workspaceFeatureEnabled } from "./teamFeatures";

// The org feature is seated per team AND per person, and the personal
// workspace has no flag row. The rule that decides whose personal org exists
// lives here, once, for the web hook, the CLI guard and the Convex guard.
describe("workspaceFeatureEnabled", () => {
  const on = { _id: "t_on", features: { org: true } };
  const off = { _id: "t_off", features: { chat: true } };

  it("a team workspace reads its own flag, absent = off", () => {
    expect(workspaceFeatureEnabled([on, off], "t_on", "org")).toBe(true);
    expect(workspaceFeatureEnabled([on, off], "t_off", "org")).toBe(false);
    expect(workspaceFeatureEnabled([on, off], "t_unknown", "org")).toBe(false);
  });

  it("the personal workspace borrows a personal feature from any team", () => {
    expect(workspaceFeatureEnabled([off, on], null, "org")).toBe(true);
    expect(workspaceFeatureEnabled([off], null, "org")).toBe(false);
    expect(workspaceFeatureEnabled([], null, "org")).toBe(false);
  });

  it("a team-only feature stays off in the personal workspace", () => {
    expect(workspaceFeatureEnabled([off], null, "chat")).toBe(false);
    expect(teamFeatureEnabled(off, "chat")).toBe(true);
  });
});

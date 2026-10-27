import { describe, expect, it } from "bun:test";
import { teamFeatureEnabled, workspaceFeatureEnabled, workspaceFeatureState } from "./teamFeatures";

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

describe("workspaceFeatureState", () => {
  const on = { _id: "a", features: { org: true, line: true } };
  const off = { _id: "b", features: { org: false, line: false } };
  const undecided = { _id: "c", features: { chat: true } };
  it("a team reads its own flag: on, never decided (offer), or turned off", () => {
    expect(workspaceFeatureState([on, off, undecided], "a", "line")).toBe("on");
    expect(workspaceFeatureState([on, off, undecided], "b", "line")).toBe("off");
    expect(workspaceFeatureState([on, off, undecided], "c", "line")).toBe("offer");
    expect(workspaceFeatureState([undecided], "missing", "org")).toBe("off");
  });
  it("personal borrows: on when a team has it on, offered while one never decided, else off", () => {
    expect(workspaceFeatureState([off, on], null, "org")).toBe("on");
    expect(workspaceFeatureState([off, undecided], null, "org")).toBe("offer");
    expect(workspaceFeatureState([off], null, "org")).toBe("off");
    // A team-only feature is never offered in the personal workspace.
    expect(workspaceFeatureState([undecided], null, "calls")).toBe("off");
  });
});

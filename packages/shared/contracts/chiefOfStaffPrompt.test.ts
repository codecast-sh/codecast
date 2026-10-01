import { describe, expect, test } from "bun:test";
import { CHIEF_OF_STAFF_JOB, chiefOfStaffOpening } from "./chiefOfStaffPrompt";

// The Chief of Staff's opening (org-staffing.md S30): the right hand, named,
// with its reach and the access rule for it filled in.
describe("chiefOfStaffOpening", () => {
  test("a global chief reaches everything and names its workspaces on every write", () => {
    const text = chiefOfStaffOpening({ name: "Ada", person: "Sam", reach: { reach: "global" } });
    expect(text).toContain("You are Ada, Sam's Chief of Staff for everything Sam works on");
    expect(text).toContain("every workspace they are in");
    expect(text).toContain("Every write names its workspace");
    expect(text).toContain("with `--team` when the lead is a team's");
    expect(text).not.toContain("{");
  });

  test("a team chief works in one workspace and carries its flag", () => {
    const text = chiefOfStaffOpening({ name: "Pip", person: "Sam", reach: { reach: "team", team_id: "t" }, team: "Acme" });
    expect(text).toContain("Chief of Staff for Acme");
    expect(text).toContain("this is the one workspace you work in. Every verb carries `--team Acme`");
    expect(text).not.toContain("{");
  });

  test("the job paragraph says it reviews no structure", () => {
    expect(CHIEF_OF_STAFF_JOB).toContain("review no structure");
  });
});

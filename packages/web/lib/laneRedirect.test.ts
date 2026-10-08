import { describe, expect, it } from "bun:test";
import { BILLING_RETURN } from "@codecast/shared/contracts/assistant";
import { LANE_PATHS, conversationPath } from "../components/simple/lanePaths";
import { PAGE_ALIAS_SEGMENTS, laneRedirectTarget, pageAliasTarget } from "./laneRedirect";
import { isNonTabRoute, shellTabPath } from "./tabRoutes";
import { settingsSectionForPath } from "./settingsSections";

describe("the simple lane's addresses lead into the main app", () => {
  it("sends each lane page to its main-app equivalent", () => {
    expect(laneRedirectTarget(LANE_PATHS.home)).toBe("/inbox");
    expect(laneRedirectTarget(`${LANE_PATHS.home}/`)).toBe("/inbox");
    expect(laneRedirectTarget(LANE_PATHS.approvals)).toBe("/questions");
    expect(laneRedirectTarget(LANE_PATHS.routines)).toBe("/triggers");
    expect(laneRedirectTarget(LANE_PATHS.connections)).toBe("/settings/integrations");
    expect(laneRedirectTarget(LANE_PATHS.plan)).toBe("/settings/plan");
    expect(laneRedirectTarget(conversationPath("jx7abc"))).toBe("/conversation/jx7abc");
  });

  it("keeps a return's query and fragment, so it still says how the payment or connect went", () => {
    expect(laneRedirectTarget(LANE_PATHS.plan, "?billing=done")).toBe("/settings/plan?billing=done");
    expect(laneRedirectTarget(LANE_PATHS.connections, "?whisk=error&reason=bad_state", "#x")).toBe("/settings/integrations?whisk=error&reason=bad_state#x");
  });

  it("sends an unknown lane page home, and leaves every other address alone", () => {
    expect(laneRedirectTarget("/simple/somewhere")).toBe("/inbox");
    expect(laneRedirectTarget("/simpler")).toBeNull();
    expect(laneRedirectTarget("/inbox")).toBeNull();
    expect(laneRedirectTarget("/welcome")).toBeNull();
  });

  it("lands each settings target on its section, Stripe's return included", () => {
    expect(settingsSectionForPath(laneRedirectTarget(LANE_PATHS.plan)!)?.section).toBe("plan");
    expect(settingsSectionForPath(laneRedirectTarget(LANE_PATHS.connections)!)?.section).toBe("integrations");
    expect(settingsSectionForPath(`${BILLING_RETURN.path}?${BILLING_RETURN.param}=done`)).toEqual({ section: "plan", search: "billing=done" });
  });

  it("takes the hosted page names as addresses, query kept", () => {
    expect(pageAliasTarget("/approvals")).toBe("/questions");
    expect(pageAliasTarget("/approvals/", "?zq=1")).toBe("/questions?zq=1");
    expect(pageAliasTarget("/routines")).toBe("/triggers");
    expect(settingsSectionForPath(pageAliasTarget("/plan")!)?.section).toBe("plan");
    expect(settingsSectionForPath(pageAliasTarget("/mail")!)?.section).toBe("integrations");
    expect(pageAliasTarget("/inbox")).toBeNull();
    // Outside the tab shell, so the router (not a tab) runs the redirect.
    for (const seg of PAGE_ALIAS_SEGMENTS.filter((s) => s !== "routines")) expect(isNonTabRoute(`/${seg}`)).toBe(true);
  });
});

describe("a renamed page's old address leads to the new one", () => {
  it("sends the goals pages to the Org screen, a goal to its sheet, id, query and fragment kept", () => {
    expect(pageAliasTarget("/goals")).toBe("/org?lens=goals");
    expect(pageAliasTarget("/goals/")).toBe("/org?lens=goals");
    expect(pageAliasTarget("/goals/in-2")).toBe("/org/in-2");
    expect(pageAliasTarget("/initiatives")).toBe("/org?lens=goals");
    expect(pageAliasTarget("/initiatives/in-7", "?tab=tasks", "#updates")).toBe("/org/in-7?tab=tasks#updates");
    expect(pageAliasTarget("/goals", "?utm=x")).toBe("/org?lens=goals&utm=x");
    expect(pageAliasTarget("/initiativesx")).toBeNull();
    expect(pageAliasTarget("/org/in-7")).toBeNull();
  });

  it("sends the projects list, the team directory, the company document and the roadmap to their filter", () => {
    expect(pageAliasTarget("/projects")).toBe("/org?lens=projects");
    expect(pageAliasTarget("/team")).toBe("/org?lens=people");
    expect(pageAliasTarget("/company")).toBe("/org");
    expect(pageAliasTarget("/roadmap")).toBe("/org?lens=goals");
    // The pages under them stay: the board and the activity profile.
    expect(pageAliasTarget("/projects/pj-abc")).toBeNull();
    expect(pageAliasTarget("/team/samvit")).toBeNull();
    expect(pageAliasTarget("/team/activity")).toBeNull();
  });

  it("keeps each old address outside the tab shell, so the router runs the redirect", () => {
    for (const seg of ["initiatives", "goals", "projects", "team", "company", "roadmap"]) expect(PAGE_ALIAS_SEGMENTS).toContain(seg);
    expect(isNonTabRoute("/initiatives/in-7")).toBe(true);
    expect(isNonTabRoute("/goals/in-7")).toBe(true);
    expect(isNonTabRoute("/projects")).toBe(true);
    expect(isNonTabRoute("/team")).toBe(true);
    expect(isNonTabRoute("/projects/pj-abc")).toBe(false);
    expect(isNonTabRoute("/team/samvit")).toBe(false);
    expect(isNonTabRoute("/org/in-7")).toBe(false);
  });

  it("moves a saved tab on an old address to the new one", () => {
    expect(shellTabPath("/initiatives/in-7?tab=tasks")).toBe("/org/in-7?tab=tasks");
    expect(shellTabPath("/goals")).toBe("/org?lens=goals");
    expect(shellTabPath("/projects")).toBe("/org?lens=projects");
    expect(shellTabPath("/projects/pj-abc")).toBe("/projects/pj-abc");
  });
});

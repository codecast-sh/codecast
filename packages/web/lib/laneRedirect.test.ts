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
  it("sends the old goal addresses to Goals, id, query and fragment kept", () => {
    expect(pageAliasTarget("/initiatives")).toBe("/goals");
    expect(pageAliasTarget("/initiatives/in-7", "?tab=tasks", "#updates")).toBe("/goals/in-7?tab=tasks#updates");
    expect(pageAliasTarget("/roadmap")).toBe("/goals");
    expect(pageAliasTarget("/initiativesx")).toBeNull();
    // Goals and projects are pages of their own.
    expect(pageAliasTarget("/goals")).toBeNull();
    expect(pageAliasTarget("/goals/in-7")).toBeNull();
    expect(pageAliasTarget("/projects")).toBeNull();
    expect(pageAliasTarget("/projects/pj-abc")).toBeNull();
  });

  it("sends the team directory and the company document to Org, and keeps the pages under them", () => {
    expect(pageAliasTarget("/team")).toBe("/org");
    expect(pageAliasTarget("/company")).toBe("/org");
    expect(pageAliasTarget("/team/samvit")).toBeNull();
    expect(pageAliasTarget("/team/activity")).toBeNull();
  });

  it("keeps each old address outside the tab shell, so the router runs the redirect", () => {
    for (const seg of ["initiatives", "team", "company", "roadmap"]) expect(PAGE_ALIAS_SEGMENTS).toContain(seg);
    for (const seg of ["goals", "projects"]) expect(PAGE_ALIAS_SEGMENTS).not.toContain(seg);
    expect(isNonTabRoute("/initiatives/in-7")).toBe(true);
    expect(isNonTabRoute("/team")).toBe(true);
    expect(isNonTabRoute("/goals")).toBe(false);
    expect(isNonTabRoute("/goals/in-7")).toBe(false);
    expect(isNonTabRoute("/projects")).toBe(false);
    expect(isNonTabRoute("/projects/pj-abc")).toBe(false);
    expect(isNonTabRoute("/team/samvit")).toBe(false);
  });

  it("moves a saved tab on an old address to the new one", () => {
    expect(shellTabPath("/initiatives/in-7?tab=tasks")).toBe("/goals/in-7?tab=tasks");
    expect(shellTabPath("/goals")).toBe("/goals");
    expect(shellTabPath("/projects")).toBe("/projects");
  });
});


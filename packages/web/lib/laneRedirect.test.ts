import { describe, expect, it } from "bun:test";
import { BILLING_RETURN } from "@codecast/shared/contracts/assistant";
import { LANE_PATHS, conversationPath } from "../components/simple/lanePaths";
import { laneRedirectTarget } from "./laneRedirect";
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
});

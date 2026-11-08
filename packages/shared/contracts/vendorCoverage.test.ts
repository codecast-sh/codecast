import { describe, expect, test } from "bun:test";
import { BAA_COVERED_VENDORS, FEATURE_VENDORS, VENDORS, featureVendorBlock, teamVendorBlock, vendorUncoveredMessage } from "./vendorCoverage";

const clinic = { name: "Clinic", policy: { regulated_data: true } };
const shop = { name: "Shop", policy: {} };

describe("vendor coverage", () => {
  test("every vendor a feature depends on receives content, so it needs a BAA", () => {
    for (const vendors of Object.values(FEATURE_VENDORS)) for (const v of vendors ?? []) expect(VENDORS[v].receives).toBe("content");
  });

  test("a regulated team's control is off with one line while the vendor is uncovered, on once covered", () => {
    expect(BAA_COVERED_VENDORS).toEqual([]);
    expect(teamVendorBlock(clinic, "anthropic")).toBe("AI features are off for Clinic: no BAA with Anthropic yet.");
    expect(teamVendorBlock(clinic, "anthropic", ["anthropic"])).toBeNull();
    expect(featureVendorBlock(clinic, "calls")).toBe(vendorUncoveredMessage("livekit", "Clinic"));
    expect(featureVendorBlock(clinic, "calls", ["livekit"])).toBeNull();
    expect(featureVendorBlock(clinic, "agent_faces")).toBe(vendorUncoveredMessage("tavus", "Clinic"));
    expect(featureVendorBlock(clinic, "agent_realtime", ["openai"])).toBeNull();
    // A feature that sends nothing to a vendor is never blocked.
    expect(featureVendorBlock(clinic, "chat")).toBeNull();
  });

  test("a team without regulated data is unchanged", () => {
    expect(teamVendorBlock(shop, "anthropic")).toBeNull();
    expect(featureVendorBlock(shop, "calls")).toBeNull();
    expect(featureVendorBlock(null, "calls")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import {
  buildMobileconfig,
  mergePolicies,
  parseManagedProfile,
  parseTeamPolicy,
  policyBlockedMessage,
  policyTeamOf,
} from "./managedPolicy";

const team = { kind: "team" as const, team_id: "t1", team_name: "Littlebird" };

describe("parseManagedProfile", () => {
  test("maps profile keys, drops unknown and mistyped values", () => {
    expect(parseManagedProfile({
      PublicSharingDisabled: true,
      BrowserControlDisabled: "yes",
      AutoUpdate: false,
      ExcludedPaths: ["~/secret", "", 3],
      ServerURL: " https://convex.example.com ",
      EnrollmentToken: "cc_enr_x",
      PayloadUUID: "abc",
    })).toEqual({
      public_sharing_disabled: true,
      auto_update: "off",
      excluded_paths: ["~/secret"],
      convex_url: "https://convex.example.com",
      enrollment_token: "cc_enr_x",
    });
  });

  test("accepts snake_case keys in a hand-written managed.json", () => {
    expect(parseManagedProfile({ cloud_hosts_disabled: true })).toEqual({ cloud_hosts_disabled: true });
  });

  test("a profile marks a device's data as regulated", () => {
    expect(parseManagedProfile({ RegulatedData: true })).toEqual({ regulated_data: true });
  });

  test("team policy keeps team keys only", () => {
    expect(parseTeamPolicy({ public_sharing_disabled: true, enrollment_token: "cc_enr_x", auto_update: "on" }))
      .toEqual({ public_sharing_disabled: true, auto_update: "on" });
  });
});

describe("mergePolicies", () => {
  test("a restriction is on when any layer turns it on, and names that layer", () => {
    const merged = mergePolicies([
      { source: { kind: "profile" }, policy: { browser_control_disabled: false } },
      { source: team, policy: { browser_control_disabled: true } },
    ]);
    expect(merged.values.browser_control_disabled).toBe(true);
    expect(merged.sources.browser_control_disabled).toEqual(team);
  });

  test("choices come from the first layer that sets them; paths union", () => {
    const merged = mergePolicies([
      { source: { kind: "profile" }, policy: { auto_update: "on", excluded_paths: ["~/a"] } },
      { source: team, policy: { auto_update: "off", excluded_paths: ["~/a", "~/b"] } },
    ]);
    expect(merged.values.auto_update).toBe("on");
    expect(merged.sources.auto_update).toEqual({ kind: "profile" });
    expect(merged.values.excluded_paths).toEqual(["~/a", "~/b"]);
  });

  test("regulated data cannot be switched off by a later layer", () => {
    const merged = mergePolicies([
      { source: team, policy: { regulated_data: true } },
      { source: { kind: "team", team_id: "t2", team_name: "Other" }, policy: { regulated_data: false } },
    ]);
    expect(merged.values.regulated_data).toBe(true);
    expect(merged.sources.regulated_data).toEqual(team);
  });

  test("nothing set merges to nothing", () => {
    expect(mergePolicies([{ source: team, policy: {} }])).toEqual({ values: {}, sources: {} });
  });
});

test("refusal names who turned it off", () => {
  expect(policyBlockedMessage("public_sharing_disabled", team)).toBe("Public sharing is turned off by Littlebird's admins.");
  expect(policyBlockedMessage("browser_control_disabled", { kind: "profile" })).toBe("Agent browser control is turned off by your device's management profile.");
});

test("mobileconfig carries settings as profile keys and escapes values", () => {
  const xml = buildMobileconfig({
    teamName: "Little & bird",
    identifier: "sh.codecast.team.t1",
    uuids: ["U0", "U1", "U2"],
    policy: { public_sharing_disabled: true, auto_update: "off", enrollment_token: "cc_enr_x", user_email: "$EMAIL" },
    accessibility: [{ identifier: "sh.codecast.desktop", identifierType: "bundleID", codeRequirement: 'identifier "sh.codecast.desktop"' }],
  });
  expect(xml).toMatch(/<key>PublicSharingDisabled<\/key>\s*<true\/>/);
  expect(xml).toMatch(/<key>AutoUpdate<\/key>\s*<false\/>/);
  expect(xml).toContain("<string>$EMAIL</string>");
  expect(xml).toContain("Codecast for Little &amp; bird");
  expect(xml).toContain("&quot;sh.codecast.desktop&quot;");
  expect(xml).toContain("com.apple.TCC.configuration-profile-policy");
});

describe("policyTeamOf", () => {
  test("a conversation answers to its team only when it is visible to it", () => {
    expect(policyTeamOf("conversations", { team_id: "t1", is_private: false })).toBe("t1");
    expect(policyTeamOf("conversations", { team_id: "t1", is_private: true })).toBeNull();
    expect(policyTeamOf("conversations", { team_id: "t1", is_private: true, team_visibility: "summary" })).toBe("t1");
    expect(policyTeamOf("conversations", { team_id: "t1", is_private: true, auto_shared: true })).toBe("t1");
  });
  test("any other row answers to its workspace key's team, else its team tag", () => {
    expect(policyTeamOf("tasks", { workspace: "team:t2", team_id: "t1" })).toBe("t2");
    expect(policyTeamOf("tasks", { workspace: "user:u1", team_id: "t1" })).toBeNull();
    expect(policyTeamOf("docs", { team_id: "t1" })).toBe("t1");
    expect(policyTeamOf("docs", {})).toBeNull();
    expect(policyTeamOf("docs", null)).toBeNull();
  });
});

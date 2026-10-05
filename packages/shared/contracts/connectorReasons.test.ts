import { describe, expect, test } from "bun:test";
import { CONNECTOR_FAILED, describeConnectorError, describeReturnReason } from "./connectorReasons";

describe("describeConnectorError (an action's reply)", () => {
  test("turns our own reason codes into sentences", () => {
    expect(describeConnectorError("not_a_team_member")).toContain("team");
  });

  test("every Google refusal code reads as a sentence naming no surface", () => {
    for (const code of [
      "signed_out", "no_such_installation", "expired", "bad_token", "wrong_account", "confirm_failed",
      "exchange_failed", "profile_failed", "store_failed", "no_refresh_token", "access_denied",
    ]) {
      const line = describeConnectorError(code);
      expect(line).not.toBe(code);
      expect(line).not.toBe(CONNECTOR_FAILED);
      expect(line).not.toMatch(/Apps tab|\u2014/);
    }
  });

  test("a provider's cancel and ours read the same", () => {
    expect(describeConnectorError("access_denied")).toBe(describeConnectorError("denied"));
  });

  test("an unknown code never shows raw", () => {
    expect(describeConnectorError("invalid_scope")).toBe(CONNECTOR_FAILED);
  });

  test("only the table's own keys match", () => {
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(typeof describeConnectorError(key)).toBe("string");
      expect(describeReturnReason(key)).toBe(CONNECTOR_FAILED);
    }
    expect(describeConnectorError("constructor")).toBe(CONNECTOR_FAILED);
  });

  test("passes a connector's own words through untouched", () => {
    expect(describeConnectorError("Linear OAuth not configured")).toBe("Linear OAuth not configured");
  });
});

describe("describeReturnReason (a reason from a URL)", () => {
  test("describes known codes", () => {
    expect(describeReturnReason("access_denied")).toBe("You declined the authorization.");
  });

  test("never echoes words it does not know", () => {
    expect(describeReturnReason("Your account is locked. Call 1-800-555-0100")).toBe(CONNECTOR_FAILED);
    expect(describeReturnReason("invalid_scope")).toBe(CONNECTOR_FAILED);
    expect(describeReturnReason(null)).toBe(CONNECTOR_FAILED);
    expect(describeReturnReason("")).toBe(CONNECTOR_FAILED);
  });
});

import { describe, expect, test } from "bun:test";
import { describeConnectorError, parseConnectorReturn, strippedUrl } from "../connectorReturn";

describe("parseConnectorReturn", () => {
  test("reads the connector confirm, provider from the fragment", () => {
    expect(
      parseConnectorReturn("#installation=abc123&confirm=tok-9&provider=linear", "?linear=pending"),
    ).toEqual({ kind: "confirm", provider: "linear", installationId: "abc123", confirmToken: "tok-9" });
  });

  test("falls back to the pending search key when the fragment names no provider", () => {
    // googleOAuth.ts writes exactly this shape, and `google` is the Gmail app.
    expect(parseConnectorReturn("#installation=xyz&confirm=t", "?google=pending")).toEqual({
      kind: "confirm",
      provider: "gmail",
      installationId: "xyz",
      confirmToken: "t",
    });
  });

  test("tolerates a hash and search that already lost their leading marks", () => {
    expect(parseConnectorReturn("installation=xyz&confirm=t&provider=notion", "notion=pending")).toEqual({
      kind: "confirm",
      provider: "notion",
      installationId: "xyz",
      confirmToken: "t",
    });
  });

  test("a confirm token naming no resolvable provider is not actionable", () => {
    expect(parseConnectorReturn("#installation=xyz&confirm=t", "")).toBeNull();
    expect(parseConnectorReturn("#installation=xyz&confirm=t&provider=dropbox", "")).toBeNull();
  });

  test("reads a connector refusal and its reason", () => {
    expect(parseConnectorReturn("", "?linear=error&reason=denied")).toEqual({
      kind: "error",
      provider: "linear",
      reason: "denied",
    });
  });

  test("a refusal with no reason still reports one", () => {
    expect(parseConnectorReturn("", "?notion=error")).toEqual({
      kind: "error",
      provider: "notion",
      reason: "The connection was refused",
    });
  });

  test("reads the GitHub App install return, which names no provider", () => {
    expect(parseConnectorReturn("", "?success=true")).toEqual({ kind: "success", provider: "github" });
    expect(parseConnectorReturn("", "?error=missing_team")).toEqual({
      kind: "error",
      provider: "github",
      reason: "missing_team",
    });
  });

  test("an ordinary page open carries no callback", () => {
    expect(parseConnectorReturn("", "")).toBeNull();
    expect(parseConnectorReturn("#section=github", "?tab=apps")).toBeNull();
  });
});

describe("describeConnectorError", () => {
  test("turns our own reason codes into sentences", () => {
    expect(describeConnectorError("missing_team")).toContain("team");
  });

  test("passes a connector's own words through untouched", () => {
    expect(describeConnectorError("Linear OAuth not configured")).toBe("Linear OAuth not configured");
  });
});

describe("strippedUrl", () => {
  test("removes the credential and every callback param", () => {
    expect(
      strippedUrl("/settings/integrations", "?linear=pending", "#installation=abc&confirm=tok&provider=linear"),
    ).toBe("/settings/integrations");
  });

  test("keeps query keys the page owns for other reasons", () => {
    expect(strippedUrl("/settings/integrations", "?tab=apps&github=error&reason=x", "")).toBe(
      "/settings/integrations?tab=apps",
    );
  });
});

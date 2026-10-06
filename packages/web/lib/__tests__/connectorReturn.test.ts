import { describe, expect, test } from "bun:test";
import { describeConnectorError, isReturnFrom, parseConnectorReturn, strippedUrl, WHISK_RETURN_KEY } from "../connectorReturn";

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
      reason: "You declined the authorization.",
    });
  });

  test("a refusal with no reason still reports one", () => {
    expect(parseConnectorReturn("", "?notion=error")).toEqual({
      kind: "error",
      provider: "notion",
      reason: "The connection didn't finish. Try again.",
    });
  });

  test("reads the GitHub App install return, which names no provider", () => {
    expect(parseConnectorReturn("", "?success=true")).toEqual({ kind: "success", provider: "github" });
    expect(parseConnectorReturn("", "?error=install_not_fresh")).toEqual({
      kind: "error",
      provider: "github",
      reason: expect.stringContaining("Uninstall the Codecast app"),
    });
  });

  test("a reconnect of a confirmed account reads as done, under the connector's url name", () => {
    expect(parseConnectorReturn("", "?google=connected")).toEqual({ kind: "success", provider: "gmail" });
    expect(strippedUrl("/simple/connections", "?google=connected", "")).toBe("/simple/connections");
  });

  test("an ordinary page open carries no callback", () => {
    expect(parseConnectorReturn("", "")).toBeNull();
    expect(parseConnectorReturn("#section=github", "?tab=apps")).toBeNull();
  });
});

describe("a reason read from the URL", () => {
  test("a Google cancel lands as words, on any return page", () => {
    expect(parseConnectorReturn("", "?google=error&reason=access_denied")).toEqual({
      kind: "error",
      provider: "gmail",
      reason: "You declined the authorization.",
    });
  });

  test("a link's own words never reach the page", () => {
    const hit = parseConnectorReturn("", "?google=error&reason=Your+Google+account+is+locked.+Call+1-800-555-0100");
    expect(hit).toEqual({ kind: "error", provider: "gmail", reason: "The connection didn't finish. Try again." });
    expect(parseConnectorReturn("", "?error=Call+us+now")).toMatchObject({ reason: "The connection didn't finish. Try again." });
  });

  test("prototype keys read as the generic line, never an object", () => {
    for (const reason of ["__proto__", "constructor", "toString"]) {
      const hit = parseConnectorReturn("", `?google=error&reason=${reason}`) as { reason: unknown };
      expect(hit.reason).toBe("The connection didn't finish. Try again.");
      expect(typeof describeConnectorError(reason)).toBe("string");
    }
  });

  test("the described reason survives the surfaces describing it again", () => {
    const hit = parseConnectorReturn("", "?google=error&reason=wrong_account") as { reason: string };
    expect(describeConnectorError(hit.reason)).toBe(hit.reason);
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

describe("the mail connect through Whisk", () => {
  const whisk = (search: string) => parseConnectorReturn("", search, [WHISK_RETURN_KEY]);
  test("reads as one more provider of the same return shape, with only the table's words for a reason", () => {
    expect(whisk("?whisk=connected")).toEqual({ kind: "success", provider: "whisk" });
    expect(whisk("?whisk=error&reason=access_denied")).toEqual({ kind: "error", provider: "whisk", reason: "You declined the authorization." });
    expect(whisk("?whisk=error&reason=whisk_invalid_grant")).toEqual({ kind: "error", provider: "whisk", reason: "That approval from Whisk expired or was already used. Connect again." });
    // A link that writes its own words gets the generic line.
    expect(whisk("?whisk=error&reason=Your+account+is+locked,+call+555-0100")).toEqual({ kind: "error", provider: "whisk", reason: "The connection didn't finish. Try again." });
    expect(whisk("")).toBeNull();
    expect(whisk("?whisk=maybe")).toBeNull();
  });

  test("a page that does not name it never reads it as a success", () => {
    expect(parseConnectorReturn("", "?whisk=connected")).toBeNull();
    // An error still reads, with no provider to name.
    expect(parseConnectorReturn("", "?whisk=error&reason=bad_state")).toMatchObject({ kind: "error", provider: null });
  });

  test("its keys leave the address bar with the rest of a connector return", () => {
    expect(strippedUrl("/simple/connections", "?whisk=error&reason=bad_state&tab=x", "")).toBe("/simple/connections?tab=x");
  });

  test("isReturnFrom names only that provider's return, success or refusal", () => {
    expect(isReturnFrom("", "?whisk=connected", WHISK_RETURN_KEY)).toBe(true);
    expect(isReturnFrom("", "?whisk=error&reason=bad_state", WHISK_RETURN_KEY)).toBe(true);
    // Another connector's return stays on the address for its own reader.
    expect(isReturnFrom("", "?linear=connected", WHISK_RETURN_KEY)).toBe(false);
    expect(isReturnFrom("#installation=i1&confirm=t1&provider=linear", "?linear=pending", WHISK_RETURN_KEY)).toBe(false);
    expect(isReturnFrom("", "?success=true", WHISK_RETURN_KEY)).toBe(false);
    expect(isReturnFrom("", "", WHISK_RETURN_KEY)).toBe(false);
  });
});

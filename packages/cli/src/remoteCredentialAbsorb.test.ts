import { describe, expect, it } from "bun:test";
import { planPushedCredentialAbsorb, stripRefreshToken } from "./remoteCredentialAbsorb.js";

const NOW = 1_800_000_000_000;
const blob = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-access",
      refreshToken: "sk-ant-ort01-refresh",
      expiresAt: NOW + 4 * 3600_000,
      refreshTokenExpiresAt: NOW + 30 * 86_400_000,
      scopes: ["user:inference"],
      subscriptionType: "max",
      ...over,
    },
  });
const STUB = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0, subscriptionType: "max" } });

describe("stripRefreshToken", () => {
  it("drops the refresh token and its expiry, keeps everything else", () => {
    const out = JSON.parse(stripRefreshToken(blob())!);
    expect(out.claudeAiOauth.refreshToken).toBeUndefined();
    expect(out.claudeAiOauth.refreshTokenExpiresAt).toBeUndefined();
    expect(out.claudeAiOauth.accessToken).toBe("sk-ant-oat01-access");
    expect(out.claudeAiOauth.subscriptionType).toBe("max");
  });

  it("is null for something that is not a Claude OAuth blob", () => {
    expect(stripRefreshToken("not json")).toBeNull();
    expect(stripRefreshToken(JSON.stringify({ apiKey: "x" }))).toBeNull();
  });
});

describe("planPushedCredentialAbsorb", () => {
  it("replaces a logged-out stub with the pushed login, refresh token removed", () => {
    const plan = planPushedCredentialAbsorb({ pushed: blob(), active: STUB, now: NOW });
    expect(plan.action).toBe("write");
    if (plan.action !== "write") return;
    expect(plan.credential).not.toContain("sk-ant-ort01-refresh");
    expect(plan.expiresAt).toBe(NOW + 4 * 3600_000);
  });

  it("replaces an expired keychain login and an absent one", () => {
    const expired = blob({ expiresAt: NOW - 1 });
    expect(planPushedCredentialAbsorb({ pushed: blob(), active: expired, now: NOW }).action).toBe("write");
    expect(planPushedCredentialAbsorb({ pushed: blob(), active: null, now: NOW }).action).toBe("write");
  });

  it("leaves a keychain login that is at least as fresh alone — an absorbed push is a no-op", () => {
    const absorbed = stripRefreshToken(blob())!;
    expect(planPushedCredentialAbsorb({ pushed: blob(), active: absorbed, now: NOW })).toEqual({
      action: "skip",
      reason: "keychain login is at least as fresh as the pushed copy",
    });
    const fresherByHand = blob({ accessToken: "sk-ant-oat01-other", expiresAt: NOW + 8 * 3600_000 });
    expect(planPushedCredentialAbsorb({ pushed: blob(), active: fresherByHand, now: NOW }).action).toBe("skip");
  });

  it("never writes a pushed copy that is itself expired or a stub", () => {
    expect(planPushedCredentialAbsorb({ pushed: blob({ expiresAt: NOW - 1 }), active: STUB, now: NOW })).toMatchObject({
      action: "skip",
      reason: expect.stringContaining("access token expired"),
    });
    expect(planPushedCredentialAbsorb({ pushed: STUB, active: STUB, now: NOW })).toMatchObject({
      action: "skip",
      reason: expect.stringContaining("logged-out stub"),
    });
    expect(planPushedCredentialAbsorb({ pushed: null, active: STUB, now: NOW })).toMatchObject({ action: "skip" });
  });
});

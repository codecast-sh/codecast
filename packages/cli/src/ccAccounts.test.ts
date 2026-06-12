import { describe, it, expect } from "bun:test";
import {
  buildProfile,
  parseProfile,
  profileMeta,
  assertValidProfileName,
  CcAccountError,
} from "./ccAccounts.js";

const CRED = JSON.stringify({
  claudeAiOauth: {
    accessToken: "at-123",
    refreshToken: "rt-456",
    expiresAt: 1781228581738,
    scopes: ["user:inference"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  },
});

const OAUTH_ACCOUNT = {
  accountUuid: "11bbd477-94d6-4412-ac36-518cc5f10353",
  emailAddress: "ashot@footage.com",
  organizationName: "ashot@footage.com's Organization",
};

describe("buildProfile", () => {
  it("snapshots credential + identity + timestamp", () => {
    const p = buildProfile(CRED, OAUTH_ACCOUNT, 1000);
    expect(p.credentials.claudeAiOauth.refreshToken).toBe("rt-456");
    expect(p.oauthAccount.emailAddress).toBe("ashot@footage.com");
    expect(p.saved_at).toBe(1000);
  });

  it("rejects non-JSON and non-OAuth credentials", () => {
    expect(() => buildProfile("not json", OAUTH_ACCOUNT, 0)).toThrow(CcAccountError);
    // API-key logins have no claudeAiOauth block — nothing snapshotable.
    expect(() => buildProfile(JSON.stringify({ apiKey: "sk-..." }), OAUTH_ACCOUNT, 0)).toThrow(
      /claudeAiOauth/,
    );
  });

  it("tolerates a missing oauthAccount block", () => {
    const p = buildProfile(CRED, null, 0);
    expect(p.oauthAccount).toEqual({});
  });
});

describe("parseProfile", () => {
  it("round-trips buildProfile output", () => {
    const p = buildProfile(CRED, OAUTH_ACCOUNT, 1234);
    const back = parseProfile(JSON.stringify(p));
    expect(back.credentials.claudeAiOauth.accessToken).toBe("at-123");
    expect(back.saved_at).toBe(1234);
  });

  it("accepts hand-saved profiles with float epoch-second saved_at", () => {
    // The first profiles were saved manually with python time.time() (seconds,
    // float) — saved_at is display metadata only, any number passes through.
    const manual = JSON.stringify({
      credentials: JSON.parse(CRED),
      oauthAccount: OAUTH_ACCOUNT,
      saved_at: 1781221000.123,
    });
    expect(parseProfile(manual).saved_at).toBeCloseTo(1781221000.123);
  });

  it("rejects blobs without a credentials.claudeAiOauth block", () => {
    expect(() => parseProfile(JSON.stringify({ oauthAccount: OAUTH_ACCOUNT }))).toThrow(
      CcAccountError,
    );
    expect(() => parseProfile("garbage")).toThrow(CcAccountError);
  });
});

describe("profileMeta", () => {
  it("extracts non-secret fields only", () => {
    const meta = profileMeta(buildProfile(CRED, OAUTH_ACCOUNT, 99));
    expect(meta).toEqual({
      email: "ashot@footage.com",
      uuid: "11bbd477-94d6-4412-ac36-518cc5f10353",
      tier: "default_claude_max_20x",
      subscription: "max",
      saved_at: 99,
    });
    expect(JSON.stringify(meta)).not.toContain("at-123");
    expect(JSON.stringify(meta)).not.toContain("rt-456");
  });
});

describe("assertValidProfileName", () => {
  it("accepts simple names, rejects path/shell hazards", () => {
    expect(() => assertValidProfileName("footage")).not.toThrow();
    expect(() => assertValidProfileName("work-2.bak_1")).not.toThrow();
    for (const bad of ["", "-lead", "has space", "a/b", "a;b", "x".repeat(50)]) {
      expect(() => assertValidProfileName(bad)).toThrow(CcAccountError);
    }
  });
});

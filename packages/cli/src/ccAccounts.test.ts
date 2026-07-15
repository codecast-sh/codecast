import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildProfile,
  parseProfile,
  profileMeta,
  assertValidProfileName,
  deriveProfileName,
  autoSaveActiveProfile,
  getAccountsHeartbeatPayload,
  invalidateAccountsCache,
  refreshActiveCredential,
  resnapshotIfActiveFresher,
  activeCredentialExpiresAt,
  credentialHealth,
  saveProfile,
  useProfile,
  listProfiles,
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

describe("deriveProfileName", () => {
  it("uses the email domain's org part, lowercased", () => {
    expect(deriveProfileName("ashot@footage.com", [])).toBe("footage");
    expect(deriveProfileName("a@Union.APP", [])).toBe("union");
  });

  it("dedupes against taken names with -2/-3", () => {
    expect(deriveProfileName("ashot@footage.com", ["footage"])).toBe("footage-2");
    expect(deriveProfileName("ashot@footage.com", ["Footage", "footage-2"])).toBe("footage-3");
  });

  it("falls back to 'account' when the email yields no usable name", () => {
    expect(deriveProfileName(undefined, [])).toBe("account");
    expect(deriveProfileName("bad-email", [])).toBe("account");
    expect(deriveProfileName(undefined, ["account"])).toBe("account-2");
  });
});

// The shape /logout leaves behind: metadata intact, tokens EMPTY, expiry 0.
const LOGGED_OUT_STUB = JSON.stringify({
  claudeAiOauth: {
    accessToken: "",
    refreshToken: "",
    expiresAt: 0,
    refreshTokenExpiresAt: 1786524960503,
    scopes: ["user:inference"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  },
});

describe("credentialHealth", () => {
  const NOW = 1_800_000_000_000;

  it("live credential is usable and pushable", () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: NOW + 60_000 } });
    expect(credentialHealth(raw, NOW)).toMatchObject({ usable: true, pushable: true, expiresAt: NOW + 60_000 });
  });

  it("flags the post-/logout stub (empty tokens) as unusable", () => {
    const h = credentialHealth(LOGGED_OUT_STUB, NOW);
    expect(h.usable).toBe(false);
    expect(h.pushable).toBe(false);
    expect(h.reason).toMatch(/logged-out/);
  });

  it("expired-but-refreshable is usable locally but never pushable", () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: NOW - 1 } });
    expect(credentialHealth(raw, NOW)).toMatchObject({ usable: true, pushable: false });
  });

  it("blank access token with a refresh token is refreshable, not pushable", () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "rt", expiresAt: 0 } });
    expect(credentialHealth(raw, NOW)).toMatchObject({ usable: true, pushable: false });
  });

  it("missing/garbage/API-key blobs are unusable", () => {
    expect(credentialHealth(null, NOW).usable).toBe(false);
    expect(credentialHealth("not json", NOW).usable).toBe(false);
    expect(credentialHealth(JSON.stringify({ apiKey: "sk-..." }), NOW).usable).toBe(false);
  });
});

// Exercises the real save path against a sandboxed $HOME: file-backed secret
// store (CC_ACCOUNTS_FORCE_FILE) and an empty PATH so the keychain lookup
// fails over to $HOME/.claude/.credentials.json.
describe("autoSaveActiveProfile + heartbeat payload (sandboxed $HOME)", () => {
  let home: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-accounts-test-"));
    for (const k of ["HOME", "PATH", "CC_ACCOUNTS_FORCE_FILE"]) savedEnv[k] = process.env[k];
    process.env.HOME = home;
    process.env.PATH = path.join(home, "empty-path");
    process.env.CC_ACCOUNTS_FORCE_FILE = "1";
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), CRED);
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: OAUTH_ACCOUNT }));
    invalidateAccountsCache();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
    invalidateAccountsCache();
  });

  it("saves an unsaved active login once, then reports covered", () => {
    const saved = autoSaveActiveProfile();
    expect(saved?.name).toBe("footage");
    expect(saved?.email).toBe("ashot@footage.com");
    // Idempotent: the account is now covered (matched by uuid).
    expect(autoSaveActiveProfile()).toBeNull();
    // Same email under a NEW uuid is still covered by the email match.
    const rotated = { ...OAUTH_ACCOUNT, accountUuid: "different-uuid" };
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: rotated }));
    expect(autoSaveActiveProfile()).toBeNull();
  });

  it("payload picks up cross-process saves via file mtimes, no invalidation call", () => {
    expect(getAccountsHeartbeatPayload()?.profiles ?? []).toHaveLength(0);
    // Write the index directly, the way a `cast accounts save` in ANOTHER
    // process would — this process's in-memory cache gets no invalidation
    // and must notice the file change on its own.
    fs.writeFileSync(
      path.join(home, ".codecast", "cc-accounts.json"),
      JSON.stringify({ profiles: { footage: { email: "ashot@footage.com" } } }),
    );
    const after = getAccountsHeartbeatPayload();
    expect(after?.profiles.map((p) => p.name)).toEqual(["footage"]);
    expect(after?.active_email).toBe("ashot@footage.com");
  });

  it("returns null with no login at all", () => {
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({}));
    expect(autoSaveActiveProfile()).toBeNull();
  });
});

// Regression for the 2026-07-15 outage: a /logout left the active credential
// as a blank stub, save-on-switch snapshotted the stub over the profile's good
// tokens, and a later switch back activated it — "Login expired" on every
// session locally AND on the remote Mac (the push replicated the stub there).
// Containment is three gates: never SAVE a stub, never ACTIVATE a stub, and
// (in session-move) never PUSH one.
describe("logged-out stub containment (sandboxed $HOME)", () => {
  let home: string;
  const savedEnv: Record<string, string | undefined> = {};
  const credPath = () => path.join(home, ".claude", ".credentials.json");

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-accounts-test-"));
    for (const k of ["HOME", "PATH", "CC_ACCOUNTS_FORCE_FILE"]) savedEnv[k] = process.env[k];
    process.env.HOME = home;
    process.env.PATH = path.join(home, "empty-path");
    process.env.CC_ACCOUNTS_FORCE_FILE = "1";
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
    fs.writeFileSync(credPath(), CRED);
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: OAUTH_ACCOUNT }));
    invalidateAccountsCache();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
    invalidateAccountsCache();
  });

  it("saveProfile refuses to snapshot a logged-out stub over a good profile", () => {
    saveProfile("footage");
    fs.writeFileSync(credPath(), LOGGED_OUT_STUB);
    expect(() => saveProfile("footage")).toThrow(/unusable/);
    // The good snapshot survives.
    const stored = JSON.parse(
      fs.readFileSync(path.join(home, ".codecast", "cc-accounts", "footage.json"), "utf-8"),
    );
    expect(stored.credentials.claudeAiOauth.accessToken).toBe("at-123");
  });

  it("useProfile refuses to activate a poisoned profile and leaves the active login untouched", () => {
    saveProfile("footage");
    // Poison the stored profile the way the old save-on-switch bug did.
    fs.writeFileSync(
      path.join(home, ".codecast", "cc-accounts", "footage.json"),
      JSON.stringify({ credentials: JSON.parse(LOGGED_OUT_STUB), oauthAccount: OAUTH_ACCOUNT, saved_at: 1 }),
    );
    expect(() => useProfile("footage")).toThrow(/unusable|logged-out/);
    // The switch failed BEFORE writing anything: the active credential still
    // has its real tokens.
    expect(JSON.parse(fs.readFileSync(credPath(), "utf-8")).claudeAiOauth.accessToken).toBe("at-123");
  });
});

// Proactive refresh + re-snapshot run against the same sandboxed $HOME: the
// file-backed credential store lets us assert the rotated blob without ever
// touching the real keychain, and fetch is injected so no network call fires.
describe("refreshActiveCredential (sandboxed $HOME, injected fetch)", () => {
  let home: string;
  const savedEnv: Record<string, string | undefined> = {};
  const credPath = () => path.join(home, ".claude", ".credentials.json");
  const readCred = () => JSON.parse(fs.readFileSync(credPath(), "utf-8")).claudeAiOauth;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-refresh-test-"));
    for (const k of ["HOME", "PATH", "CC_ACCOUNTS_FORCE_FILE"]) savedEnv[k] = process.env[k];
    process.env.HOME = home;
    process.env.PATH = path.join(home, "empty-path");
    process.env.CC_ACCOUNTS_FORCE_FILE = "1";
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
    fs.writeFileSync(credPath(), CRED);
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: OAUTH_ACCOUNT }));
    invalidateAccountsCache();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
    invalidateAccountsCache();
  });

  const okFetch = (body: any): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })) as any;

  it("rotates access + refresh tokens and stamps a fresh expiry", async () => {
    const res = await refreshActiveCredential({
      now: 10_000,
      fetchImpl: okFetch({ access_token: "at-new", refresh_token: "rt-new", expires_in: 28800 }),
    });
    expect(res.refreshed).toBe(true);
    expect(res.expiresAt).toBe(10_000 + 28800 * 1000);
    const c = readCred();
    expect(c.accessToken).toBe("at-new");
    expect(c.refreshToken).toBe("rt-new");
    expect(c.expiresAt).toBe(10_000 + 28800 * 1000);
    // Non-token fields survive the refresh untouched.
    expect(c.subscriptionType).toBe("max");
    expect(c.rateLimitTier).toBe("default_claude_max_20x");
    expect(c.scopes).toEqual(["user:inference"]);
  });

  it("keeps the old refresh token when the server doesn't rotate it", async () => {
    const res = await refreshActiveCredential({
      fetchImpl: okFetch({ access_token: "at-new", expires_in: 3600 }),
    });
    expect(res.refreshed).toBe(true);
    expect(readCred().refreshToken).toBe("rt-456");
  });

  it("leaves the credential untouched on a non-2xx response", async () => {
    const res = await refreshActiveCredential({
      fetchImpl: (async () => new Response("nope", { status: 401 })) as any,
    });
    expect(res.refreshed).toBe(false);
    expect(res.reason).toContain("401");
    expect(readCred().accessToken).toBe("at-123"); // original, not clobbered
  });

  it("leaves the credential untouched when the response omits access_token", async () => {
    const res = await refreshActiveCredential({ fetchImpl: okFetch({ expires_in: 3600 }) });
    expect(res.refreshed).toBe(false);
    expect(readCred().accessToken).toBe("at-123");
  });

  it("no-ops on an API-key login (no refresh token)", async () => {
    fs.writeFileSync(credPath(), JSON.stringify({ claudeAiOauth: { accessToken: "at", expiresAt: 1 } }));
    const res = await refreshActiveCredential({ fetchImpl: okFetch({ access_token: "x", expires_in: 1 }) });
    expect(res.refreshed).toBe(false);
    expect(res.reason).toContain("no refresh token");
  });

  it("reads the active token's expiry", () => {
    expect(activeCredentialExpiresAt()).toBe(1781228581738);
  });
});

describe("resnapshotIfActiveFresher (sandboxed $HOME)", () => {
  let home: string;
  const savedEnv: Record<string, string | undefined> = {};
  const credPath = () => path.join(home, ".claude", ".credentials.json");
  const writeActive = (expiresAt: number, extra: Record<string, any> = {}) =>
    fs.writeFileSync(
      credPath(),
      JSON.stringify({ claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt, ...extra } }),
    );

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-resnap-test-"));
    for (const k of ["HOME", "PATH", "CC_ACCOUNTS_FORCE_FILE"]) savedEnv[k] = process.env[k];
    process.env.HOME = home;
    process.env.PATH = path.join(home, "empty-path");
    process.env.CC_ACCOUNTS_FORCE_FILE = "1";
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: OAUTH_ACCOUNT }));
    invalidateAccountsCache();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
    invalidateAccountsCache();
  });

  it("re-snapshots the covering profile when the live login is fresher", () => {
    writeActive(1000);
    saveProfile("footage"); // stored snapshot: expiresAt 1000
    // A manual /login (or a proactive refresh) bumps the live expiry forward.
    writeActive(9_999_999);
    const updated = resnapshotIfActiveFresher();
    expect(updated).toBe("footage");
    const meta = listProfiles().find((p) => p.name === "footage");
    // The re-saved profile now carries the fresher token (assert via the secret).
    const secret = JSON.parse(
      fs.readFileSync(path.join(home, ".codecast", "cc-accounts", "footage.json"), "utf-8"),
    );
    expect(secret.credentials.claudeAiOauth.expiresAt).toBe(9_999_999);
    expect(meta).toBeDefined();
  });

  it("no-ops when the stored profile is already as fresh", () => {
    writeActive(5000);
    saveProfile("footage");
    expect(resnapshotIfActiveFresher()).toBeNull(); // active == stored
    writeActive(4000); // live copy is OLDER — still no-op
    expect(resnapshotIfActiveFresher()).toBeNull();
  });

  it("no-ops when no saved profile covers the active login", () => {
    writeActive(1000); // nothing saved yet
    expect(resnapshotIfActiveFresher()).toBeNull();
  });
});

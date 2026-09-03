import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readLocalCredentialAsync } from "./remote/session-move.js";
import {
  buildProfile,
  parseProfile,
  profileMeta,
  assertValidProfileName,
  deriveProfileName,
  autoSaveActiveProfile,
  migrateLegacyProfileNames,
  getAccountsHeartbeatPayload,
  invalidateAccountsCache,
  refreshActiveCredential,
  resnapshotIfActiveFresher,
  activeCredentialExpiresAt,
  readActiveCredential,
  readActiveCredentialAsync,
  credentialHealth,
  saveProfile,
  useProfile,
  deleteProfile,
  listProfiles,
  parseUsageResponse,
  refreshUsageSnapshots,
  readUsageCache,
  readActiveStamp,
  CcAccountError,
  createMtimeGatedCache,
  writeAccountToken,
  removeAccountToken,
  accountTokenInfo,
  accountSourcePrefix,
  accountTokenFilePath,
  SETUP_TOKEN_LIFETIME_MS,
  extractSetupToken,
  parseRateLimitFingerprint,
  sameAccountFingerprint,
  attributeFingerprint,
  activeAccountSummary,
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
  it("uses the email's local part, lowercased", () => {
    expect(deriveProfileName("claude2@almostcandid.com", [])).toBe("claude2");
    expect(deriveProfileName("Ashot@footage.com", [])).toBe("ashot");
  });

  it("falls back to the domain's org part, then -2/-3, when taken", () => {
    expect(deriveProfileName("ashot@Union.APP", ["ashot"])).toBe("union");
    expect(deriveProfileName("ashot@footage.com", ["Ashot", "footage"])).toBe("ashot-2");
    expect(deriveProfileName("ashot@footage.com", ["ashot", "footage", "ashot-2"])).toBe("ashot-3");
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
describe("createMtimeGatedCache", () => {
  it("memoizes (including a null result) until an mtime changes; invalidate forces recompute", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtime-cache-test-"));
    const file = path.join(dir, "a.json");
    fs.writeFileSync(file, "{}");
    fs.utimesSync(file, new Date(1000), new Date(1000));
    let calls = 0;
    let next: string | null = null;
    const cache = createMtimeGatedCache<string | null>(
      () => [file, path.join(dir, "missing.json")],
      () => {
        calls++;
        return next;
      },
    );
    // A failed/null compute is memoized against the same mtimes, not retried.
    expect(cache.get()).toBeNull();
    expect(cache.get()).toBeNull();
    expect(calls).toBe(1);
    // An mtime change recomputes.
    next = "fresh";
    fs.utimesSync(file, new Date(2000), new Date(2000));
    expect(cache.get()).toBe("fresh");
    expect(cache.get()).toBe("fresh");
    expect(calls).toBe(2);
    // Manual invalidation recomputes with unchanged mtimes.
    cache.invalidate();
    expect(cache.get()).toBe("fresh");
    expect(calls).toBe(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("with a ttl, recomputes after the window even when no mtime moved", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtime-cache-ttl-"));
    const file = path.join(dir, "a.json");
    fs.writeFileSync(file, "{}");
    let calls = 0;
    const cache = createMtimeGatedCache<number>(() => [file], () => ++calls, { ttlMs: 50 });
    expect(cache.get()).toBe(1);
    expect(cache.get()).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(cache.get()).toBe(2);
    expect(cache.get()).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

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
    expect(saved?.name).toBe("ashot");
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

describe("migrateLegacyProfileNames (sandboxed $HOME)", () => {
  let home: string;
  const savedEnv: Record<string, string | undefined> = {};
  const secretDir = () => path.join(home, ".codecast", "cc-accounts");
  const indexFile = () => path.join(home, ".codecast", "cc-accounts.json");

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-migrate-test-"));
    for (const k of ["HOME", "PATH", "CC_ACCOUNTS_FORCE_FILE"]) savedEnv[k] = process.env[k];
    process.env.HOME = home;
    process.env.PATH = path.join(home, "empty-path");
    process.env.CC_ACCOUNTS_FORCE_FILE = "1";
    fs.mkdirSync(secretDir(), { recursive: true });
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

  const seed = (profiles: Record<string, { email: string }>, secrets: string[]) => {
    fs.writeFileSync(indexFile(), JSON.stringify({ profiles }));
    for (const name of secrets) {
      fs.writeFileSync(path.join(secretDir(), `${name}.json`), `secret-of-${name}`);
    }
  };

  it("renames domain-derived names (with -N suffixes) and moves their secrets", () => {
    seed(
      {
        almostcandid: { email: "claude1@almostcandid.com" },
        "almostcandid-2": { email: "claude2@almostcandid.com" },
        work: { email: "boss@footage.com" }, // hand-picked — must stay
      },
      ["almostcandid", "almostcandid-2", "work"],
    );
    const renames = migrateLegacyProfileNames();
    expect(renames.sort((a, b) => a.from.localeCompare(b.from))).toEqual([
      { from: "almostcandid", to: "claude1" },
      { from: "almostcandid-2", to: "claude2" },
    ]);
    const index = JSON.parse(fs.readFileSync(indexFile(), "utf-8"));
    expect(Object.keys(index.profiles).sort()).toEqual(["claude1", "claude2", "work"]);
    expect(fs.readFileSync(path.join(secretDir(), "claude2.json"), "utf-8")).toBe(
      "secret-of-almostcandid-2",
    );
    expect(fs.existsSync(path.join(secretDir(), "almostcandid.json"))).toBe(false);
    expect(fs.existsSync(path.join(secretDir(), "work.json"))).toBe(true);
    // Idempotent: nothing left matching the legacy pattern.
    expect(migrateLegacyProfileNames()).toEqual([]);
  });

  it("skips index-only rows whose secret is missing", () => {
    seed({ almostcandid: { email: "claude1@almostcandid.com" } }, []);
    expect(migrateLegacyProfileNames()).toEqual([]);
    const index = JSON.parse(fs.readFileSync(indexFile(), "utf-8"));
    expect(Object.keys(index.profiles)).toEqual(["almostcandid"]);
  });
});

describe("deleteProfile (sandboxed $HOME)", () => {
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

  it("removes a dormant profile's secret + index entry and reports it gone", () => {
    saveProfile("footage");
    // Log the machine into a DIFFERENT account so "footage" goes dormant. A
    // real login swaps the credential too — relabelling one credential is the
    // poisoned shape saveProfile now refuses.
    const other = { accountUuid: "other-uuid", emailAddress: "ashot@union.app" };
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: other }));
    fs.writeFileSync(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { ...JSON.parse(CRED).claudeAiOauth, accessToken: "at-union" } }),
    );
    saveProfile("union");

    const meta = deleteProfile("footage");
    expect(meta.email).toBe("ashot@footage.com");
    expect(fs.existsSync(path.join(home, ".codecast", "cc-accounts", "footage.json"))).toBe(false);
    expect(listProfiles().map((p) => p.name)).toEqual(["union"]);
    expect(getAccountsHeartbeatPayload()?.profiles.map((p) => p.name)).toEqual(["union"]);
  });

  it("refuses to remove the profile covering the active login", () => {
    saveProfile("footage");
    expect(() => deleteProfile("footage")).toThrow(/active login/);
    // Email match guards too, even when the uuid rotated.
    const rotated = { ...OAUTH_ACCOUNT, accountUuid: "rotated-uuid" };
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: rotated }));
    invalidateAccountsCache();
    expect(() => deleteProfile("footage")).toThrow(/active login/);
    expect(listProfiles().map((p) => p.name)).toEqual(["footage"]);
  });

  it("throws on unknown or invalid names", () => {
    expect(() => deleteProfile("nope")).toThrow(/No saved profile/);
    expect(() => deleteProfile("a/b")).toThrow(CcAccountError);
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

  it("reads the active token's expiry", async () => {
    expect(await activeCredentialExpiresAt()).toBe(1781228581738);
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

  it("re-snapshots the covering profile when the live login is fresher", async () => {
    writeActive(1000);
    saveProfile("footage"); // stored snapshot: expiresAt 1000
    // A manual /login (or a proactive refresh) bumps the live expiry forward.
    writeActive(9_999_999);
    const updated = await resnapshotIfActiveFresher();
    expect(updated).toBe("footage");
    const meta = listProfiles().find((p) => p.name === "footage");
    // The re-saved profile now carries the fresher token (assert via the secret).
    const secret = JSON.parse(
      fs.readFileSync(path.join(home, ".codecast", "cc-accounts", "footage.json"), "utf-8"),
    );
    expect(secret.credentials.claudeAiOauth.expiresAt).toBe(9_999_999);
    expect(meta).toBeDefined();
  });

  it("no-ops when the stored profile is already as fresh", async () => {
    writeActive(5000);
    saveProfile("footage");
    expect(await resnapshotIfActiveFresher()).toBeNull(); // active == stored
    writeActive(4000); // live copy is OLDER — still no-op
    expect(await resnapshotIfActiveFresher()).toBeNull();
  });

  it("no-ops when no saved profile covers the active login", async () => {
    writeActive(1000); // nothing saved yet
    expect(await resnapshotIfActiveFresher()).toBeNull();
  });

  // The daemon's timers read the credential off the loop; the async read must
  // answer from the same store as the sync one, file store and file fallback alike.
  it("readActiveCredentialAsync and readLocalCredentialAsync match their sync twins", async () => {
    writeActive(1234);
    expect(await readActiveCredentialAsync()).toBe(readActiveCredential());
    // PATH names no real directory, so the keychain call fails and the read
    // falls back to the file. (Not compared with the sync read: bun's sync
    // spawn resolves `security` regardless of PATH, so on a Mac the sync
    // read answers from the real keychain here.)
    expect(await readLocalCredentialAsync()).toContain('"expiresAt":1234');
  });
});

describe("parseUsageResponse", () => {
  // Mirrors the live response shape verified against api.anthropic.com on
  // 2026-07-15 (fields we don't consume trimmed).
  const LIVE_SHAPE = {
    five_hour: { utilization: 28.0, resets_at: "2026-07-15T17:39:59.532998+00:00" },
    seven_day: { utilization: 27.0, resets_at: "2026-07-21T21:59:59.533030+00:00" },
    extra_usage: { is_enabled: true, monthly_limit: 40000, used_credits: 31502.0, utilization: 78.755 },
    limits: [
      { kind: "session", group: "session", percent: 28, severity: "normal", resets_at: "2026-07-15T17:39:59.532998+00:00", scope: null, is_active: false },
      { kind: "weekly_all", group: "weekly", percent: 27, severity: "normal", resets_at: "2026-07-21T21:59:59.533030+00:00", scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 42, severity: "normal", resets_at: "2026-07-21T21:59:59.533379+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true },
    ],
  };

  it("normalizes the limits array into session/weekly/scoped windows", () => {
    const snap = parseUsageResponse(LIVE_SHAPE, 5000);
    expect(snap.fetched_at).toBe(5000);
    expect(snap.session?.percent).toBe(28);
    expect(snap.session?.resets_at).toBe(Date.parse("2026-07-15T17:39:59.532998+00:00"));
    expect(snap.weekly?.percent).toBe(27);
    expect(snap.weekly_scoped?.percent).toBe(42);
    expect(snap.weekly_scoped?.label).toBe("Fable");
    expect(snap.extra).toEqual({ percent: 78.755, enabled: true });
  });

  it("keeps the most utilized scoped window when several exist", () => {
    const snap = parseUsageResponse(
      {
        limits: [
          { kind: "weekly_scoped", percent: 10, scope: { model: { display_name: "Sonnet" } } },
          { kind: "weekly_scoped", percent: 55, scope: { model: { display_name: "Fable" } } },
        ],
      },
      0,
    );
    expect(snap.weekly_scoped?.percent).toBe(55);
    expect(snap.weekly_scoped?.label).toBe("Fable");
  });

  it("falls back to five_hour/seven_day when limits are absent", () => {
    const snap = parseUsageResponse(
      {
        five_hour: { utilization: 12, resets_at: "2026-07-15T17:00:00+00:00" },
        seven_day: { utilization: 34, resets_at: "2026-07-21T21:00:00+00:00" },
      },
      0,
    );
    expect(snap.session?.percent).toBe(12);
    expect(snap.weekly?.percent).toBe(34);
  });

  it("tolerates junk without throwing", () => {
    expect(parseUsageResponse(null, 1).fetched_at).toBe(1);
    expect(parseUsageResponse({ limits: "nope" }, 1).session).toBeUndefined();
    expect(parseUsageResponse({ limits: [{ kind: "session", percent: "high" }] }, 1).session).toBeUndefined();
  });
});

describe("refreshUsageSnapshots (sandboxed $HOME, injected fetch)", () => {
  let home: string;
  const savedEnv: Record<string, string | undefined> = {};
  const NOW = 1_781_000_000_000;
  const LIVE_EXPIRY = NOW + 4 * 3600_000;

  const credFor = (token: string, expiresAt = LIVE_EXPIRY) =>
    JSON.stringify({
      claudeAiOauth: { accessToken: token, refreshToken: `rt-${token}`, expiresAt, subscriptionType: "max" },
    });
  const profileFor = (token: string, uuid: string, email: string, expiresAt = LIVE_EXPIRY) =>
    JSON.stringify({
      credentials: JSON.parse(credFor(token, expiresAt)),
      oauthAccount: { accountUuid: uuid, emailAddress: email },
      saved_at: NOW - 1000,
    });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-usage-test-"));
    for (const k of ["HOME", "PATH", "CC_ACCOUNTS_FORCE_FILE"]) savedEnv[k] = process.env[k];
    process.env.HOME = home;
    process.env.PATH = path.join(home, "empty-path");
    process.env.CC_ACCOUNTS_FORCE_FILE = "1";
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codecast", "cc-accounts"), { recursive: true });
    // Active login = account A; profiles a (covers active) + b (dormant, live
    // token) + c (dormant, expired token).
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), credFor("at-active"));
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "uuid-a", emailAddress: "a@x.com" } }),
    );
    fs.writeFileSync(path.join(home, ".codecast", "cc-accounts", "a.json"), profileFor("at-a-stale", "uuid-a", "a@x.com"));
    fs.writeFileSync(path.join(home, ".codecast", "cc-accounts", "b.json"), profileFor("at-b", "uuid-b", "b@x.com"));
    fs.writeFileSync(
      path.join(home, ".codecast", "cc-accounts", "c.json"),
      profileFor("at-c", "uuid-c", "c@x.com", NOW - 1000),
    );
    fs.writeFileSync(
      path.join(home, ".codecast", "cc-accounts.json"),
      JSON.stringify({
        profiles: {
          a: { uuid: "uuid-a", email: "a@x.com" },
          b: { uuid: "uuid-b", email: "b@x.com" },
          c: { uuid: "uuid-c", email: "c@x.com" },
        },
      }),
    );
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

  const usageFetch = (calls: string[]): typeof fetch =>
    (async (_url: any, init: any) => {
      const token = String(init?.headers?.Authorization ?? "").replace("Bearer ", "");
      calls.push(token);
      return new Response(
        JSON.stringify({ limits: [{ kind: "session", percent: token === "at-b" ? 90 : 28, resets_at: "2026-07-15T17:39:59+00:00" }] }),
        { status: 200 },
      );
    }) as any;

  it("probes the active token + live dormant tokens, skips expired ones, keys by uuid", async () => {
    const calls: string[] = [];
    const res = await refreshUsageSnapshots({ now: NOW, fetchImpl: usageFetch(calls) });
    // Active covers profile a (freshest token wins); b probed with its own
    // token; c skipped — its dormant token is expired and must never refresh.
    expect(calls.sort()).toEqual(["at-active", "at-b"]);
    expect(res.probed.sort()).toEqual(["active", "b"]);
    expect(res.skipped).toContain("c");
    const cache = readUsageCache();
    expect(cache.accounts["uuid-a"]?.session?.percent).toBe(28);
    expect(cache.accounts["uuid-b"]?.session?.percent).toBe(90);
    expect(cache.accounts["uuid-c"]).toBeUndefined();
  });

  it("throttles per-account probes within minIntervalMs", async () => {
    const calls: string[] = [];
    await refreshUsageSnapshots({ now: NOW, fetchImpl: usageFetch(calls) });
    await refreshUsageSnapshots({ now: NOW + 60_000, fetchImpl: usageFetch(calls) });
    expect(calls.length).toBe(2); // second pass: both entries fresh, no probes
    const later: string[] = [];
    await refreshUsageSnapshots({ now: NOW + 10 * 60_000, fetchImpl: usageFetch(later) });
    expect(later.length).toBe(2);
  });

  it("re-probes a just-activated account inside the throttle and reports when it became active", async () => {
    const calls: string[] = [];
    await refreshUsageSnapshots({ now: NOW, fetchImpl: usageFetch(calls) });
    expect(readActiveStamp()).toEqual({ key: "uuid-a", since: NOW });
    invalidateAccountsCache();
    expect(getAccountsHeartbeatPayload()?.active_since).toBe(NOW);

    // The machine switches to B (credential + label) a minute later. B's
    // snapshot is 60s old — inside the 4-minute throttle — but it predates
    // the activation, so it is re-read now.
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), credFor("at-b"));
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "uuid-b", emailAddress: "b@x.com" } }),
    );
    const after: string[] = [];
    const res = await refreshUsageSnapshots({ now: NOW + 60_000, fetchImpl: usageFetch(after) });
    expect(after).toEqual(["at-b"]);
    expect(res.skipped).toContain("a");
    expect(readActiveStamp()).toEqual({ key: "uuid-b", since: NOW + 60_000 });
    invalidateAccountsCache();
    const payload = getAccountsHeartbeatPayload();
    expect(payload?.active_uuid).toBe("uuid-b");
    expect(payload?.active_since).toBe(NOW + 60_000);
    // Unchanged account: the stamp stands and the throttle is back in force.
    const again: string[] = [];
    await refreshUsageSnapshots({ now: NOW + 90_000, fetchImpl: usageFetch(again) });
    expect(again).toEqual([]);
    expect(readActiveStamp()?.since).toBe(NOW + 60_000);
  });

  it("keeps the previous snapshot when a probe fails", async () => {
    const calls: string[] = [];
    await refreshUsageSnapshots({ now: NOW, fetchImpl: usageFetch(calls) });
    const res = await refreshUsageSnapshots({
      now: NOW + 10 * 60_000,
      fetchImpl: (async () => new Response("overloaded", { status: 529 })) as any,
    });
    expect(res.failed.length).toBe(2);
    // Old readings survive — stale beats blank.
    expect(readUsageCache().accounts["uuid-b"]?.session?.percent).toBe(90);
  });

  it("attaches usage to the heartbeat payload by account identity", async () => {
    await refreshUsageSnapshots({ now: NOW, fetchImpl: usageFetch([]) });
    invalidateAccountsCache();
    const payload = getAccountsHeartbeatPayload();
    const byName = Object.fromEntries((payload?.profiles ?? []).map((p) => [p.name, p]));
    expect(byName.a.usage?.session?.percent).toBe(28);
    expect(byName.b.usage?.session?.percent).toBe(90);
    expect(byName.c.usage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Per-account setup-token (launch-time env file)
// ---------------------------------------------------------------------------

describe("account setup-token file", () => {
  let home: string;
  const savedHome = process.env.HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-token-test-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const TOKEN = "sk-ant-oat01-" + "x".repeat(60);

  it("stores the token as a 0600 export file under ~/.codecast and reports its lifetime", () => {
    const file = writeAccountToken("union", TOKEN);
    expect(file).toBe(path.join(home, ".codecast", "cc-account-union.env"));
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect(fs.readFileSync(file, "utf-8")).toBe(`export CLAUDE_CODE_OAUTH_TOKEN='${TOKEN}'\n`);
    const info = accountTokenInfo("union")!;
    expect(info.file).toBe(file);
    expect(info.expires_at - info.stored_at).toBe(SETUP_TOKEN_LIFETIME_MS);
  });

  it("rejects anything that is not a setup-token (keychain access tokens, API keys, blanks)", () => {
    for (const bad of ["", "sk-ant-api03-abc", "at-123", "sk-ant-oat01-short", "sk-ant-oat01-" + "x".repeat(60) + " trailing"]) {
      expect(() => writeAccountToken("union", bad)).toThrow(CcAccountError);
    }
    expect(accountTokenInfo("union")).toBeNull();
  });

  it("validates the profile name so the file path can't escape ~/.codecast", () => {
    expect(() => accountTokenFilePath("../x")).toThrow(CcAccountError);
    expect(accountTokenInfo("../x")).toBeNull();
    expect(accountSourcePrefix("../x")).toBe("");
  });

  it("builds a source-the-file launch prefix only when a token is stored; warns and falls back otherwise", () => {
    const warnings: string[] = [];
    expect(accountSourcePrefix(undefined, (m) => warnings.push(m))).toBe("");
    expect(accountSourcePrefix("union", (m) => warnings.push(m))).toBe("");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("cast accounts token union");
    const file = writeAccountToken("union", TOKEN);
    expect(accountSourcePrefix("union", (m) => warnings.push(m))).toBe(`. ${file} 2>/dev/null || true; `);
    expect(warnings).toHaveLength(1);
    // The secret never appears on the launch line.
    expect(accountSourcePrefix("union")).not.toContain("sk-ant");
  });

  it("removes the file on --rm and reports whether one existed", () => {
    expect(removeAccountToken("union")).toBe(false);
    writeAccountToken("union", TOKEN);
    expect(removeAccountToken("union")).toBe(true);
    expect(accountTokenInfo("union")).toBeNull();
  });
});

describe("setup-token extraction + account fingerprint", () => {
  const TOKEN = "sk-ant-oat01-" + "Ab_-".repeat(20);

  it("pulls the token out of pane text (joined lines) and ignores other key shapes", () => {
    const pane = ` Your OAuth token (valid for 1 year):\n\n ${TOKEN}\n\n Store this token securely.`;
    expect(extractSetupToken(pane)).toBe(TOKEN);
    expect(extractSetupToken("sk-ant-api03-" + "x".repeat(60))).toBeNull();
    expect(extractSetupToken("Opening browser to sign in…")).toBeNull();
  });

  it("reads the unified rate-limit windows off response headers", () => {
    const h = new Headers({
      "anthropic-ratelimit-unified-5h-reset": "1788324000",
      "anthropic-ratelimit-unified-5h-utilization": "0.34",
      "anthropic-ratelimit-unified-7d-reset": "1788861600",
      "anthropic-ratelimit-unified-7d-utilization": "0.27",
    });
    expect(parseRateLimitFingerprint(h)).toEqual({
      five_hour_reset: 1788324000,
      seven_day_reset: 1788861600,
      five_hour_utilization: 0.34,
      seven_day_utilization: 0.27,
    });
    expect(parseRateLimitFingerprint(new Headers())).toEqual({
      five_hour_reset: null,
      seven_day_reset: null,
      five_hour_utilization: null,
      seven_day_utilization: null,
    });
  });

  it("same account = both reset timestamps match; unknown windows never match", () => {
    const a = { five_hour_reset: 1, seven_day_reset: 2, five_hour_utilization: 0.1, seven_day_utilization: 0.5 };
    expect(sameAccountFingerprint(a, { ...a, five_hour_utilization: 0.9 })).toBe(true);
    expect(sameAccountFingerprint(a, { ...a, five_hour_reset: 3 })).toBe(false);
    expect(sameAccountFingerprint(a, { ...a, seven_day_reset: 9 })).toBe(false);
    const unknown = { five_hour_reset: null, seven_day_reset: null, five_hour_utilization: null, seven_day_utilization: null };
    expect(sameAccountFingerprint(unknown, unknown)).toBe(false);
  });
});

describe("attributeFingerprint (token → saved profile via usage snapshots)", () => {
  const now = 1_788_320_000_000; // ms
  const profiles = { a: { uuid: "u-a" }, b: { uuid: "u-b" }, c: { email: "c@x.com" } };
  const usage = {
    "u-a": { fetched_at: now, session: { percent: 1, resets_at: 1_788_324_000_000 }, weekly: { percent: 1, resets_at: 1_788_861_600_000 } },
    "u-b": { fetched_at: now, session: { percent: 1, resets_at: 1_788_330_000_000 }, weekly: { percent: 1, resets_at: 1_788_900_000_000 } },
    "c@x.com": { fetched_at: now - 86_400_000, session: { percent: 1, resets_at: 1_788_200_000_000 }, weekly: { percent: 1, resets_at: 1_788_950_000_000 } },
  } as any;
  const fp = (five: number | null, seven: number | null) =>
    ({ five_hour_reset: five, seven_day_reset: seven, five_hour_utilization: null, seven_day_utilization: null });

  it("names the one profile whose 7d and (open) 5h windows match, to the second", () => {
    expect(attributeFingerprint(fp(1_788_324_000, 1_788_861_600), profiles, usage, now)).toBe("a");
    expect(attributeFingerprint(fp(1_788_324_001, 1_788_861_600), profiles, usage, now)).toBe("a"); // ±2s
  });

  it("an open 5h window that disagrees rules the profile out even when 7d matches", () => {
    expect(attributeFingerprint(fp(1_788_325_000, 1_788_861_600), profiles, usage, now)).toBeNull();
  });

  it("a stale snapshot (5h window already closed) attributes on the 7d reset alone", () => {
    expect(attributeFingerprint(fp(1_788_400_000, 1_788_950_000), profiles, usage, now)).toBe("c");
  });

  it("unknown 7d reset, no snapshot, or an ambiguous match yields null", () => {
    expect(attributeFingerprint(fp(1, null), profiles, usage, now)).toBeNull();
    expect(attributeFingerprint(fp(1_788_324_000, 1_788_861_600), { z: { uuid: "u-z" } }, usage, now)).toBeNull();
    const twin = { ...usage, "u-b": usage["u-a"] };
    expect(attributeFingerprint(fp(1_788_324_000, 1_788_861_600), profiles, twin, now)).toBeNull();
  });
});

// Regression for 2026-09-02: three profiles (claude2, claude3, fresh) all held
// ONE access token under three names, and the machine ran account B while
// ~/.claude.json still labelled it A. Root cause: a switch to a profile saved
// without an identity block left the OUTGOING account's label in place, so
// every later save-on-switch re-saved the live token under the wrong profile.
// The mint flow then rejected every token it minted, because attribution
// judged it against a store that agreed with itself and with nothing real.
describe("switch identity integrity (sandboxed $HOME)", () => {
  let home: string;
  const savedEnv: Record<string, string | undefined> = {};
  const credFor = (token: string) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        refreshToken: `rt-${token}`,
        expiresAt: Date.now() + 3_600_000,
        scopes: ["user:inference"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      },
    });
  const label = (uuid: string, email: string) =>
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: email } }),
    );
  const activeToken = () =>
    JSON.parse(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf-8"))
      .claudeAiOauth.accessToken;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-identity-test-"));
    for (const k of ["HOME", "PATH", "CC_ACCOUNTS_FORCE_FILE"]) savedEnv[k] = process.env[k];
    process.env.HOME = home;
    process.env.PATH = path.join(home, "empty-path");
    process.env.CC_ACCOUNTS_FORCE_FILE = "1";
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
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

  it("moves the identity label with the credential, even when the profile saved none", () => {
    // Save account A normally, then hand-write a profile for B with no identity
    // block — the shape a profile saved while ~/.claude.json was missing has.
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), credFor("token-a"));
    label("uuid-a", "a@example.com");
    saveProfile("aaa");
    fs.writeFileSync(
      path.join(home, ".codecast", "cc-accounts", "bbb.json"),
      JSON.stringify({ credentials: JSON.parse(credFor("token-b")), oauthAccount: {}, saved_at: 1 }),
    );
    const index = JSON.parse(fs.readFileSync(path.join(home, ".codecast", "cc-accounts.json"), "utf-8"));
    index.profiles.bbb = { email: "b@example.com", uuid: "uuid-b" };
    fs.writeFileSync(path.join(home, ".codecast", "cc-accounts.json"), JSON.stringify(index));
    invalidateAccountsCache();

    useProfile("bbb");
    expect(activeToken()).toBe("token-b");
    // The label must name B. Naming A is what poisoned the store.
    expect(activeAccountSummary()?.uuid).toBe("uuid-b");
    expect(listProfiles().find((p) => p.active)?.name).toBe("bbb");
    // The switch itself stamps the activation, so a pre-switch snapshot can't
    // pass as evidence about B before the daemon's next usage tick.
    expect(readActiveStamp()?.key).toBe("uuid-b");
    expect(getAccountsHeartbeatPayload()?.active_since).toBe(readActiveStamp()?.since);
  });

  it("refuses to save one credential under a second profile name", () => {
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), credFor("token-a"));
    label("uuid-a", "a@example.com");
    saveProfile("aaa");
    // The label lies: the machine still runs A's token, but claims to be B.
    label("uuid-b", "b@example.com");
    invalidateAccountsCache();
    expect(() => saveProfile("bbb")).toThrow(/already stored as "aaa"/);
    expect(listProfiles().map((p) => p.name)).toEqual(["aaa"]);
  });

  it("keeps save-on-switch from copying the live token into another profile", () => {
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), credFor("token-a"));
    label("uuid-a", "a@example.com");
    saveProfile("aaa");
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), credFor("token-b"));
    label("uuid-b", "b@example.com");
    saveProfile("bbb");
    // Poison the label by hand: the machine holds B's token, labelled A.
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), credFor("token-b"));
    label("uuid-a", "a@example.com");
    invalidateAccountsCache();

    // The switch-away re-snapshot must not overwrite aaa with B's token.
    useProfile("aaa");
    const stored = JSON.parse(
      fs.readFileSync(path.join(home, ".codecast", "cc-accounts", "aaa.json"), "utf-8"),
    );
    expect(stored.credentials.claudeAiOauth.accessToken).toBe("token-a");
  });
});

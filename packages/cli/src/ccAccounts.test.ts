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
  parseRetryAfter,
  refreshUsageSnapshots,
  readUsageCache,
  readActiveStamp,
  parseStatusLineUsage,
  ingestStatusLineUsage,
  CcAccountError,
  createMtimeGatedCache,
  accountSourcePrefix,
  accountLaunchFilePath,
  accountLaunchInfo,
  profileStoreDir,
  profileStoreKeychainService,
  readProfileStoreCredentials,
  writeProfileStoreCredentials,
  deleteProfileStore,
  ensureProfileStore,
  absorbProfileStore,
  credentialIsFresher,
  adoptProfileStoreCredential,
  probeSecureStorageSupport,
  activeAccountSummary,
  matchProfileForCredential,
  tokenKey,
} from "./ccAccounts.js";
import { isolateCodecastDir, type IsolatedCodecastDir } from "./test-helpers/codecastDir.js";

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
      JSON.stringify({
        claudeAiOauth: { ...JSON.parse(CRED).claudeAiOauth, accessToken: "at-union", refreshToken: "rt-union" },
      }),
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
    // The profile's own credential store never takes a stub, so it still holds
    // the good pair and the read recovers it. Only once that copy is gone is
    // the profile truly unusable.
    expect(() => useProfile("footage")).not.toThrow();
    // (that switch re-snapshotted the good active login; poison again, and this
    // time without a store copy to fall back on)
    fs.writeFileSync(
      path.join(home, ".codecast", "cc-accounts", "footage.json"),
      JSON.stringify({ credentials: JSON.parse(LOGGED_OUT_STUB), oauthAccount: OAUTH_ACCOUNT, saved_at: 1 }),
    );
    deleteProfileStore("footage");
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

// The read back: when a live claude holds the active credential the daemon
// defers its own refresh (ccLiveGate.ts) and folds whatever the CLI rotated
// into the profile that credential belongs to. Naming that profile from the
// credential rather than from a label is what keeps one login from being saved
// under several names (ct-49526).
describe("identity matched read back", () => {
  let home: string;
  let isolated: IsolatedCodecastDir;
  const savedEnv: Record<string, string | undefined> = {};

  const ALPHA = {
    accountUuid: "aaaaaaaa-0000-0000-0000-000000000001",
    emailAddress: "alpha@example.com",
    organizationUuid: "org-alpha",
  };
  const BETA = {
    accountUuid: "bbbbbbbb-0000-0000-0000-000000000002",
    emailAddress: "beta@example.com",
    organizationUuid: "org-beta",
  };

  const credOf = (accessToken: string, refreshToken: string, expiresAt: number) =>
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt, subscriptionType: "max" } });

  const secretPath = (name: string) => path.join(home, ".codecast", "cc-accounts", `${name}.json`);
  const storedOauth = (name: string) =>
    JSON.parse(fs.readFileSync(secretPath(name), "utf-8")).credentials.claudeAiOauth;

  /** A saved profile, written the way saveProfile writes one. Built rather than
   *  hand-rolled so the fixture cannot drift from the real storage shape. */
  const writeProfile = (name: string, oauthAccount: Record<string, any>, cred: string) => {
    const profile = buildProfile(cred, oauthAccount, 1);
    fs.mkdirSync(path.dirname(secretPath(name)), { recursive: true });
    fs.writeFileSync(secretPath(name), JSON.stringify(profile));
    const file = path.join(home, ".codecast", "cc-accounts.json");
    const index = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : { profiles: {} };
    index.profiles[name] = profileMeta(profile);
    fs.writeFileSync(file, JSON.stringify(index));
    invalidateAccountsCache();
  };

  /** The machine's active login: the credential store plus ~/.claude.json's label. */
  const setActive = (oauthAccount: Record<string, any>, cred: string) => {
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), cred);
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount }));
    invalidateAccountsCache();
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-readback-test-"));
    for (const k of ["HOME", "PATH", "CC_ACCOUNTS_FORCE_FILE"]) savedEnv[k] = process.env[k];
    process.env.HOME = home;
    process.env.PATH = path.join(home, "empty-path");
    process.env.CC_ACCOUNTS_FORCE_FILE = "1";
    // The profile store resolves its directory through defaultConfigDir, which
    // reads CODECAST_DIR first (ct-49869). Point it at this test's own home so
    // the fixtures below and the module under test agree on one directory, and
    // nothing reaches the human's real state.
    isolated = isolateCodecastDir("cc-readback-home-");
    process.env.CODECAST_DIR = path.join(home, ".codecast");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
    invalidateAccountsCache();
  });

  afterEach(() => {
    isolated.restore();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
    invalidateAccountsCache();
  });

  it("matches exactly one profile by account uuid", async () => {
    writeProfile("alpha", ALPHA, credOf("at-alpha", "rt-alpha", 1000));
    writeProfile("beta", BETA, credOf("at-beta", "rt-beta", 1000));
    expect(await matchProfileForCredential({ uuid: ALPHA.accountUuid })).toEqual({
      kind: "matched",
      name: "alpha",
    });
  });

  it("matches by email, organization, or refresh token equality", async () => {
    writeProfile("alpha", ALPHA, credOf("at-alpha", "rt-alpha", 1000));
    writeProfile("beta", BETA, credOf("at-beta", "rt-beta", 1000));
    expect(await matchProfileForCredential({ email: "BETA@example.com" })).toEqual({
      kind: "matched",
      name: "beta",
    });
    expect(await matchProfileForCredential({ organization: "org-alpha" })).toEqual({
      kind: "matched",
      name: "alpha",
    });
    // The strongest evidence there is: one refresh token belongs to one grant,
    // and it names the profile even with no label at all.
    expect(await matchProfileForCredential({ refreshToken: "rt-beta" })).toEqual({
      kind: "matched",
      name: "beta",
    });
  });

  it("refuses an ambiguous match rather than picking the first", async () => {
    // The 2026-09-02 poisoning shape: one account labelled under two names.
    writeProfile("alpha", ALPHA, credOf("at-alpha", "rt-alpha", 1000));
    writeProfile("alpha-dup", ALPHA, credOf("at-dup", "rt-dup", 1000));
    const match = await matchProfileForCredential({ uuid: ALPHA.accountUuid });
    expect(match.kind).toBe("ambiguous");
    expect((match as { names: string[] }).names.sort()).toEqual(["alpha", "alpha-dup"]);
  });

  // A profile we cannot judge at all might BE this account, so a single match
  // beside it is still a guess.
  it("refuses when a profile carries no identity to rule out", async () => {
    writeProfile("alpha", ALPHA, credOf("at-alpha", "rt-alpha", 1000));
    writeProfile("blank", {}, credOf("at-blank", "", 1000));
    expect(await matchProfileForCredential({ uuid: ALPHA.accountUuid })).toEqual({
      kind: "ambiguous",
      names: ["alpha"],
    });
  });

  it("answers none when no profile covers the credential", async () => {
    writeProfile("alpha", ALPHA, credOf("at-alpha", "rt-alpha", 1000));
    writeProfile("beta", BETA, credOf("at-beta", "rt-beta", 1000));
    expect(await matchProfileForCredential({ uuid: "cccccccc-0000-0000-0000-000000000003" })).toEqual({
      kind: "none",
    });
  });

  it("a disagreeing field rules a profile out even when another agrees", async () => {
    // Two accounts in one organization: the organization agrees, the email is
    // what tells them apart.
    writeProfile("alpha", { ...ALPHA, organizationUuid: "org-shared" }, credOf("at-alpha", "rt-alpha", 1000));
    writeProfile("beta", { ...BETA, organizationUuid: "org-shared" }, credOf("at-beta", "rt-beta", 1000));
    expect(
      await matchProfileForCredential({ email: BETA.emailAddress, organization: "org-shared" }),
    ).toEqual({ kind: "matched", name: "beta" });
  });

  it("reads a rotated refresh token back into its profile at an unchanged expiry", async () => {
    writeProfile("alpha", ALPHA, credOf("at-alpha", "rt-alpha", 5000));
    writeProfile("beta", BETA, credOf("at-beta", "rt-beta", 5000));
    // What a live claude leaves behind: a new pair at the same recorded expiry.
    // The stored refresh token is spent from this moment, so the profile has to
    // take the new one even though nothing looks fresher.
    setActive(ALPHA, credOf("at-rotated", "rt-alpha-2", 5000));
    const warnings: string[] = [];
    expect(await resnapshotIfActiveFresher({ warn: (m) => warnings.push(m) })).toBe("alpha");
    expect(storedOauth("alpha").refreshToken).toBe("rt-alpha-2");
    expect(storedOauth("alpha").accessToken).toBe("at-rotated");
    expect(storedOauth("beta").refreshToken).toBe("rt-beta"); // untouched
    expect(warnings).toEqual([]);
  });

  it("leaves the profile alone when the live credential is older", async () => {
    writeProfile("alpha", ALPHA, credOf("at-alpha", "rt-alpha", 5000));
    setActive(ALPHA, credOf("at-old", "rt-alpha-0", 4000));
    expect(await resnapshotIfActiveFresher()).toBeNull();
    expect(storedOauth("alpha").refreshToken).toBe("rt-alpha");
  });

  it("refuses the read back when the match is ambiguous, and says so", async () => {
    writeProfile("alpha", ALPHA, credOf("at-alpha", "rt-alpha", 1000));
    writeProfile("alpha-dup", ALPHA, credOf("at-dup", "rt-dup", 1000));
    setActive(ALPHA, credOf("at-rotated", "rt-alpha-2", 9000));
    const warnings: string[] = [];
    expect(await resnapshotIfActiveFresher({ warn: (m) => warnings.push(m) })).toBeNull();
    expect(warnings.join(" ")).toContain("matches 2 profiles");
    expect(storedOauth("alpha").refreshToken).toBe("rt-alpha");
    expect(storedOauth("alpha-dup").refreshToken).toBe("rt-dup");
  });

  // Fault injection. Two profiles hold copies of ONE refresh token — the state a
  // botched save or an old restore leaves behind. Rotating it strands whichever
  // copy is not written back, so the read back must refuse and leave both alone.
  // The access tokens differ, so only the refresh half can catch this.
  it("refuses to write into a profile whose refresh token a second profile also holds", async () => {
    writeProfile("alpha", ALPHA, credOf("at-alpha", "rt-shared", 1000));
    writeProfile("beta", BETA, credOf("at-beta", "rt-shared", 1000));
    setActive(ALPHA, credOf("at-rotated", "rt-shared", 9000));
    const warnings: string[] = [];
    expect(await resnapshotIfActiveFresher({ warn: (m) => warnings.push(m) })).toBeNull();
    expect(warnings.join(" ")).toContain("refresh token");
    expect(storedOauth("alpha").accessToken).toBe("at-alpha");
    expect(storedOauth("beta").accessToken).toBe("at-beta");
  });

  // The 2026-09-02 poisoning read from the other end: a switch left ~/.claude.json
  // naming the account we switched AWAY from. The credential's own verdict wins,
  // and the stale label's organization must not come along for the ride — it
  // would rule out the very profile the verified uuid names.
  it("ignores a stale label when the credential has proved a different account", async () => {
    writeProfile("alpha", ALPHA, credOf("at-alpha", "rt-alpha", 5000));
    writeProfile("beta", BETA, credOf("at-beta", "rt-beta", 5000));
    setActive(BETA, credOf("at-rotated", "rt-alpha-2", 9000));
    fs.writeFileSync(
      path.join(home, ".codecast", "cc-identity.json"),
      JSON.stringify({
        tokens: {
          [tokenKey("at-rotated")]: {
            uuid: ALPHA.accountUuid,
            email: ALPHA.emailAddress,
            verified_at: 1,
          },
        },
      }),
    );
    invalidateAccountsCache();
    expect(await resnapshotIfActiveFresher()).toBe("alpha");
    expect(storedOauth("alpha").refreshToken).toBe("rt-alpha-2");
    expect(storedOauth("beta").refreshToken).toBe("rt-beta");
  });

  it("saveProfile refuses a credential another profile already holds by refresh token", () => {
    writeProfile("beta", BETA, credOf("at-beta", "rt-shared", 1000));
    setActive(ALPHA, credOf("at-alpha", "rt-shared", 9000));
    expect(() => saveProfile("alpha")).toThrow(/shares its refresh token .* "beta"/);
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

  // The usage endpoint answers by bearer token; the token endpoint (c's
  // lapsed dormant grant is rotated before its probe) hands out a fixed
  // rotated pair. `calls` records the usage probes only.
  const usageFetch = (calls: string[]): typeof fetch =>
    (async (url: any, init: any) => {
      if (String(url).includes("/oauth/token")) {
        return new Response(
          JSON.stringify({ access_token: "at-c-rotated", refresh_token: "rt-c-rotated", expires_in: 28800 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      const token = String(init?.headers?.Authorization ?? "").replace("Bearer ", "");
      calls.push(token);
      return new Response(
        JSON.stringify({ limits: [{ kind: "session", percent: token === "at-b" ? 90 : 28, resets_at: "2026-07-15T17:39:59+00:00" }] }),
        { status: 200 },
      );
    }) as any;

  it("probes the active token + live dormant tokens, rotates lapsed ones first, keys by uuid", async () => {
    const calls: string[] = [];
    const res = await refreshUsageSnapshots({ now: NOW, fetchImpl: usageFetch(calls) });
    // Active covers profile a (freshest token wins); b probed with its own
    // token; c's dormant token had lapsed, so it was rotated and probed with
    // the new one — its reading no longer freezes at the last live probe.
    expect(calls.sort()).toEqual(["at-active", "at-b", "at-c-rotated"]);
    expect(res.probed.sort()).toEqual(["active", "b", "c"]);
    expect(res.rotated).toEqual(["c"]);
    const cache = readUsageCache();
    expect(cache.accounts["uuid-a"]?.session?.percent).toBe(28);
    expect(cache.accounts["uuid-b"]?.session?.percent).toBe(90);
    expect(cache.accounts["uuid-c"]?.session?.percent).toBe(28);
  });

  it("throttles per-account probes within minIntervalMs", async () => {
    const calls: string[] = [];
    await refreshUsageSnapshots({ now: NOW, fetchImpl: usageFetch(calls) });
    await refreshUsageSnapshots({ now: NOW + 60_000, fetchImpl: usageFetch(calls) });
    expect(calls.length).toBe(3); // second pass: every entry fresh, no probes
    const later: string[] = [];
    await refreshUsageSnapshots({ now: NOW + 10 * 60_000, fetchImpl: usageFetch(later) });
    expect(later.length).toBe(3);
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
    expect(res.failed.length).toBe(3);
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
    expect(byName.c.usage?.session?.percent).toBe(28);
  });

  // --- Live usage forwarded by a session's statusLine command (ct-49525) ---
  // A running session reports its account's windows every turn, which is both
  // fresher and free next to the five-minute OAuth poll. These cover who a post
  // is attributed to, and which of the two readings wins when they disagree.

  const statusLinePayload = (fiveHour: number, sevenDay: number) => ({
    session_id: "f03e4098-8b2b-44e0-9370-de3b4fc2edd0",
    cost: { total_duration_ms: 17462 },
    rate_limits: {
      five_hour: { used_percentage: fiveHour, resets_at: 1_788_759_000 },
      seven_day: { used_percentage: sevenDay, resets_at: 1_789_016_400 },
    },
  });

  it("reads the windows Claude Code 2.1.263 actually sends, seconds converted to ms", () => {
    const snap = parseStatusLineUsage(statusLinePayload(7, 32), NOW);
    expect(snap).toEqual({
      fetched_at: NOW,
      source: "live-session",
      session: { percent: 7, resets_at: 1_788_759_000_000 },
      weekly: { percent: 32, resets_at: 1_789_016_400_000 },
    });
    expect(parseStatusLineUsage({ cost: { total_duration_ms: 1 } }, NOW)).toBeNull();
    expect(parseStatusLineUsage({ rate_limits: {} }, NOW)).toBeNull();
  });

  it("attributes a post to the session's pinned account, and an unpinned one to the active login", async () => {
    await refreshUsageSnapshots({ now: NOW, fetchImpl: usageFetch([]) });
    expect((await ingestStatusLineUsage(statusLinePayload(11, 12), { account: "b", now: NOW + 1000 }))?.key).toBe("uuid-b");
    // No account name: the session runs on the keychain login, which the
    // activation stamp names without a keychain read.
    expect((await ingestStatusLineUsage(statusLinePayload(13, 14), { account: undefined, now: NOW + 1000 }))?.key).toBe("uuid-a");
    expect(await ingestStatusLineUsage(statusLinePayload(1, 2), { account: "../x", now: NOW })).toBeNull();
    const cache = readUsageCache();
    expect(cache.accounts["uuid-b"]?.session?.percent).toBe(11);
    expect(cache.accounts["uuid-a"]?.session?.percent).toBe(13);
  });

  it("carries the live reading to the heartbeat without the local source marker", async () => {
    await refreshUsageSnapshots({ now: NOW, fetchImpl: usageFetch([]) });
    await ingestStatusLineUsage(statusLinePayload(44, 55), { account: "b", now: NOW + 1000 });
    invalidateAccountsCache();
    const b = (getAccountsHeartbeatPayload()?.profiles ?? []).find((p) => p.name === "b");
    expect(b?.usage?.session?.percent).toBe(44);
    // Convex's ccUsageValidator accepts no unknown field: a daemon that sent
    // this would have its whole account inventory rejected.
    expect(b?.usage && "source" in b.usage).toBe(false);
  });

  it("keeps the model-scoped window the poll found — the live payload has none", async () => {
    await refreshUsageSnapshots({ now: NOW, fetchImpl: usageFetch([]) });
    const cache = readUsageCache();
    cache.accounts["uuid-b"]!.weekly_scoped = { percent: 100, resets_at: NOW + 3600_000, label: "Fable" };
    fs.writeFileSync(path.join(home, ".codecast", "cc-usage.json"), JSON.stringify(cache));
    await ingestStatusLineUsage(statusLinePayload(2, 3), { account: "b", now: NOW + 1000 });
    // Dropping it would read as headroom on an account whose Fable window is
    // pegged, and auto-switch would send sessions there.
    expect(readUsageCache().accounts["uuid-b"]?.weekly_scoped?.percent).toBe(100);
  });

  it("suppresses the poll for an account a live session is feeding, and resumes when it goes quiet", async () => {
    await refreshUsageSnapshots({ now: NOW, fetchImpl: usageFetch([]) });
    await ingestStatusLineUsage(statusLinePayload(60, 61), { account: "b", now: NOW + 60_000 });

    const during: string[] = [];
    const res = await refreshUsageSnapshots({ now: NOW + 5 * 60_000, fetchImpl: usageFetch(during) });
    expect(during).not.toContain("at-b");
    expect(res.skipped).toContain("b");
    expect(readUsageCache().accounts["uuid-b"]?.session?.percent).toBe(60);

    // Five minutes past the last post the feed counts as gone and the endpoint
    // is the only reading left.
    const after: string[] = [];
    await refreshUsageSnapshots({ now: NOW + 11 * 60_000, fetchImpl: usageFetch(after) });
    expect(after).toContain("at-b");
    expect(readUsageCache().accounts["uuid-b"]?.session?.percent).toBe(90);
  });

  // The live payload has no model-scoped window. An account posting without
  // pause would otherwise keep its Fable meter frozen at the last poll's
  // reading, and auto-switch would send sessions to an account that pegged
  // hours ago.
  it("polls anyway once the endpoint has been silent for half an hour", async () => {
    await refreshUsageSnapshots({ now: NOW, fetchImpl: usageFetch([]) });
    const post = async (at: number) => {
      await ingestStatusLineUsage(statusLinePayload(3, 4), { account: "b", now: at });
      const calls: string[] = [];
      await refreshUsageSnapshots({ now: at + 60_000, fetchImpl: usageFetch(calls) });
      return calls;
    };
    // A feed that keeps posting holds the poll off — until the floor.
    expect(await post(NOW + 10 * 60_000)).not.toContain("at-b");
    expect(await post(NOW + 20 * 60_000)).not.toContain("at-b");
    expect(await post(NOW + 31 * 60_000)).toContain("at-b");
  });

  it("never lets a failed or slow poll overwrite a live reading", async () => {
    await refreshUsageSnapshots({ now: NOW, fetchImpl: usageFetch([]) });
    await ingestStatusLineUsage(statusLinePayload(70, 71), { account: "b", now: NOW + 6 * 60_000 });

    // A poll that fails leaves the live reading standing.
    await refreshUsageSnapshots({
      now: NOW + 12 * 60_000,
      fetchImpl: (async () => new Response("overloaded", { status: 529 })) as any,
    });
    expect(readUsageCache().accounts["uuid-b"]?.session?.percent).toBe(70);

    // And a post that lands WHILE the probes run is not written back over: the
    // pass re-reads the cache instead of flushing the copy it started with.
    let posted = false;
    await refreshUsageSnapshots({
      now: NOW + 20 * 60_000,
      fetchImpl: (async (url: any, init: any) => {
        if (!posted) {
          posted = true;
          await ingestStatusLineUsage(statusLinePayload(80, 81), { account: "b", now: NOW + 20 * 60_000 + 1 });
        }
        return usageFetch([])(url, init);
      }) as any,
    });
    expect(readUsageCache().accounts["uuid-b"]?.session?.percent).toBe(80);
  });

  it("does not rewrite the cache for an unchanged reading", async () => {
    await refreshUsageSnapshots({ now: NOW, fetchImpl: usageFetch([]) });
    expect((await ingestStatusLineUsage(statusLinePayload(5, 6), { account: "b", now: NOW + 1000 }))?.wrote).toBe(true);
    expect((await ingestStatusLineUsage(statusLinePayload(5, 6), { account: "b", now: NOW + 16_000 }))?.wrote).toBe(false);
    // A real move is always written, however soon it arrives.
    expect((await ingestStatusLineUsage(statusLinePayload(6, 6), { account: "b", now: NOW + 31_000 }))?.wrote).toBe(true);
  });

  // The token endpoint + usage endpoint behind one fetch: a refresh with the
  // expected refresh token rotates; anything else is refused with the given
  // status. Usage answers carry the bearer token so the test can see which
  // credential probed.
  const dualFetch = (
    calls: { tokenPosts: string[]; usage: string[] },
    opts: { refuse?: number } = {},
  ): typeof fetch =>
    (async (url: any, init: any) => {
      if (String(url).includes("/oauth/token")) {
        const body = new URLSearchParams(String(init?.body));
        calls.tokenPosts.push(body.get("refresh_token") ?? "");
        if (opts.refuse) return new Response('{"error":"invalid_grant"}', { status: opts.refuse });
        return new Response(
          JSON.stringify({ access_token: "at-c-rotated", refresh_token: "rt-c-rotated", expires_in: 28800 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      const token = String(init?.headers?.Authorization ?? "").replace("Bearer ", "");
      calls.usage.push(token);
      return new Response(
        JSON.stringify({ limits: [{ kind: "session", percent: token === "at-c-rotated" ? 12 : 28, resets_at: "2026-07-15T17:39:59+00:00" }] }),
        { status: 200 },
      );
    }) as any;

  const readProfileC = () => JSON.parse(fs.readFileSync(path.join(home, ".codecast", "cc-accounts", "c.json"), "utf-8"));
  const readIndex = () => JSON.parse(fs.readFileSync(path.join(home, ".codecast", "cc-accounts.json"), "utf-8"));

  it("rotates a lapsed dormant grant with its own refresh token, then probes with the new one", async () => {
    const calls = { tokenPosts: [] as string[], usage: [] as string[] };
    const res = await refreshUsageSnapshots({ now: NOW, fetchImpl: dualFetch(calls) });
    expect(calls.tokenPosts).toEqual(["rt-at-c"]);
    expect(calls.usage.sort()).toEqual(["at-active", "at-b", "at-c-rotated"]);
    expect(res.rotated).toEqual(["c"]);
    expect(res.probed.sort()).toEqual(["active", "b", "c"]);
    expect(readUsageCache().accounts["uuid-c"]?.session?.percent).toBe(12);
    // The rotated pair lives in the profile now — the next switch to c lands
    // on a live login; everything else in the blob is untouched.
    const c = readProfileC();
    expect(c.credentials.claudeAiOauth.accessToken).toBe("at-c-rotated");
    expect(c.credentials.claudeAiOauth.refreshToken).toBe("rt-c-rotated");
    expect(c.credentials.claudeAiOauth.expiresAt).toBe(NOW + 28800 * 1000);
    expect(c.credentials.claudeAiOauth.subscriptionType).toBe("max");
    expect(c.oauthAccount.accountUuid).toBe("uuid-c");
    // Live now: the next pass inside the throttle neither rotates nor probes.
    const again = { tokenPosts: [] as string[], usage: [] as string[] };
    await refreshUsageSnapshots({ now: NOW + 60_000, fetchImpl: dualFetch(again) });
    expect(again.tokenPosts).toEqual([]);
    expect(again.usage).toEqual([]);
  });

  it("marks a refused grant login-expired, keeps the last snapshot, and never retries it until re-saved", async () => {
    // Seed c with a reading from a probe made while its token still lived
    // (an hour ago it had 1000ms left), so the refusal has a snapshot to keep.
    const seed = { tokenPosts: [] as string[], usage: [] as string[] };
    await refreshUsageSnapshots({ now: NOW - 3600_000, fetchImpl: dualFetch(seed) });
    expect(seed.tokenPosts).toEqual([]);
    const calls = { tokenPosts: [] as string[], usage: [] as string[] };
    const res = await refreshUsageSnapshots({ now: NOW, fetchImpl: dualFetch(calls, { refuse: 400 }) });
    expect(calls.tokenPosts).toEqual(["rt-at-c"]);
    expect(res.expired).toEqual(["c"]);
    expect(res.failed).toEqual([]);
    expect(readIndex().profiles.c.login_expired_at).toBe(NOW);
    expect(readUsageCache().accounts["uuid-c"]?.session?.percent).toBe(28); // stale beats blank
    expect(readProfileC().credentials.claudeAiOauth.refreshToken).toBe("rt-at-c"); // untouched
    // The heartbeat says so, and the next pass leaves the dead grant alone.
    invalidateAccountsCache();
    const byName = Object.fromEntries((getAccountsHeartbeatPayload()?.profiles ?? []).map((p) => [p.name, p]));
    expect(byName.c.login_expired_at).toBe(NOW);
    expect(byName.b.login_expired_at).toBeUndefined();
    const later = { tokenPosts: [] as string[], usage: [] as string[] };
    const res2 = await refreshUsageSnapshots({ now: NOW + 10 * 60_000, fetchImpl: dualFetch(later) });
    expect(later.tokenPosts).toEqual([]);
    expect(res2.skipped).toContain("c");
  });

  it("treats a token-endpoint outage as transient: no mark, no write, retried next pass", async () => {
    const calls = { tokenPosts: [] as string[], usage: [] as string[] };
    const res = await refreshUsageSnapshots({ now: NOW, fetchImpl: dualFetch(calls, { refuse: 503 }) });
    expect(res.failed.map((f) => f.name)).toEqual(["c"]);
    expect(res.expired).toEqual([]);
    expect(readIndex().profiles.c.login_expired_at).toBeUndefined();
    expect(readProfileC().credentials.claudeAiOauth.accessToken).toBe("at-c");
    const retry = { tokenPosts: [] as string[], usage: [] as string[] };
    await refreshUsageSnapshots({ now: NOW + 10 * 60_000, fetchImpl: dualFetch(retry) });
    expect(retry.tokenPosts).toEqual(["rt-at-c"]);
  });

  it("marks an index entry with no secret behind it login-expired instead of skipping it silently", async () => {
    // 2026-09-03: two profiles had index rows but no keychain item; the loop
    // stepped over them and their meters read as live readings 22h old.
    fs.rmSync(path.join(home, ".codecast", "cc-accounts", "b.json"));
    const calls = { tokenPosts: [] as string[], usage: [] as string[] };
    const res = await refreshUsageSnapshots({ now: NOW, fetchImpl: dualFetch(calls) });
    expect(res.expired).toEqual(["b"]);
    expect(readIndex().profiles.b.login_expired_at).toBe(NOW);
    expect(calls.usage.sort()).toEqual(["at-active", "at-c-rotated"]);
  });

  it("minIntervalMs 0 (the refresh button) re-probes every account at once", async () => {
    await refreshUsageSnapshots({ now: NOW, fetchImpl: dualFetch({ tokenPosts: [], usage: [] }) });
    const calls = { tokenPosts: [] as string[], usage: [] as string[] };
    await refreshUsageSnapshots({ now: NOW + 5_000, minIntervalMs: 0, fetchImpl: dualFetch(calls) });
    expect(calls.usage.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Per-profile credential stores (the per-session account)
// ---------------------------------------------------------------------------

describe("per-profile credential stores (sandboxed $HOME, file store)", () => {
  let home: string;
  let sandbox: IsolatedCodecastDir;
  const savedEnv: Record<string, string | undefined> = {};
  const credFor = (token: string, expiresAt: number, refreshExpiresAt?: number) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        refreshToken: `rt-${token}`,
        expiresAt,
        ...(refreshExpiresAt ? { refreshTokenExpiresAt: refreshExpiresAt } : {}),
        scopes: ["user:inference", "user:profile"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      },
    });
  const login = (token: string, uuid: string, email: string) => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), credFor(token, Date.now() + 3_600_000));
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: email } }),
    );
    invalidateAccountsCache();
  };
  const storeFile = (name: string) => path.join(profileStoreDir(name), ".credentials.json");

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-store-test-"));
    sandbox = isolateCodecastDir("cc-store-dir-");
    for (const k of ["HOME", "PATH", "CC_ACCOUNTS_FORCE_FILE"]) savedEnv[k] = process.env[k];
    process.env.HOME = home;
    process.env.PATH = path.join(home, "empty-path");
    process.env.CC_ACCOUNTS_FORCE_FILE = "1";
    invalidateAccountsCache();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    sandbox.restore();
    fs.rmSync(home, { recursive: true, force: true });
    invalidateAccountsCache();
  });

  it("names the store the way Claude Code does: an NFC-normalized absolute dir, hashed into the keychain service", () => {
    const dir = profileStoreDir("work");
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir).toBe(path.join(sandbox.dir, "cc-store", "work"));
    // sha256("/tmp/x")[:8] — the same derivation the CLI binary applies.
    expect(profileStoreKeychainService("/tmp/x")).toBe("Claude Code-credentials-2e56aa36");
    expect(profileStoreKeychainService("/tmp/x")).toBe(profileStoreKeychainService("/tmp/x".normalize("NFD")));
    expect(() => profileStoreDir("../x")).toThrow(CcAccountError);
    expect(accountLaunchInfo("../x")).toBeNull();
    expect(accountSourcePrefix("../x")).toBe("");
  });

  it("saving a profile fills its store and launch file; the launch prefix exports the store dir, never a secret", () => {
    login("at-work", "u-work", "work@x.com");
    saveProfile("work");
    const cred = JSON.parse(fs.readFileSync(storeFile("work"), "utf-8"));
    expect(cred.claudeAiOauth.accessToken).toBe("at-work");
    expect((fs.statSync(storeFile("work")).mode & 0o777).toString(8)).toBe("600");
    const launch = accountLaunchFilePath("work");
    expect(fs.readFileSync(launch, "utf-8")).toBe(`export CLAUDE_SECURESTORAGE_CONFIG_DIR='${profileStoreDir("work")}'\n`);
    expect((fs.statSync(launch).mode & 0o777).toString(8)).toBe("600");
    const info = accountLaunchInfo("work")!;
    expect(info.file).toBe(launch);
    expect(info.expires_at).toBeGreaterThan(Date.now() + 300 * 24 * 3600_000);
    // "work" IS the machine's login: a session pinned to it runs on the keychain.
    expect(accountSourcePrefix("work")).toBe("export CODECAST_CC_ACCOUNT=work; ");
    // Once another account is the login, "work" is dormant and its store carries the session.
    login("at-other", "u-other", "other@x.com");
    saveProfile("other");
    expect(accountSourcePrefix("work")).toBe(`. ${launch} 2>/dev/null || true; export CODECAST_CC_ACCOUNT=work; `);
    expect(accountSourcePrefix("work")).not.toContain("at-work");
    expect(accountSourcePrefix(undefined)).toBe("");
  });

  it("falls back to the keychain with a warning when a dormant profile has no launch credential", () => {
    login("at-a", "u-a", "a@x.com");
    saveProfile("a");
    login("at-b", "u-b", "b@x.com");
    deleteProfileStore("a");
    const warnings: string[] = [];
    expect(accountSourcePrefix("a", (m) => warnings.push(m))).toBe("");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("sign into it again");
    // ensureProfileStore repairs it offline from the snapshot.
    expect(ensureProfileStore("a")).toBe("provisioned");
    expect(ensureProfileStore("a")).toBe("ready");
    expect(accountSourcePrefix("a", (m) => warnings.push(m))).toContain("CODECAST_CC_ACCOUNT=a");
    expect(warnings).toHaveLength(1);
  });

  it("a login the endpoint refused has no launch credential until a person signs in again", () => {
    login("at-a", "u-a", "a@x.com");
    saveProfile("a");
    login("at-b", "u-b", "b@x.com");
    const indexPath = path.join(sandbox.dir, "cc-accounts.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    index.profiles.a.login_expired_at = Date.now();
    fs.writeFileSync(indexPath, JSON.stringify(index));
    invalidateAccountsCache();
    expect(ensureProfileStore("a")).toBe("login_expired");
    expect(accountLaunchInfo("a")).toBeNull();
    expect(accountSourcePrefix("a")).toBe("");
    const payload = getAccountsHeartbeatPayload()!;
    const row = payload.profiles.find((p) => p.name === "a")!;
    expect(row.token).toBeUndefined();
    expect(row.login_expired_at).toBeDefined();
  });

  it("reads take the store's pair when a session rotated it, and absorb writes it back into the snapshot", async () => {
    login("at-a", "u-a", "a@x.com");
    saveProfile("a");
    login("at-b", "u-b", "b@x.com");
    // A live claude on a's store rotated the grant.
    const rotated = credFor("at-a2", Date.now() + 8 * 3600_000);
    fs.writeFileSync(storeFile("a"), rotated);
    expect(credentialIsFresher(rotated, credFor("at-a", Date.now() + 3_600_000))).toBe(true);
    expect(credentialIsFresher(credFor("at-a", Date.now() + 3_600_000), rotated)).toBe(false);
    // useProfile reads through the overlay: the keychain gets the rotated pair.
    useProfile("a");
    expect(JSON.parse(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf-8")).claudeAiOauth.accessToken).toBe("at-a2");
    // The snapshot itself still carried the old pair until absorbed.
    const snapshotPath = path.join(sandbox.dir, "cc-accounts", "a.json");
    expect(JSON.parse(fs.readFileSync(snapshotPath, "utf-8")).credentials.claudeAiOauth.accessToken).toBe("at-a");
    expect(await absorbProfileStore("a")).toBe(true);
    expect(JSON.parse(fs.readFileSync(snapshotPath, "utf-8")).credentials.claudeAiOauth.accessToken).toBe("at-a2");
    expect(await absorbProfileStore("a")).toBe(false);
  });

  it("deleting a profile removes its store and launch file", () => {
    login("at-a", "u-a", "a@x.com");
    saveProfile("a");
    login("at-b", "u-b", "b@x.com");
    expect(fs.existsSync(storeFile("a"))).toBe(true);
    deleteProfile("a");
    expect(fs.existsSync(profileStoreDir("a"))).toBe(false);
    expect(fs.existsSync(accountLaunchFilePath("a"))).toBe(false);
    expect(accountLaunchInfo("a")).toBeNull();
  });

  it("a logged-out stub never reaches a store", () => {
    login("at-a", "u-a", "a@x.com");
    saveProfile("a");
    login("at-b", "u-b", "b@x.com");
    deleteProfileStore("a");
    const snapshotPath = path.join(sandbox.dir, "cc-accounts", "a.json");
    const snap = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
    snap.credentials.claudeAiOauth.accessToken = "";
    snap.credentials.claudeAiOauth.refreshToken = "";
    fs.writeFileSync(snapshotPath, JSON.stringify(snap));
    expect(ensureProfileStore("a")).toBe("unusable");
    expect(fs.existsSync(storeFile("a"))).toBe(false);
  });

  it("adopts a browser sign-in only when it is the profile's own account; a stranger's login is put back", async () => {
    login("at-a", "u-a", "a@x.com");
    saveProfile("a");
    login("at-b", "u-b", "b@x.com");
    const indexPath = path.join(sandbox.dir, "cc-accounts.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    index.profiles.a.login_expired_at = Date.now();
    fs.writeFileSync(indexPath, JSON.stringify(index));
    invalidateAccountsCache();
    // The browser signed into someone else: refused, store restored.
    fs.writeFileSync(storeFile("a"), credFor("at-stranger", Date.now() + 3_600_000));
    const strangerFetch = (async () =>
      new Response(JSON.stringify({ account: { uuid: "u-stranger", email: "s@x.com" } }), { status: 200 })) as unknown as typeof fetch;
    await expect(adoptProfileStoreCredential("a", { fetchImpl: strangerFetch })).rejects.toThrow(/signed into s@x.com, not a@x.com/);
    expect(fs.existsSync(storeFile("a"))).toBe(false);
    expect(accountLaunchInfo("a")).toBeNull();
    fs.mkdirSync(profileStoreDir("a"), { recursive: true });
    // The right account: adopted, login-expired mark cleared, launchable again.
    fs.writeFileSync(storeFile("a"), credFor("at-a-fresh", Date.now() + 3_600_000));
    const ownFetch = (async () =>
      new Response(JSON.stringify({ account: { uuid: "u-a", email: "a@x.com" } }), { status: 200 })) as unknown as typeof fetch;
    expect(await adoptProfileStoreCredential("a", { fetchImpl: ownFetch })).toEqual({ uuid: "u-a", email: "a@x.com" });
    const snapshotPath = path.join(sandbox.dir, "cc-accounts", "a.json");
    expect(JSON.parse(fs.readFileSync(snapshotPath, "utf-8")).credentials.claudeAiOauth.accessToken).toBe("at-a-fresh");
    expect(JSON.parse(fs.readFileSync(indexPath, "utf-8")).profiles.a.login_expired_at).toBeUndefined();
    expect(accountLaunchInfo("a")).not.toBeNull();
  });

  it("probes support once per binary: an empty store must report no login", async () => {
    const calls: Array<{ bin: string; args: string[]; dir: string | undefined }> = [];
    const exec = async (bin: string, args: string[], env: NodeJS.ProcessEnv) => {
      calls.push({ bin, args, dir: env.CLAUDE_SECURESTORAGE_CONFIG_DIR });
      return JSON.stringify({ loggedIn: calls.length === 1 ? false : true });
    };
    const bin = path.join(home, "claude");
    fs.writeFileSync(bin, "#!/bin/sh\n");
    expect(await probeSecureStorageSupport(bin, { execImpl: exec })).toBe(true);
    expect(calls[0].args).toEqual(["auth", "status", "--json"]);
    expect(calls[0].dir).toBeDefined();
    expect(fs.existsSync(calls[0].dir!)).toBe(false); // probe dir cleaned up
    // Cached: the same binary is not asked twice.
    expect(await probeSecureStorageSupport(bin, { execImpl: exec })).toBe(true);
    expect(calls).toHaveLength(1);
    // A changed binary is asked again — and this one still sees the login.
    fs.writeFileSync(bin, "#!/bin/sh\n# v2\n");
    expect(await probeSecureStorageSupport(bin, { execImpl: exec })).toBe(false);
    expect(calls).toHaveLength(2);
  });
});

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

// ---------------------------------------------------------------------------
// Usage poll backoff (ct-49527)
// ---------------------------------------------------------------------------
// The poll used to retry on the next five-minute tick no matter what the
// endpoint said, so a 429's Retry-After was ignored and an outage cost one
// request per account every five minutes for as long as it lasted.

describe("parseRetryAfter", () => {
  const NOW = 1_781_000_000_000;

  it("reads delta-seconds", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120_000);
    expect(parseRetryAfter("  90 ", NOW)).toBe(90_000);
  });

  it("reads an HTTP date as the wait from now", () => {
    expect(parseRetryAfter(new Date(NOW + 300_000).toUTCString(), NOW)).toBe(300_000);
  });

  it("ignores a header that names no future wait", () => {
    for (const h of [null, undefined, "", "   ", "soon", "0", "-5", new Date(NOW - 60_000).toUTCString()]) {
      expect(parseRetryAfter(h, NOW)).toBeUndefined();
    }
  });

  it("caps at 24h so a corrupt header can't freeze the meters", () => {
    expect(parseRetryAfter("999999999", NOW)).toBe(24 * 60 * 60 * 1000);
    expect(parseRetryAfter(new Date(NOW + 400 * 86_400_000).toUTCString(), NOW)).toBe(24 * 60 * 60 * 1000);
  });
});

describe("refreshUsageSnapshots backoff (isolated CODECAST_DIR, injected fetch)", () => {
  const NOW = 1_781_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  let home: string;
  let sandbox: IsolatedCodecastDir;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-backoff-test-"));
    sandbox = isolateCodecastDir("cc-backoff-dir-");
    for (const k of ["HOME", "PATH", "CC_ACCOUNTS_FORCE_FILE"]) savedEnv[k] = process.env[k];
    process.env.HOME = home;
    process.env.PATH = path.join(home, "empty-path");
    process.env.CC_ACCOUNTS_FORCE_FILE = "1";
    // One account: the machine's active login, with a credential live enough to
    // probe. No saved profiles, so each pass makes exactly one usage request.
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "at-active", refreshToken: "rt", expiresAt: NOW + 8 * 3600_000, subscriptionType: "max" },
      }),
    );
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "uuid-a", emailAddress: "a@x.com" } }),
    );
    invalidateAccountsCache();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    sandbox.restore();
    fs.rmSync(home, { recursive: true, force: true });
    invalidateAccountsCache();
  });

  /** A usage endpoint that answers `replies` in order, repeating the last. */
  const server = (...replies: Array<number | { status: number; retryAfter?: string }>) => {
    let served = 0;
    const fetchImpl = (async () => {
      const raw = replies[Math.min(served, replies.length - 1)];
      served++;
      const r = typeof raw === "number" ? { status: raw, retryAfter: undefined } : raw;
      if (r.status === 200) {
        return new Response(JSON.stringify({ limits: [{ kind: "session", percent: 12 }] }), { status: 200 });
      }
      return new Response("refused", {
        status: r.status,
        headers: r.retryAfter ? { "Retry-After": r.retryAfter } : {},
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, served: () => served };
  };

  const retryState = () => readUsageCache().retries?.["uuid-a"];

  it("holds the poll off for the seconds a 429 named, then probes again", async () => {
    const s = server({ status: 429, retryAfter: "120" }, 200);
    const first = await refreshUsageSnapshots({ now: NOW, fetchImpl: s.fetchImpl });
    expect(first.failed).toEqual([{ name: "active", reason: "usage endpoint 429" }]);
    expect(retryState()).toMatchObject({ retry_at: NOW + 120_000, failures: 1, status: 429, retry_after: true });

    // Inside the window the account is skipped without a request.
    const held = await refreshUsageSnapshots({ now: NOW + 119_000, fetchImpl: s.fetchImpl });
    expect(held.skipped).toEqual(["active"]);
    expect(s.served()).toBe(1);

    // At the named time it is asked again, and success clears the state.
    const after = await refreshUsageSnapshots({ now: NOW + 120_000, fetchImpl: s.fetchImpl });
    expect(after.probed).toEqual(["active"]);
    expect(retryState()).toBeUndefined();
    expect(readUsageCache().accounts["uuid-a"]?.session?.percent).toBe(12);
  });

  it("reads a 429's Retry-After given as an HTTP date", async () => {
    const s = server({ status: 429, retryAfter: new Date(NOW + 45 * 60_000).toUTCString() });
    await refreshUsageSnapshots({ now: NOW, fetchImpl: s.fetchImpl });
    expect(retryState()).toMatchObject({ retry_at: NOW + 45 * 60_000, retry_after: true });
  });

  it("caps a preposterous Retry-After at 24h", async () => {
    const s = server({ status: 429, retryAfter: "999999999" });
    await refreshUsageSnapshots({ now: NOW, fetchImpl: s.fetchImpl });
    expect(retryState()?.retry_at).toBe(NOW + DAY);
  });

  it("falls back to its own backoff for a 429 with no usable header", async () => {
    const s = server({ status: 429, retryAfter: "whenever" });
    await refreshUsageSnapshots({ now: NOW, fetchImpl: s.fetchImpl });
    expect(retryState()).toMatchObject({ retry_at: NOW + 30_000, status: 429 });
    expect(retryState()?.retry_after).toBeUndefined();
  });

  it("doubles the wait on repeated 500s and caps it at 15 minutes", async () => {
    const s = server(500);
    const waits: number[] = [];
    let now = NOW;
    for (let i = 0; i < 7; i++) {
      const res = await refreshUsageSnapshots({ now, fetchImpl: s.fetchImpl });
      expect(res.failed).toHaveLength(1);
      const state = retryState()!;
      waits.push(state.retry_at - now);
      now = state.retry_at;
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
    expect(s.served()).toBe(7);
    expect(retryState()).toMatchObject({ failures: 7, reason: "usage endpoint 500" });
  });

  it("keeps the last good snapshot through failures and resets the streak on recovery", async () => {
    const ok = server(200);
    await refreshUsageSnapshots({ now: NOW, fetchImpl: ok.fetchImpl });
    const good = readUsageCache().accounts["uuid-a"];
    expect(good?.fetched_at).toBe(NOW);

    const bad = server(503);
    let now = NOW + 10 * 60_000;
    for (let i = 0; i < 3; i++) {
      await refreshUsageSnapshots({ now, fetchImpl: bad.fetchImpl });
      now = retryState()!.retry_at;
    }
    expect(retryState()?.failures).toBe(3);
    // Why: a meter that flapped to empty on a transient failure would read as
    // headroom, and auto-switch would send sessions to a spent account.
    expect(readUsageCache().accounts["uuid-a"]).toEqual(good!);

    const back = server(200, 500);
    await refreshUsageSnapshots({ now, fetchImpl: back.fetchImpl });
    expect(retryState()).toBeUndefined();
    // The next failure starts the ladder over rather than resuming at 8x.
    await refreshUsageSnapshots({ now: now + 10 * 60_000, fetchImpl: back.fetchImpl });
    expect(retryState()).toMatchObject({ failures: 1, retry_at: now + 10 * 60_000 + 30_000 });
  });

  it("lets a human refresh through the backoff", async () => {
    const s = server({ status: 429, retryAfter: "3600" }, 200);
    await refreshUsageSnapshots({ now: NOW, fetchImpl: s.fetchImpl });
    // minIntervalMs 0 is the web's refresh button, not the timer.
    const forced = await refreshUsageSnapshots({ now: NOW + 1000, minIntervalMs: 0, fetchImpl: s.fetchImpl });
    expect(forced.probed).toEqual(["active"]);
    expect(s.served()).toBe(2);
  });
});

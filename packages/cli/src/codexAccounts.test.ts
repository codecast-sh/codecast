import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  decodeCodexAuth,
  saveCodexProfile,
  autoSaveActiveCodexProfile,
  migrateLegacyCodexProfileNames,
  resnapshotIfActiveCodexFresher,
  refreshCodexUsageSnapshots,
  activeCodexProfileName,
  getCodexAccountsHeartbeatPayload,
  invalidateCodexAccountsCache,
  readProfileIndex,
  readUsageCache,
  profileDir,
  CodexAccountError,
} from "./codexAccounts";
import { CodexUsageHttpError } from "./codexBackendUsage";

// The ChatGPT-backend supplement must never leave the machine in a unit test:
// every refresh below hands it an explicit stub. `noBackend` is the default one.
const noBackend = async () => null;

const NOW = Date.parse("2026-07-31T12:00:00Z");

function fakeIdToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.sig`;
}

function authJson(opts: { email?: string; accountId?: string; plan?: string; lastRefresh?: string; tokens?: boolean } = {}): string {
  const { email = "ashot@almostcandid.com", accountId = "acct-1", plan = "pro", lastRefresh = "2026-07-30T00:00:00Z", tokens = true } = opts;
  return JSON.stringify({
    auth_mode: tokens ? "chatgpt" : "apikey",
    OPENAI_API_KEY: tokens ? null : "sk-test",
    tokens: tokens
      ? {
          id_token: fakeIdToken({ email, "https://api.openai.com/auth": { chatgpt_plan_type: plan } }),
          access_token: "at-1",
          refresh_token: "rt-1",
          account_id: accountId,
        }
      : undefined,
    last_refresh: lastRefresh,
  });
}

// camelCase account/rateLimits/read result (the app-server wire shape).
function rpcResult(weeklyPercent: number, plan = "pro"): any {
  return {
    rateLimits: {
      limitId: "codex",
      planType: plan,
      primary: { usedPercent: weeklyPercent, windowDurationMins: 10080, resetsAt: 1786011679 },
    },
    rateLimitResetCredits: { availableCount: 1 },
  };
}

// A complete app-server reading: both windows, plan type, and a credit.
function fullRpcResult(): any {
  return {
    rateLimits: {
      limitId: "codex",
      planType: "pro",
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1786011679 },
      secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1786443679 },
    },
    rateLimitResetCredits: { availableCount: 1 },
  };
}

describe("codexAccounts", () => {
  let tmp: string;
  const origEnv: Record<string, string | undefined> = {};

  function writeActiveAuth(content: string) {
    const dir = path.join(tmp, "codex");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "auth.json"), content);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-accounts-test-"));
    for (const k of ["CODECAST_CODEX_HOME", "CODECAST_DIR"]) origEnv[k] = process.env[k];
    process.env.CODECAST_CODEX_HOME = path.join(tmp, "codex");
    process.env.CODECAST_DIR = path.join(tmp, "codecast");
    invalidateCodexAccountsCache();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("decodeCodexAuth", () => {
    it("extracts email, plan, account id, and last_refresh", () => {
      const s = decodeCodexAuth(authJson());
      expect(s.email).toBe("ashot@almostcandid.com");
      expect(s.plan).toBe("pro");
      expect(s.account_id).toBe("acct-1");
      expect(s.last_refresh).toBe(Date.parse("2026-07-30T00:00:00Z"));
      expect(s.usable).toBe(true);
    });

    it("marks API-key-only and malformed blobs unusable", () => {
      expect(decodeCodexAuth(authJson({ tokens: false })).usable).toBe(false);
      expect(decodeCodexAuth("not json").usable).toBe(false);
      expect(decodeCodexAuth(null).usable).toBe(false);
    });
  });

  describe("profiles", () => {
    it("saveCodexProfile snapshots auth.json + index metadata", () => {
      writeActiveAuth(authJson());
      const saved = saveCodexProfile("almostcandid");
      expect(saved.email).toBe("ashot@almostcandid.com");
      expect(saved.plan).toBe("pro");
      const stored = fs.readFileSync(path.join(profileDir("almostcandid"), "auth.json"), "utf-8");
      expect(JSON.parse(stored).tokens.account_id).toBe("acct-1");
      expect(readProfileIndex().profiles.almostcandid.account_id).toBe("acct-1");
    });

    it("refuses to save without a usable login", () => {
      writeActiveAuth(authJson({ tokens: false }));
      expect(() => saveCodexProfile("nope")).toThrow(CodexAccountError);
    });

    it("auto-save enrolls once, derives the local-part name, then no-ops", () => {
      writeActiveAuth(authJson());
      expect(autoSaveActiveCodexProfile()?.name).toBe("ashot");
      expect(autoSaveActiveCodexProfile()).toBeNull();
    });

    it("migrates legacy domain-derived names, moving the snapshot dir", () => {
      writeActiveAuth(authJson());
      saveCodexProfile("almostcandid"); // old auto-derived name for ashot@almostcandid.com
      expect(migrateLegacyCodexProfileNames()).toEqual([{ from: "almostcandid", to: "ashot" }]);
      expect(Object.keys(readProfileIndex().profiles)).toEqual(["ashot"]);
      expect(fs.existsSync(path.join(profileDir("ashot"), "auth.json"))).toBe(true);
      expect(fs.existsSync(profileDir("almostcandid"))).toBe(false);
      // Idempotent, and hand-picked names stay.
      expect(migrateLegacyCodexProfileNames()).toEqual([]);
    });

    it("resnapshot copies the live auth only when it rotated past the stored one", () => {
      writeActiveAuth(authJson({ lastRefresh: "2026-07-30T00:00:00Z" }));
      saveCodexProfile("almostcandid");
      expect(resnapshotIfActiveCodexFresher()).toBeNull(); // in step
      writeActiveAuth(authJson({ lastRefresh: "2026-07-31T00:00:00Z" }));
      expect(resnapshotIfActiveCodexFresher()).toBe("almostcandid");
      const stored = decodeCodexAuth(fs.readFileSync(path.join(profileDir("almostcandid"), "auth.json"), "utf-8"));
      expect(stored.last_refresh).toBe(Date.parse("2026-07-31T00:00:00Z"));
    });
  });

  describe("refreshCodexUsageSnapshots", () => {
    it("probes the active account via the real home, dormant via snapshot dirs, and skips the covered profile", async () => {
      // Dormant profile for a second account.
      writeActiveAuth(authJson({ email: "ashot@footage.com", accountId: "acct-2", plan: "plus" }));
      saveCodexProfile("footage");
      // Active login is a different account (auto-enrolled by the refresh).
      writeActiveAuth(authJson());
      const homes: (string | undefined)[] = [];
      const res = await refreshCodexUsageSnapshots({
        now: NOW,
        backendFetch: noBackend,
        rpcFetch: async (home) => {
          homes.push(home);
          return rpcResult(home === profileDir("footage") ? 40 : 15);
        },
      });
      expect(res.probed.sort()).toEqual(["active", "footage"]);
      // Active probed via the REAL codex home (never a snapshot copy).
      expect(homes).toContain(process.env.CODECAST_CODEX_HOME);
      expect(homes).toContain(profileDir("footage"));
      expect(homes).toHaveLength(2);
      const cache = readUsageCache();
      expect(cache.accounts["acct-1"].weekly?.percent).toBe(15);
      expect(cache.accounts["acct-2"].weekly?.percent).toBe(40);
      // The refresh auto-enrolled the active login as a profile.
      expect(readProfileIndex().profiles.ashot.account_id).toBe("acct-1");
    });

    it("throttles per-account probes within minIntervalMs", async () => {
      writeActiveAuth(authJson());
      let calls = 0;
      const probeOnce = () =>
        refreshCodexUsageSnapshots({
          now: NOW,
          backendFetch: noBackend,
          rpcFetch: async () => (calls++, rpcResult(10)),
        });
      await probeOnce();
      const second = await refreshCodexUsageSnapshots({
        now: NOW + 60_000,
        backendFetch: noBackend,
        rpcFetch: async () => (calls++, rpcResult(10)),
      });
      expect(calls).toBe(1);
      expect(second.skipped).toContain("active");
    });

    it("reports a failure (and keeps the old snapshot) when a probe returns nothing", async () => {
      writeActiveAuth(authJson());
      await refreshCodexUsageSnapshots({ now: NOW, backendFetch: noBackend, rpcFetch: async () => rpcResult(10) });
      const res = await refreshCodexUsageSnapshots({
        now: NOW + 10 * 60_000,
        backendFetch: noBackend,
        rpcFetch: async () => null,
      });
      expect(res.failed.map((f) => f.name)).toContain("active");
      expect(readUsageCache().accounts["acct-1"].weekly?.percent).toBe(10);
    });
  });

  describe("ChatGPT-backend supplement", () => {
    const backendSnap = (overrides: Record<string, any> = {}) => ({
      fetched_at: NOW,
      plan_type: "plus",
      session: { percent: 37 },
      weekly: { percent: 99 },
      reset_credits: { available: 2 },
      ...overrides,
    });

    it("fills the session window the app-server left blank, and nothing it filled", async () => {
      writeActiveAuth(authJson());
      const homes: string[] = [];
      await refreshCodexUsageSnapshots({
        now: NOW,
        rpcFetch: async () => rpcResult(15, "pro"), // weekly only, no session
        backendFetch: async (home) => {
          homes.push(home);
          return backendSnap();
        },
      });
      const snap = readUsageCache().accounts["acct-1"];
      expect(snap.session).toEqual({ percent: 37 });
      // The app-server spoke for these; the backend does not override them.
      expect(snap.weekly?.percent).toBe(15);
      expect(snap.plan_type).toBe("pro");
      expect(snap.reset_credits).toEqual({ available: 1 });
      // Read through the account's own home, never a shared one.
      expect(homes).toEqual([process.env.CODECAST_CODEX_HOME!]);
    });

    it("reads each dormant account through its own snapshot dir", async () => {
      writeActiveAuth(authJson({ email: "ashot@footage.com", accountId: "acct-2", plan: "plus" }));
      saveCodexProfile("footage");
      writeActiveAuth(authJson());
      const homes: string[] = [];
      await refreshCodexUsageSnapshots({
        now: NOW,
        rpcFetch: async () => rpcResult(15),
        backendFetch: async (home) => {
          homes.push(home);
          return backendSnap();
        },
      });
      expect(homes.sort()).toEqual([process.env.CODECAST_CODEX_HOME!, profileDir("footage")].sort());
    });

    it("carries the account when the app-server answered nothing at all", async () => {
      writeActiveAuth(authJson());
      const res = await refreshCodexUsageSnapshots({
        now: NOW,
        rpcFetch: async () => null,
        backendFetch: async () => backendSnap(),
      });
      expect(res.probed).toContain("active");
      const snap = readUsageCache().accounts["acct-1"];
      expect(snap.session).toEqual({ percent: 37 });
      expect(snap.plan_type).toBe("plus");
    });

    it("skips the backend entirely when the app-server left no holes", async () => {
      writeActiveAuth(authJson());
      let called = 0;
      await refreshCodexUsageSnapshots({
        now: NOW,
        rpcFetch: async () => fullRpcResult(),
        backendFetch: async () => (called++, backendSnap()),
      });
      expect(called).toBe(0);
    });

    it("does not treat an account with no reset credits as a hole", async () => {
      // Having no credit is the ordinary state, so it must not send every
      // account to the endpoint on every cycle.
      writeActiveAuth(authJson());
      let called = 0;
      const noCredits = fullRpcResult();
      delete noCredits.rateLimitResetCredits;
      await refreshCodexUsageSnapshots({
        now: NOW,
        rpcFetch: async () => noCredits,
        backendFetch: async () => (called++, backendSnap()),
      });
      expect(called).toBe(0);
      expect(readUsageCache().accounts["acct-1"].session?.percent).toBe(20);
    });

    it("rests for an hour once the backend agrees the plan has no session window", async () => {
      // A live Pro account reports the weekly bucket from BOTH sources and no
      // session window from either. Without this, the hole would send every
      // tick to the endpoint for as long as the account exists.
      writeActiveAuth(authJson());
      let calls = 0;
      const weeklyOnly = async () => {
        calls++;
        return { fetched_at: NOW, plan_type: "pro", weekly: { percent: 3 } };
      };
      await refreshCodexUsageSnapshots({ now: NOW, rpcFetch: async () => rpcResult(3), backendFetch: weeklyOnly });
      expect(calls).toBe(1);
      expect(readUsageCache().backend_retries!["acct-1"]).toMatchObject({ failures: 0 });

      await refreshCodexUsageSnapshots({
        now: NOW + 30 * 60_000,
        minIntervalMs: 0,
        rpcFetch: async () => rpcResult(3),
        backendFetch: weeklyOnly,
      });
      expect(calls).toBe(1);

      // Past the hour it asks again — a plan can gain a window.
      await refreshCodexUsageSnapshots({
        now: NOW + 61 * 60_000,
        minIntervalMs: 0,
        rpcFetch: async () => rpcResult(3),
        backendFetch: async () => (calls++, backendSnap()),
      });
      expect(calls).toBe(2);
      expect(readUsageCache().accounts["acct-1"].session).toEqual({ percent: 37 });
      expect(readUsageCache().backend_retries).toEqual({});
    });

    it("backs off on the wait a 429 named, and keeps the app-server reading", async () => {
      writeActiveAuth(authJson());
      let calls = 0;
      const refuse = async () => {
        calls++;
        throw new CodexUsageHttpError(429, 120_000);
      };
      const first = await refreshCodexUsageSnapshots({ now: NOW, rpcFetch: async () => rpcResult(15), backendFetch: refuse });
      expect(first.backend_failed.map((f) => f.name)).toEqual(["active"]);
      expect(first.probed).toContain("active"); // the meters still updated
      expect(readUsageCache().accounts["acct-1"].weekly?.percent).toBe(15);

      // Inside the named wait: not asked again.
      const during = await refreshCodexUsageSnapshots({
        now: NOW + 60_000,
        minIntervalMs: 0,
        rpcFetch: async () => rpcResult(16),
        backendFetch: refuse,
      });
      expect(calls).toBe(1);
      expect(during.backend_deferred).toContain("active");

      // Past it: asked once more, and a success clears the record.
      const after = await refreshCodexUsageSnapshots({
        now: NOW + 130_000,
        minIntervalMs: 0,
        rpcFetch: async () => rpcResult(17),
        backendFetch: async () => backendSnap(),
      });
      expect(after.backend_deferred).toEqual([]);
      expect(readUsageCache().backend_retries).toEqual({});
    });

    it("doubles its own wait when the endpoint names none", async () => {
      writeActiveAuth(authJson());
      const refuse = async () => {
        throw new CodexUsageHttpError(500);
      };
      await refreshCodexUsageSnapshots({ now: NOW, rpcFetch: async () => rpcResult(15), backendFetch: refuse });
      expect(readUsageCache().backend_retries!["acct-1"].retry_at).toBe(NOW + 30_000);
      await refreshCodexUsageSnapshots({
        now: NOW + 40_000,
        minIntervalMs: 0,
        rpcFetch: async () => rpcResult(15),
        backendFetch: refuse,
      });
      const state = readUsageCache().backend_retries!["acct-1"];
      expect(state.failures).toBe(2);
      expect(state.retry_at).toBe(NOW + 40_000 + 60_000);
      expect(state.status).toBe(500);
    });
  });

  describe("activeCodexProfileName", () => {
    it("names the profile covering the machine's current login", () => {
      writeActiveAuth(authJson());
      saveCodexProfile("ashot");
      expect(activeCodexProfileName()).toBe("ashot");
    });

    it("follows the login when the machine signs into another account", () => {
      writeActiveAuth(authJson());
      saveCodexProfile("ashot");
      writeActiveAuth(authJson({ email: "ashot@footage.com", accountId: "acct-2" }));
      saveCodexProfile("footage");
      expect(activeCodexProfileName()).toBe("footage");
    });

    it("names nothing for a login that is not enrolled, or not usable", () => {
      writeActiveAuth(authJson());
      expect(activeCodexProfileName()).toBeUndefined();
      writeActiveAuth(authJson({ tokens: false }));
      expect(activeCodexProfileName()).toBeUndefined();
    });
  });

  describe("getCodexAccountsHeartbeatPayload", () => {
    it("returns the Claude-inventory shape with plan as subscription and no plan_type inside usage", async () => {
      writeActiveAuth(authJson());
      await refreshCodexUsageSnapshots({
        now: NOW,
        backendFetch: noBackend,
        rpcFetch: async () => rpcResult(15, "pro"),
      });
      const payload = getCodexAccountsHeartbeatPayload()!;
      expect(payload.active_email).toBe("ashot@almostcandid.com");
      expect(payload.active_uuid).toBe("acct-1");
      expect(payload.profiles).toHaveLength(1);
      const p = payload.profiles[0];
      expect(p.name).toBe("ashot");
      expect(p.subscription).toBe("pro"); // RPC's live plan reading
      expect(p.usage?.weekly?.percent).toBe(15);
      expect(p.usage?.reset_credits).toEqual({ available: 1 });
      expect((p.usage as any)?.plan_type).toBeUndefined();
    });

    it("returns null when the machine has no codex state", () => {
      expect(getCodexAccountsHeartbeatPayload()).toBeNull();
    });
  });
});

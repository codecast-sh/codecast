import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  decodeCodexAuth,
  saveCodexProfile,
  autoSaveActiveCodexProfile,
  resnapshotIfActiveCodexFresher,
  refreshCodexUsageSnapshots,
  getCodexAccountsHeartbeatPayload,
  invalidateCodexAccountsCache,
  readProfileIndex,
  readUsageCache,
  profileDir,
  CodexAccountError,
} from "./codexAccounts";

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

    it("auto-save enrolls once, derives the org name, then no-ops", () => {
      writeActiveAuth(authJson());
      expect(autoSaveActiveCodexProfile()?.name).toBe("almostcandid");
      expect(autoSaveActiveCodexProfile()).toBeNull();
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
      expect(readProfileIndex().profiles.almostcandid.account_id).toBe("acct-1");
    });

    it("throttles per-account probes within minIntervalMs", async () => {
      writeActiveAuth(authJson());
      let calls = 0;
      const probeOnce = () =>
        refreshCodexUsageSnapshots({ now: NOW, rpcFetch: async () => (calls++, rpcResult(10)) });
      await probeOnce();
      const second = await refreshCodexUsageSnapshots({
        now: NOW + 60_000,
        rpcFetch: async () => (calls++, rpcResult(10)),
      });
      expect(calls).toBe(1);
      expect(second.skipped).toContain("active");
    });

    it("reports a failure (and keeps the old snapshot) when a probe returns nothing", async () => {
      writeActiveAuth(authJson());
      await refreshCodexUsageSnapshots({ now: NOW, rpcFetch: async () => rpcResult(10) });
      const res = await refreshCodexUsageSnapshots({
        now: NOW + 10 * 60_000,
        rpcFetch: async () => null,
      });
      expect(res.failed.map((f) => f.name)).toContain("active");
      expect(readUsageCache().accounts["acct-1"].weekly?.percent).toBe(10);
    });
  });

  describe("getCodexAccountsHeartbeatPayload", () => {
    it("returns the Claude-inventory shape with plan as subscription and no plan_type inside usage", async () => {
      writeActiveAuth(authJson());
      await refreshCodexUsageSnapshots({ now: NOW, rpcFetch: async () => rpcResult(15, "pro") });
      const payload = getCodexAccountsHeartbeatPayload()!;
      expect(payload.active_email).toBe("ashot@almostcandid.com");
      expect(payload.active_uuid).toBe("acct-1");
      expect(payload.profiles).toHaveLength(1);
      const p = payload.profiles[0];
      expect(p.name).toBe("almostcandid");
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

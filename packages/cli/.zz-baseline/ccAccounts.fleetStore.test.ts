import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  FLEET_GATE_ACCOUNT,
  FLEET_MIN_ACCESS_MS,
  argvOnLaunchAccount,
  fleetBearer,
  fleetLoginDead,
  maintainFleetStore,
  setLaunchProfile,
  fleetStoreDir,
  invalidateAccountsCache,
  launchAccountPrefix,
  launchProfileName,
  putFleetOn,
  readFleetState,
  listProfiles,
  writeAccountToken,
} from "./ccAccounts.js";
import { refreshUsageSnapshots } from "./ccUsagePoll.js";
import { fallbackProfiles } from "@codecast/shared/contracts";

// The fleet store (see "Fleet store" in ccAccounts.ts) against a sandboxed
// $HOME with the file-backed store, so nothing touches the real keychain.
const TOKEN = "sk-ant-oat01-" + "a".repeat(90);

describe("fleet store (sandboxed $HOME)", () => {
  let home: string;
  const savedEnv: Record<string, string | undefined> = {};
  const now = Date.now();

  const login = (accessToken: string, expiresAt: number) => ({
    claudeAiOauth: { accessToken, refreshToken: "refresh-secret", expiresAt, scopes: ["user:inference", "user:profile"], subscriptionType: "max" },
  });

  const save = (name: string, cred: unknown) =>
    fs.writeFileSync(path.join(home, ".codecast", "cc-accounts", `${name}.json`), JSON.stringify({ credentials: cred, oauthAccount: {}, saved_at: 1 }));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-fleet-test-"));
    for (const k of ["HOME", "PATH", "CC_ACCOUNTS_FORCE_FILE", "CODECAST_DIR", "CODECAST_CC_FLEET", "CODECAST_REMOTE_DEVICE"]) savedEnv[k] = process.env[k];
    process.env.HOME = home;
    process.env.PATH = path.join(home, "empty-path");
    process.env.CC_ACCOUNTS_FORCE_FILE = "1";
    delete process.env.CODECAST_DIR;
    delete process.env.CODECAST_CC_FLEET;
    process.env.CODECAST_REMOTE_DEVICE = "0";
    const cfg = path.join(home, ".codecast");
    fs.mkdirSync(path.join(cfg, "cc-accounts"), { recursive: true });
    fs.writeFileSync(path.join(cfg, "cc-accounts.json"), JSON.stringify({
      profiles: {
        tok: { email: "tok@x.com", uuid: "u-tok", tier: "default_claude_max_20x", subscription: "max", saved_at: 1 },
        live: { email: "live@x.com", uuid: "u-live", subscription: "max", saved_at: 1 },
        lapsing: { email: "lapsing@x.com", uuid: "u-lapsing", saved_at: 1 },
        dead: { email: "dead@x.com", uuid: "u-dead", saved_at: 1, login_expired_at: 1 },
      },
    }));
    save("live", login("access-live", now + 6 * 3_600_000));
    save("lapsing", login("access-lapsing", now + FLEET_MIN_ACCESS_MS / 2));
    save("dead", login("access-dead", now + 6 * 3_600_000));
    writeAccountToken("tok", TOKEN);
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

  it("carries a setup-token when there is one, else a live login's access token, never a refresh token", () => {
    const tok = fleetBearer("tok", null, now)!;
    expect(tok.via).toBe("token");
    expect(JSON.parse(tok.blob).claudeAiOauth.accessToken).toBe(TOKEN);

    const liveLogin = JSON.stringify(login("access-live", now + 6 * 3_600_000));
    const live = fleetBearer("live", liveLogin, now)!;
    expect(live.via).toBe("login");
    const oauth = JSON.parse(live.blob).claudeAiOauth;
    expect(oauth.accessToken).toBe("access-live");
    expect(oauth.refreshToken).toBeUndefined();

    expect(fleetBearer("lapsing", JSON.stringify(login("x", now + FLEET_MIN_ACCESS_MS / 2)), now)).toBeNull();
    expect(fleetBearer("dead", liveLogin, now)).toBeNull();
  });

  it("putting a profile on the store records it as the fleet, and sessions with no pin launch on the store", async () => {
    await putFleetOn("live", now);
    const stored = JSON.parse(fs.readFileSync(path.join(fleetStoreDir(), ".credentials.json"), "utf-8"));
    expect(stored.claudeAiOauth.accessToken).toBe("access-live");
    expect(stored.claudeAiOauth.refreshToken).toBeUndefined();
    expect(readFleetState()?.profile).toBe("live");
    expect(launchProfileName(now)).toBe("live");

    const fleet = launchAccountPrefix(undefined);
    expect(fleet.account).toBe(FLEET_GATE_ACCOUNT);
    expect(fleet.prefix).toContain("cc-fleet.env");
    expect(fs.readFileSync(path.join(home, ".codecast", "cc-fleet.env"), "utf-8")).toContain(fleetStoreDir());

    // A person's pin still sources that profile.
    const pinned = launchAccountPrefix("tok");
    expect(pinned.account).toBe("tok");
    expect(pinned.prefix).not.toContain("cc-fleet.env");

    await putFleetOn("tok", now);
    expect(JSON.parse(fs.readFileSync(path.join(fleetStoreDir(), ".credentials.json"), "utf-8")).claudeAiOauth.accessToken).toBe(TOKEN);
    expect(launchProfileName(now)).toBe("tok");
  });

  it("refuses a profile that can carry nothing, leaving the store as it was", async () => {
    await putFleetOn("tok", now);
    await expect(putFleetOn("dead", now)).rejects.toThrow();
    expect(readFleetState()?.profile).toBe("tok");
  });

  // ct-56748: a fleet left on a signed-out account fails every session launched
  // on it, and a run that dies on its first turn never parks for the server's
  // auth recovery to see. The tick moves the fleet to the account auto-switch
  // would pick, skipping any that cannot carry it either.
  it("moves the fleet off a dead account onto one that can carry it", async () => {
    setLaunchProfile("dead", undefined, now);
    const did = await maintainFleetStore(now);
    expect(did).toContain("cast accounts signin dead");
    // "lapsing" ranks first on equal (unknown) headroom but cannot carry; the
    // next candidate takes the fleet.
    expect(readFleetState()?.profile).toBe("live");
    expect(launchProfileName(now)).toBe("live");
  });

  // 2026-10-08: the fleet sat on an account whose organization had turned off
  // subscription OAuth. Its setup-token still minted a store, so the fleet
  // never moved, and every session launched on it answered "Your organization
  // has disabled Claude subscription access". The usage poll sees the 403,
  // stamps the account, and the next tick moves the fleet.
  it("moves the fleet off an account its organization refuses, setup-token or not", async () => {
    save("tok", login("access-tok", now + 6 * 3_600_000));
    await putFleetOn("tok", now);
    const refusal = JSON.stringify({ type: "error", error: { type: "permission_error", message: "OAuth authentication is currently not allowed for this organization.", details: { error_code: "oauth_not_allowed_for_organization" } } });
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      new Headers(init.headers).get("authorization") === "Bearer access-tok"
        ? new Response(refusal, { status: 403, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ five_hour: { utilization: 1 }, seven_day: { utilization: 1 } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const summary = await refreshUsageSnapshots({ fetchImpl, now, minIntervalMs: 0 });
    expect(summary.failed.map((f) => f.name)).toContain("tok");
    expect(fleetLoginDead("tok", null, now)).toBe(true);

    const did = await maintainFleetStore(now);
    expect(did).toContain(`"tok"'s organization refuses subscription access`);
    expect(readFleetState()?.profile).toBe("live");
    expect(fallbackProfiles(listProfiles().map((p) => ({ ...p, setup_token: { expires_at: now + 86_400_000 } })), undefined, now).map((p) => p.name)).not.toContain("tok");

    // A good probe later clears the stamp.
    const ok = (async () => new Response(JSON.stringify({ five_hour: { utilization: 1 }, seven_day: { utilization: 1 } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await refreshUsageSnapshots({ fetchImpl: ok, now: now + 1, minIntervalMs: 0 });
    expect(fleetLoginDead("tok", null, now)).toBe(false);
  });

  it("stays put on an account whose login is only about to lapse", async () => {
    // No refresh token, so the tick's refresh fails without reaching the network.
    const lapsingLogin = { claudeAiOauth: { accessToken: "access-lapsing", expiresAt: now + FLEET_MIN_ACCESS_MS / 2 } };
    fs.writeFileSync(path.join(home, ".codecast", "cc-accounts", "lapsing.json"), JSON.stringify({ credentials: lapsingLogin, oauthAccount: {}, saved_at: 1 }));
    setLaunchProfile("lapsing", undefined, now);
    const did = await maintainFleetStore(now);
    expect(did).toStartWith("cannot carry");
    expect(readFleetState()).toBeNull();
    expect(fleetLoginDead("lapsing", JSON.stringify(login("x", now + 1000)), now)).toBe(false);
  });

  it("reads a logged-out stub as dead, and a live setup-token as never dead", () => {
    const stub = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } });
    expect(fleetLoginDead("live", stub, now)).toBe(true);
    expect(fleetLoginDead("tok", stub, now)).toBe(false);
  });

  it("runs a shell-less launch on the fleet store", async () => {
    await putFleetOn("tok", now);
    const argv = argvOnLaunchAccount(["claude", "--print", "hi"]);
    expect(argv.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(argv[2]).toContain("cc-fleet.env");
    expect(argv.slice(-3)).toEqual(["claude", "--print", "hi"]);
  });

  it("is off on request: no pin launches as before", async () => {
    await putFleetOn("tok", now);
    process.env.CODECAST_CC_FLEET = "0";
    expect(launchAccountPrefix(undefined).account).not.toBe(FLEET_GATE_ACCOUNT);
  });
});

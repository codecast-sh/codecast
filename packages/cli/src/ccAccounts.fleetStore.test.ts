import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  FLEET_GATE_ACCOUNT,
  FLEET_MIN_ACCESS_MS,
  fleetBearer,
  fleetStoreDir,
  invalidateAccountsCache,
  launchAccountPrefix,
  launchProfileName,
  putFleetOn,
  readFleetState,
  writeAccountToken,
} from "./ccAccounts.js";

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
    const save = (name: string, cred: unknown) =>
      fs.writeFileSync(path.join(cfg, "cc-accounts", `${name}.json`), JSON.stringify({ credentials: cred, oauthAccount: {}, saved_at: 1 }));
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

  it("is off on request: no pin launches as before", async () => {
    await putFleetOn("tok", now);
    process.env.CODECAST_CC_FLEET = "0";
    expect(launchAccountPrefix(undefined).account).not.toBe(FLEET_GATE_ACCOUNT);
  });
});

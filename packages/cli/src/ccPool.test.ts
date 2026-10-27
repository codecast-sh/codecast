import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  accountTokenInfo,
  fleetBearer,
  fleetStoreDir,
  getAccountsHeartbeatPayload,
  invalidateAccountsCache,
  putFleetOn,
  readAccountTokenValue,
  readFleetState,
  readProfileIndex,
  switchModeFor,
  writeAccountToken,
} from "./ccAccounts.js";
import { getProviderKeyPublicKey } from "./providerKeyCrypto.js";
import { accountSourcePrefix, launchAccountPrefix } from "./ccAccounts.js";
import { readPushableCredential } from "./remote/session-move.js";
import { installedPoolProfiles, runPoolPass, type PoolBackend, type PoolState } from "./ccPool.js";

// The pool's daemon pass, holder and drawer on two sandboxed machines (one
// $HOME each), joined by a fake backend that stores what the holder seals and
// hands it to the drawer: the real ECDH seal and open, the real profile files.

const TOKEN = "sk-ant-oat01-" + "p".repeat(90);
const NOW = Date.now();

describe("the shared account pool on two machines", () => {
  let holderHome: string;
  let drawerHome: string;
  const savedEnv: Record<string, string | undefined> = {};
  const use = (home: string) => {
    process.env.HOME = home;
    invalidateAccountsCache();
  };
  const cfg = (home: string) => path.join(home, ".codecast");

  beforeEach(() => {
    for (const k of ["HOME", "PATH", "CC_ACCOUNTS_FORCE_FILE", "CODECAST_DIR", "CODECAST_CC_FLEET", "CODECAST_REMOTE_DEVICE"]) savedEnv[k] = process.env[k];
    holderHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pool-holder-"));
    drawerHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pool-drawer-"));
    process.env.PATH = path.join(holderHome, "empty-path");
    process.env.CC_ACCOUNTS_FORCE_FILE = "1";
    delete process.env.CODECAST_DIR;
    delete process.env.CODECAST_CC_FLEET;
    process.env.CODECAST_REMOTE_DEVICE = "0";
    for (const home of [holderHome, drawerHome]) fs.mkdirSync(path.join(cfg(home), "cc-accounts"), { recursive: true });
    fs.writeFileSync(path.join(cfg(holderHome), "cc-accounts.json"), JSON.stringify({
      profiles: { claude4: { email: "Claude4@x.com", uuid: "u4", tier: "default_claude_max_20x", subscription: "max", saved_at: 1 } },
    }));
    fs.writeFileSync(path.join(cfg(drawerHome), "cc-accounts.json"), JSON.stringify({
      profiles: { jason: { email: "jason@x.com", uuid: "uj", saved_at: 1 } },
    }));
    use(holderHome);
    writeAccountToken("claude4", TOKEN);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(holderHome, { recursive: true, force: true });
    fs.rmSync(drawerHome, { recursive: true, force: true });
    invalidateAccountsCache();
  });

  /** The server's side, reduced to what the pass reads and writes. */
  function server() {
    const copies = new Map<string, { sealed: any; token_stored_at: number }>();
    let shared = true;
    const drawerKey = getProviderKeyPublicKey(cfg(drawerHome));
    const holder: PoolBackend = {
      state: async () => ({
        seal: shared ? [{ share_id: "s1", email: "claude4@x.com", targets: [{ device_id: "drawer", pubkey: drawerKey, token_stored_at: copies.get("drawer")?.token_stored_at ?? null }] }] : [],
        copies: [],
      }),
      store: async (_share, at, list) => { for (const c of list) copies.set(c.device_id, { sealed: c.sealed, token_stored_at: at }); },
    };
    const drawer: PoolBackend = {
      state: async (): Promise<PoolState> => ({
        seal: [],
        copies: shared && copies.has("drawer")
          ? [{ share_id: "s1", email: "claude4@x.com", name: "pool-claude4", contributor_name: "Ashot", tier: "default_claude_max_20x", subscription: "max", ...copies.get("drawer")! }]
          : [],
      }),
      store: async () => { throw new Error("a drawer stores nothing"); },
    };
    return { holder, drawer, copies, unshare: () => { shared = false; } };
  }

  it("seals the token for a teammate's machine, which keeps it as a token-only profile the fleet can run on", async () => {
    const s = server();
    use(holderHome);
    expect(await runPoolPass(s.holder, cfg(holderHome), NOW)).toEqual(["sealed claude4@x.com for 1 machine(s)"]);
    // The server only ever sees ciphertext.
    expect(JSON.stringify(s.copies.get("drawer"))).not.toContain(TOKEN);
    const storedAt = Math.floor(accountTokenInfo("claude4")!.stored_at);
    expect(s.copies.get("drawer")!.token_stored_at).toBe(storedAt);
    // A current copy is not sealed again.
    expect(await runPoolPass(s.holder, cfg(holderHome), NOW)).toEqual([]);

    use(drawerHome);
    expect(await runPoolPass(s.drawer, cfg(drawerHome), NOW)).toEqual(["added pool-claude4 (claude4@x.com, from Ashot)"]);
    expect(readAccountTokenValue("pool-claude4")).toBe(TOKEN);
    // The copy's lifetime is the token's, not the day it arrived.
    expect(Math.abs(accountTokenInfo("pool-claude4")!.stored_at - storedAt)).toBeLessThan(1000);
    expect(readProfileIndex().profiles["pool-claude4"]).toMatchObject({ email: "claude4@x.com", pool_share_id: "s1", pool_contributor: "Ashot", tier: "default_claude_max_20x" });
    expect(switchModeFor("pool-claude4", NOW)).toBe("token");
    expect(fleetBearer("pool-claude4", null, NOW)?.via).toBe("token");
    // The heartbeat names the share and sends no meter of its own.
    const row = getAccountsHeartbeatPayload()!.profiles.find((p) => p.name === "pool-claude4")!;
    expect(row).toMatchObject({ pool_share_id: "s1" });
    expect(row.usage).toBeUndefined();
    expect(row.setup_token).toBeDefined();
    // Nothing changes on the next pass.
    expect(await runPoolPass(s.drawer, cfg(drawerHome), NOW)).toEqual([]);
  });

  it("a pool copy carries sessions only through the fleet store, and never reaches this machine's hosts", async () => {
    const s = server();
    use(holderHome);
    await runPoolPass(s.holder, cfg(holderHome), NOW);
    use(drawerHome);
    await runPoolPass(s.drawer, cfg(drawerHome), NOW);
    // A pin cannot source the token into a process, where a take-back could not reach it.
    expect(accountSourcePrefix("pool-claude4")).toBe("");
    await putFleetOn("pool-claude4", NOW);
    expect(launchAccountPrefix(undefined).prefix).toContain("cc-fleet.env");
    // The fleet's bearer is the pool token, but it is not what goes to this machine's hosts.
    expect(readPushableCredential().cred ?? "").not.toContain(TOKEN);
  });

  it("taking the account back removes the copy and moves the fleet off it", async () => {
    const s = server();
    use(holderHome);
    await runPoolPass(s.holder, cfg(holderHome), NOW);
    use(drawerHome);
    await runPoolPass(s.drawer, cfg(drawerHome), NOW);
    await putFleetOn("pool-claude4", NOW);
    expect(readFleetState()?.profile).toBe("pool-claude4");

    s.unshare();
    const lines = await runPoolPass(s.drawer, cfg(drawerHome), NOW);
    expect(lines[0]).toStartWith("removed pool-claude4: no longer in the pool");
    expect(installedPoolProfiles().size).toBe(0);
    expect(readAccountTokenValue("pool-claude4")).toBeNull();
    expect(readProfileIndex().profiles["pool-claude4"]).toBeUndefined();
    // Nothing else here can carry the fleet, so the store is emptied rather
    // than left carrying an account this machine may no longer use.
    expect(lines[0]).toContain("emptied the fleet store");
    expect(readFleetState()).toBeNull();
    expect(fs.existsSync(path.join(fleetStoreDir(), ".credentials.json"))).toBe(false);
  });

  it("taking it back moves the fleet onto the machine's own account when one can carry it", async () => {
    const s = server();
    use(holderHome);
    await runPoolPass(s.holder, cfg(holderHome), NOW);
    use(drawerHome);
    writeAccountToken("jason", "sk-ant-oat01-" + "j".repeat(90));
    await runPoolPass(s.drawer, cfg(drawerHome), NOW);
    await putFleetOn("pool-claude4", NOW);
    s.unshare();
    const lines = await runPoolPass(s.drawer, cfg(drawerHome), NOW);
    expect(lines[0]).toContain('moved the fleet store on "jason"');
    expect(readFleetState()?.profile).toBe("jason");
  });

  it("a re-minted token reaches the copies, and a name already taken gets a suffix", async () => {
    const s = server();
    use(drawerHome);
    const idx = readProfileIndex();
    fs.writeFileSync(path.join(cfg(drawerHome), "cc-accounts.json"), JSON.stringify({ profiles: { ...idx.profiles, "pool-claude4": { email: "someone@else.com", saved_at: 1 } } }));
    invalidateAccountsCache();
    use(holderHome);
    await runPoolPass(s.holder, cfg(holderHome), NOW);
    use(drawerHome);
    expect(await runPoolPass(s.drawer, cfg(drawerHome), NOW)).toEqual(["added pool-claude4-2 (claude4@x.com, from Ashot)"]);

    use(holderHome);
    const later = new Date(NOW + 60_000);
    const fresh = "sk-ant-oat01-" + "q".repeat(90);
    writeAccountToken("claude4", fresh);
    fs.utimesSync(accountTokenInfo("claude4")!.file, later, later);
    expect(await runPoolPass(s.holder, cfg(holderHome), NOW)).toEqual(["sealed claude4@x.com for 1 machine(s)"]);
    use(drawerHome);
    expect(await runPoolPass(s.drawer, cfg(drawerHome), NOW)).toEqual(["refreshed pool-claude4-2 (claude4@x.com, from Ashot)"]);
    expect(readAccountTokenValue("pool-claude4-2")).toBe(fresh);
  });

  it("a holder with no live token says so and seals nothing", async () => {
    const s = server();
    use(holderHome);
    fs.rmSync(accountTokenInfo("claude4")!.file);
    expect(await runPoolPass(s.holder, cfg(holderHome), NOW)).toEqual(["cannot share claude4@x.com: no live setup-token on this machine"]);
    expect(s.copies.size).toBe(0);
  });
});

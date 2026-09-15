import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildProfile,
  getAccountsHeartbeatPayload,
  invalidateAccountsCache,
  profileMeta,
  readProfileIndex,
  resnapshotIfActiveFresher,
  saveProfile,
  tokenKey,
} from "./ccAccounts.js";

describe("profile identity stays attached to the captured credential", () => {
  let testHome: string;
  let originalEnv: Record<string, string | undefined>;
  const identities = {
    alpha: { accountUuid: "uuid-alpha", emailAddress: "alpha@example.com" },
    beta: { accountUuid: "uuid-beta", emailAddress: "beta@example.com" },
  };
  const credential = (name: string, version: number) => JSON.stringify({
    claudeAiOauth: {
      accessToken: `${name}-access-${version}`,
      refreshToken: `${name}-refresh-${version}`,
      expiresAt: Date.now() + version * 3_600_000,
    },
  });
  const secretPath = (name: string) => path.join(testHome, ".codecast", "cc-accounts", `${name}.json`);
  const readSnapshot = (name: string) => JSON.parse(fs.readFileSync(secretPath(name), "utf8"));
  const setActive = (name: keyof typeof identities, version: number) => {
    fs.writeFileSync(path.join(testHome, ".claude", ".credentials.json"), credential(name, version));
    fs.writeFileSync(path.join(testHome, ".claude.json"), JSON.stringify({ oauthAccount: identities[name] }));
    invalidateAccountsCache();
  };

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-identity-race-"));
    originalEnv = Object.fromEntries(["HOME", "CODECAST_DIR", "CC_ACCOUNTS_FORCE_FILE"].map(key => [key, process.env[key]]));
    process.env.HOME = testHome;
    process.env.CODECAST_DIR = path.join(testHome, ".codecast");
    process.env.CC_ACCOUNTS_FORCE_FILE = "1";
    fs.mkdirSync(path.join(testHome, ".claude"), { recursive: true });
    fs.mkdirSync(path.dirname(secretPath("alpha")), { recursive: true });
    const profiles: Record<string, unknown> = {};
    const tokens: Record<string, unknown> = {};
    for (const name of ["alpha", "beta"] as const) {
      const profile = buildProfile(credential(name, 1), identities[name], 1);
      fs.writeFileSync(secretPath(name), JSON.stringify(profile));
      profiles[name] = profileMeta(profile);
      for (const version of [1, 2]) {
        tokens[tokenKey(`${name}-access-${version}`)] = {
          uuid: identities[name].accountUuid,
          email: identities[name].emailAddress,
          verified_at: 1,
        };
      }
    }
    fs.writeFileSync(path.join(testHome, ".codecast", "cc-accounts.json"), JSON.stringify({ profiles }));
    fs.writeFileSync(path.join(testHome, ".codecast", "cc-identity.json"), JSON.stringify({ tokens }));
    setActive("alpha", 2);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(testHome, { recursive: true, force: true });
    invalidateAccountsCache();
  });

  it("does not reread the active login to label a captured credential", () => {
    const read = fs.readFileSync;
    let switched = false;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((file: any, ...args: any[]) => {
      const result = (read as any)(file, ...args);
      if (!switched && file === secretPath("beta")) {
        switched = true;
        setActive("beta", 2);
      }
      return result;
    }) as typeof fs.readFileSync);
    try {
      expect(saveProfile("alpha").email).toBe("alpha@example.com");
      expect(switched).toBe(true);
      expect(readSnapshot("alpha").credentials.claudeAiOauth.accessToken).toBe("alpha-access-2");
      expect(readSnapshot("alpha").oauthAccount).toEqual(identities.alpha);
    } finally {
      spy.mockRestore();
    }
  });

  it("saves the matched credential when the machine switches during async profile reads", async () => {
    const read = fs.promises.readFile;
    let switched = false;
    const spy = spyOn(fs.promises, "readFile").mockImplementation((async (file: any, ...args: any[]) => {
      const result = await (read as any)(file, ...args);
      if (!switched && file === secretPath("alpha")) {
        switched = true;
        setActive("beta", 2);
      }
      return result;
    }) as typeof fs.promises.readFile);
    try {
      expect(await resnapshotIfActiveFresher()).toBe("alpha");
      expect(switched).toBe(true);
      expect(readSnapshot("alpha").credentials.claudeAiOauth.accessToken).toBe("alpha-access-2");
      expect(readProfileIndex().profiles.alpha.email).toBe("alpha@example.com");
      expect(getAccountsHeartbeatPayload()?.profiles.map(p => p.email)).toEqual([
        "alpha@example.com", "beta@example.com",
      ]);
      expect(readSnapshot("beta").credentials.claudeAiOauth.accessToken).toBe("beta-access-1");
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses to overwrite an existing profile with a different verified account", () => {
    const before = fs.readFileSync(secretPath("alpha"), "utf8");
    setActive("beta", 2);
    expect(() => saveProfile("alpha")).toThrow(/different account/);
    expect(fs.readFileSync(secretPath("alpha"), "utf8")).toBe(before);
    expect(readProfileIndex().profiles.alpha.email).toBe("alpha@example.com");
  });

  it("uses the verified email when the label has the right UUID but the wrong email", () => {
    fs.writeFileSync(path.join(testHome, ".claude.json"), JSON.stringify({
      oauthAccount: { ...identities.alpha, emailAddress: identities.beta.emailAddress },
    }));
    expect(saveProfile("alpha").email).toBe("alpha@example.com");
  });
});

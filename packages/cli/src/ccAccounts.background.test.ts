import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as proc from "./proc.js";
import { accountLaunchFilePath, activeAccountIdentity, activeAccountSummary, deleteProfileStoreAsync, ensureProfileStoreAsync, getAccountsHeartbeatPayload, getAccountsHeartbeatPayloadAsync, invalidateAccountsCache, profileStoreDir, writeProfileStoreCredentials } from "./ccAccounts.js";

let root: string;
let savedEnv: Record<string, string | undefined>;
const spies: Array<{ mockRestore(): void }> = [];
const credentials = JSON.stringify({ claudeAiOauth: { accessToken: "test-access", refreshToken: "test-refresh", expiresAt: Date.now() + 3_600_000 } });
const snapshot = JSON.stringify({ credentials: JSON.parse(credentials), oauthAccount: { accountUuid: "test-user" }, saved_at: 1 });
const index = () => path.join(root, "cc-accounts.json");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-background-"));
  savedEnv = { HOME: process.env.HOME, CODECAST_DIR: process.env.CODECAST_DIR, CC_ACCOUNTS_FORCE_FILE: process.env.CC_ACCOUNTS_FORCE_FILE };
  process.env.HOME = root;
  process.env.CODECAST_DIR = root;
  process.env.CC_ACCOUNTS_FORCE_FILE = "1";
  fs.mkdirSync(path.join(root, "cc-accounts"));
  fs.writeFileSync(index(), JSON.stringify({ profiles: { test: { uuid: "test-user", saved_at: 1 } } }));
  fs.writeFileSync(path.join(root, "cc-accounts", "test.json"), snapshot);
  invalidateAccountsCache();
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
  invalidateAccountsCache();
});

test("asynchronous account inventory preserves payloads and sees metadata changes", async () => {
  fs.writeFileSync(path.join(root, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "test@example.com", accountUuid: "test-user" } }));
  expect(await getAccountsHeartbeatPayloadAsync()).toEqual(getAccountsHeartbeatPayload());
  fs.writeFileSync(index(), JSON.stringify({ profiles: { test: { uuid: "test-user", email: "test@example.com", saved_at: 2 }, second: { saved_at: 1 } } }));
  const result = await getAccountsHeartbeatPayloadAsync();
  expect(result?.profiles.map(p => p.name)).toEqual(["second", "test"]);
  expect(result).toEqual(getAccountsHeartbeatPayload());
});

test.skipIf(process.platform !== "darwin")("cold account inventory coalesces slow Keychain reads and keeps timers running", async () => {
  process.env.CC_ACCOUNTS_FORCE_FILE = "0";
  const sync = spyOn(proc, "execFileSync").mockImplementation(() => { throw new Error("synchronous Keychain call"); });
  const reads = spyOn(proc, "keychainReadAsync").mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return credentials;
  });
  spies.push(sync, reads);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const values = await Promise.all(Array.from({ length: 20 }, () => getAccountsHeartbeatPayloadAsync()));
    expect(values[0]?.profiles[0]?.name).toBe("test");
    expect(values.every(value => value === values[0])).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(ticks).toBeGreaterThan(0);
    activeAccountSummary(credentials);
    activeAccountIdentity(credentials);
    expect(sync).not.toHaveBeenCalled();
    invalidateAccountsCache();
    await getAccountsHeartbeatPayloadAsync();
    expect(reads).toHaveBeenCalledTimes(2);
  } finally {
    clearInterval(timer);
  }
});

test("background file stores provision, stay ready, and delete with private permissions", async () => {
  expect(await ensureProfileStoreAsync("test")).toBe("provisioned");
  expect(await ensureProfileStoreAsync("test")).toBe("ready");
  const file = path.join(profileStoreDir("test"), ".credentials.json");
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(JSON.parse(credentials));
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.statSync(accountLaunchFilePath("test")).mode & 0o777).toBe(0o600);
  expect(await deleteProfileStoreAsync("test")).toBe(true);
  expect(fs.existsSync(file)).toBe(false);
  expect(fs.existsSync(accountLaunchFilePath("test"))).toBe(false);
});

test("invalid snapshots and missing or expired profiles never provision", async () => {
  expect(await ensureProfileStoreAsync("absent")).toBe("unusable");
  fs.writeFileSync(path.join(root, "cc-accounts", "test.json"), "{}");
  expect(await ensureProfileStoreAsync("test")).toBe("unusable");
  fs.writeFileSync(index(), JSON.stringify({ profiles: { test: { login_expired_at: Date.now() } } }));
  expect(await ensureProfileStoreAsync("test")).toBe("login_expired");
  expect(fs.existsSync(profileStoreDir("test"))).toBe(false);
});

test("a profile expiring during asynchronous reads is not provisioned", async () => {
  const original = fs.promises.readFile;
  const reads = spyOn(fs.promises, "readFile").mockImplementation(((file: unknown, ...args: unknown[]) => {
    if (String(file).endsWith("/cc-accounts/test.json")) {
      fs.writeFileSync(index(), JSON.stringify({ profiles: { test: { uuid: "test-user", saved_at: 1, login_expired_at: Date.now() } } }));
    }
    return (original as any)(file, ...args);
  }) as any);
  spies.push(reads);
  expect(await ensureProfileStoreAsync("test")).toBe("login_expired");
  expect(fs.existsSync(profileStoreDir("test"))).toBe(false);
});

test.skipIf(process.platform !== "darwin")("slow Keychain reads yield and never spawn synchronously", async () => {
  writeProfileStoreCredentials("test", credentials);
  process.env.CC_ACCOUNTS_FORCE_FILE = "0";
  const sync = spyOn(proc, "execFileSync").mockImplementation(() => { throw new Error("synchronous Keychain call"); });
  const reads = spyOn(proc, "keychainReadAsync").mockImplementation(async args => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return args.includes("codecast-cc-account-test") ? snapshot : credentials;
  });
  spies.push(sync, reads);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    expect(await ensureProfileStoreAsync("test")).toBe("ready");
    expect(ticks).toBeGreaterThan(0);
    expect(sync).not.toHaveBeenCalled();
  } finally {
    clearInterval(timer);
  }
});

test.skipIf(process.platform !== "darwin")("Keychain provisioning and deletion use bounded asynchronous commands", async () => {
  process.env.CC_ACCOUNTS_FORCE_FILE = "0";
  const sync = spyOn(proc, "execFileSync").mockImplementation(() => { throw new Error("synchronous Keychain call"); });
  const reads = spyOn(proc, "keychainReadAsync").mockImplementation(async args => {
    if (args.includes("codecast-cc-account-test")) return snapshot;
    throw Object.assign(new Error("item not found"), { code: 44 });
  });
  const commands = spyOn(proc, "execFileAsync").mockImplementation((async () => ({ stdout: "test-user\n", stderr: "" })) as any);
  spies.push(sync, reads, commands);
  expect(await ensureProfileStoreAsync("test")).toBe("provisioned");
  expect(await deleteProfileStoreAsync("test")).toBe(true);
  expect(sync).not.toHaveBeenCalled();
  expect(commands.mock.calls.map(call => call[1]?.[0])).toEqual(["-un", "add-generic-password", "delete-generic-password"]);
  expect(commands.mock.calls.slice(1).every(call => call[0] === "/usr/bin/security")).toBe(true);
  expect(commands.mock.calls.every(call => (call[2] as any).timeout === 30_000)).toBe(true);
});

test.skipIf(process.platform !== "darwin")("a Keychain timeout never overwrites an unreadable store", async () => {
  process.env.CC_ACCOUNTS_FORCE_FILE = "0";
  const reads = spyOn(proc, "keychainReadAsync").mockImplementation(async args => {
    if (args.includes("codecast-cc-account-test")) return snapshot;
    throw Object.assign(new Error("Keychain timed out"), { code: "ETIMEDOUT" });
  });
  const commands = spyOn(proc, "execFileAsync");
  spies.push(reads, commands);
  await expect(ensureProfileStoreAsync("test")).rejects.toThrow("Keychain timed out");
  expect(commands).not.toHaveBeenCalled();
  expect(fs.existsSync(accountLaunchFilePath("test"))).toBe(false);
});

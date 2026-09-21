import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as proc from "./proc.js";
import { readLocalCredential, readLocalCredentialAsync } from "./remote/session-move.js";
import { writeActiveCredential } from "./ccAccounts.js";
import { ccKeychainReadItems, ccKeychainWriteItem } from "./ccKeychain.js";

let root: string;
let saved: Record<string, string | undefined>;
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "keychain-callers-"));
  saved = Object.fromEntries(["HOME", "CLAUDE_CONFIG_DIR", "CC_ACCOUNTS_FORCE_FILE", "USER"].map(k => [k, process.env[k]]));
  process.env.HOME = root;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "scoped");
  process.env.CC_ACCOUNTS_FORCE_FILE = "0";
  process.env.USER = "test-user";
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("sync and async credential readers prefer the scoped login", async () => {
  const item = ccKeychainWriteItem();
  const sync = spyOn(proc, "execFileSync").mockImplementation(((_cmd: string, args: string[]) => {
    expect(args).toEqual(["find-generic-password", "-s", item.service, "-w"]);
    return "scoped-login\n";
  }) as any);
  const asyncRead = spyOn(proc, "keychainReadAsync").mockImplementation(async args => {
    expect(args).toEqual(["find-generic-password", "-s", item.service, "-w"]);
    return "scoped-login";
  });
  spies.push(sync, asyncRead);
  expect(readLocalCredential()).toBe("scoped-login");
  expect(await readLocalCredentialAsync()).toBe("scoped-login");
  expect(sync).toHaveBeenCalledTimes(1);
  expect(asyncRead).toHaveBeenCalledTimes(1);
});

test("readers exhaust scoped candidates before the machine login and file fallback", async () => {
  const services = ccKeychainReadItems().map(i => i.service);
  const seen: string[] = [];
  const read = (args: string[]) => {
    seen.push(args[2]!);
    if (args[2] !== services.at(-1)) throw new Error("missing scoped item");
    return "legacy-login";
  };
  const sync = spyOn(proc, "execFileSync").mockImplementation(((_cmd: string, args: string[]) => read(args)) as any);
  const asyncRead = spyOn(proc, "keychainReadAsync").mockImplementation(async args => read(args));
  spies.push(sync, asyncRead);
  expect(readLocalCredential()).toBe("legacy-login");
  expect(await readLocalCredentialAsync()).toBe("legacy-login");
  expect(seen).toEqual([...services, ...services]);
  sync.mockImplementation(() => { throw new Error("missing item"); });
  asyncRead.mockImplementation(async () => { throw new Error("missing item"); });
  fs.mkdirSync(path.join(root, ".claude"));
  fs.writeFileSync(path.join(root, ".claude", ".credentials.json"), "file-login");
  expect(readLocalCredential()).toBe("file-login");
  expect(await readLocalCredentialAsync()).toBe("file-login");
});

test.skipIf(process.platform !== "darwin")("writer updates only the scoped item, preserving its existing account", () => {
  const item = ccKeychainWriteItem();
  const sync = spyOn(proc, "execFileSync").mockImplementation(((_cmd: string, args: string[]) => {
    return args[0] === "find-generic-password" ? '"acct"<blob>="older-account"' : "";
  }) as any);
  spies.push(sync);
  writeActiveCredential("test-credential");
  expect(sync.mock.calls.map(c => c[1])).toEqual([
    ["find-generic-password", "-s", item.service],
    ["add-generic-password", "-U", "-a", "older-account", "-s", item.service, "-w", "test-credential"],
  ]);
  sync.mockClear();
  sync.mockImplementation(((_cmd: string, args: string[]) => {
    if (args[0] === "find-generic-password") throw new Error("missing item");
    return "";
  }) as any);
  writeActiveCredential("new-credential");
  expect(sync.mock.calls[1]![1]).toEqual(["add-generic-password", "-U", "-a", "test-user", "-s", item.service, "-w", "new-credential"]);
});

import { afterEach, describe, expect, test } from "bun:test";
import { loginKeychainLocked, setKeychainLockProbeForTests } from "./keychainLock.js";
import { execFileAsync, execFileSync, refuseKeychainCallsWhileLocked, spawnSync } from "./proc.js";

// A path that cannot exist: a spawn fails ENOENT, so KEYCHAIN_LOCKED proves nothing was spawned.
const SECURITY = "/nonexistent-codecast-test/security";
const READ = ["find-generic-password", "-s", "x", "-w"];

afterEach(() => {
  refuseKeychainCallsWhileLocked(false);
  setKeychainLockProbeForTests(null);
});

describe("keychain calls while the login keychain is locked", () => {
  test("an unattended process skips them without spawning", async () => {
    refuseKeychainCallsWhileLocked();
    setKeychainLockProbeForTests(() => true);
    expect(() => execFileSync(SECURITY, READ)).toThrow(expect.objectContaining({ code: "KEYCHAIN_LOCKED" }));
    await expect(execFileAsync(SECURITY, READ)).rejects.toMatchObject({ code: "KEYCHAIN_LOCKED" });
    expect(spawnSync(SECURITY, READ, { encoding: "utf8" })).toMatchObject({ status: null, error: { code: "KEYCHAIN_LOCKED" } });
  });

  test("they run once it is unlocked, and other commands are untouched", async () => {
    refuseKeychainCallsWhileLocked();
    setKeychainLockProbeForTests(() => false);
    await expect(execFileAsync(SECURITY, READ)).rejects.toMatchObject({ code: "ENOENT" });
    setKeychainLockProbeForTests(() => true);
    expect(() => execFileSync("/nonexistent-codecast-test/git", ["status"])).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  test("a command a person runs still reaches the keychain (and its prompt)", async () => {
    setKeychainLockProbeForTests(() => true);
    await expect(execFileAsync(SECURITY, READ)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.if(process.platform === "darwin")("the real probe reads the lock state without prompting", () => {
    expect(typeof loginKeychainLocked()).toBe("boolean");
  });
});

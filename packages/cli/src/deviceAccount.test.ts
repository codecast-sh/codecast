import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  accountSwitchRestartReason,
  deviceClaimSettled,
  previousAccountToClaim,
  readDeviceAccountBearer,
  readDeviceAccountStamp,
  writeDeviceAccountStamp,
} from "./deviceAccount";

describe("device account switch", () => {
  test("a changed user id is a restart, the same id is not", () => {
    expect(accountSwitchRestartReason("ashot", "aivery")).toMatch(/ashot/);
    expect(accountSwitchRestartReason("ashot", "ashot")).toBeNull();
    expect(accountSwitchRestartReason(null, "aivery")).toBeNull();
  });

  test("the stamp names the previous account only when it differs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "device-account-"));
    expect(readDeviceAccountStamp(dir)).toBeNull();
    writeDeviceAccountStamp(dir, "ashot");
    expect(readDeviceAccountStamp(dir)).toBe("ashot");
    expect(previousAccountToClaim("ashot", "aivery")).toBe("ashot");
    expect(previousAccountToClaim("aivery", "aivery")).toBeNull();
    expect(fs.statSync(path.join(dir, "device-account.json")).mode & 0o077).toBe(0);
  });

  // F31: the stamp keeps the previous login's token, encrypted, so the claim
  // can prove the machine really was signed in as that account.
  test("the stamp keeps the account's token encrypted and hands back the bearer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "device-account-"));
    expect(readDeviceAccountBearer(dir)).toBeUndefined();
    writeDeviceAccountStamp(dir, "ashot", "plain-secret-token");
    const raw = fs.readFileSync(path.join(dir, "device-account.json"), "utf8");
    expect(raw).not.toContain("plain-secret-token");
    expect(readDeviceAccountStamp(dir)).toBe("ashot");
    expect(readDeviceAccountBearer(dir)).toBe("plain-secret-token");
    writeDeviceAccountStamp(dir, "ashot");
    expect(readDeviceAccountBearer(dir)).toBeUndefined();
  });

  test("a handover refused for want of proof, still pending, or with more to move is kept", () => {
    expect(deviceClaimSettled({ moved: 0, more: false, needs_proof: true, error: "no proof" })).toBe(false);
    expect(deviceClaimSettled({ moved: 0, more: false, pending: true })).toBe(false);
    expect(deviceClaimSettled({ moved: 100, more: true })).toBe(false);
    expect(deviceClaimSettled(undefined)).toBe(false);
    expect(deviceClaimSettled({ moved: 3, more: false })).toBe(true);
    expect(deviceClaimSettled({ moved: 0, more: false, error: "the two accounts do not share a team" })).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  accountSwitchRestartReason,
  previousAccountToClaim,
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
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { harnessRefreshDue, markHarnessRefreshed } from "./harnessRefreshStamp";

let dir: string;
let stamp: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-stamp-"));
  stamp = path.join(dir, "harness.version");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("harness refresh stamp", () => {
  test("a machine with no stamp refreshes, as after a clean stop removed daemon.version", () => {
    expect(harnessRefreshDue(stamp, "1.1.314")).toBe(true);
  });

  test("a refreshed version is not refreshed again, and a new one is", () => {
    markHarnessRefreshed(stamp, "1.1.313");
    expect(harnessRefreshDue(stamp, "1.1.313")).toBe(false);
    expect(harnessRefreshDue(stamp, "1.1.314")).toBe(true);
  });

  test("a daemon that cannot read its own version refreshes nothing", () => {
    expect(harnessRefreshDue(stamp, "unknown")).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { shouldPersistLog } from "./daemonLogs";

describe("shouldPersistLog", () => {
  test("drops the routine debug/info firehose", () => {
    expect(shouldPersistLog("info")).toBe(false);
    expect(shouldPersistLog("debug")).toBe(false);
  });

  test("keeps actionable warn/error", () => {
    expect(shouldPersistLog("warn")).toBe(true);
    expect(shouldPersistLog("error")).toBe(true);
  });

  test("a mixed batch keeps only warn/error", () => {
    const batch = [
      { level: "info", message: "[HEARTBEAT] session=abc status=idle stuck=0s" },
      { level: "debug", message: "watcher tick" },
      { level: "warn", message: "HIGH FD COUNT" },
      { level: "error", message: "DAEMON OFFLINE" },
    ];
    const kept = batch.filter((l) => shouldPersistLog(l.level));
    expect(kept.map((l) => l.level)).toEqual(["warn", "error"]);
  });
});

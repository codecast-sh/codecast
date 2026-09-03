import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readAgentStatusFiles } from "./daemon.js";

// The watchdog's stale sweep, the warm pool and the hourly cleanup all read
// the hook status directory through this one async reader.
describe("readAgentStatusFiles", () => {
  test("parses records, reports corrupt ones as null, skips non json names", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-agent-status-"));
    try {
      fs.writeFileSync(path.join(dir, "aaa.json"), JSON.stringify({ status: "idle", ts: 1700000000 }));
      fs.writeFileSync(path.join(dir, "bbb.json"), "{not json");
      fs.writeFileSync(path.join(dir, "ccc.txt"), "ignored");
      const before = Date.now() - 1000;
      const rows = await readAgentStatusFiles(dir);
      rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
      expect(rows.map((r) => r.sessionId)).toEqual(["aaa", "bbb"]);
      expect(rows[0].data).toEqual({ status: "idle", ts: 1700000000 });
      expect(rows[0].filePath).toBe(path.join(dir, "aaa.json"));
      expect(rows[0].mtimeMs).toBeGreaterThanOrEqual(before);
      expect(rows[1].data).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing directory reads as empty", async () => {
    expect(await readAgentStatusFiles(path.join(os.tmpdir(), "cc-agent-status-missing-" + process.pid))).toEqual([]);
  });
});

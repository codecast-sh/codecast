import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

// A pane for a session the store does not hold (a teammate's, opened from a
// desktop deep link or a pill) loads it instead of calling it gone. Run in a
// child process: the fixture mocks modules, and bun's module mocks are global.
test("a session pane loads a row the store lacks, and only says unavailable when the server does", async () => {
  const { stdout } = await promisify(execFile)(process.execPath,
    [path.join(import.meta.dir, "../__tests__/fixtures/sessionPaneMissingRow.tsx")],
    { timeout: 30000, maxBuffer: 1024 * 1024 });
  expect(stdout).toContain("session pane missing row verified");
}, 40000);

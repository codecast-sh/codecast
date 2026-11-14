import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// Two BrowserLinks in one daemon each hold their own map of live links and
// share one pid, so the second opened a duplicate link to every host every
// few minutes: it failed on the port the first held, and each try minted a
// token that replaced the live link's (2026-11-14, 27 failures a host).
test("the daemon starts the laptop link exactly once", () => {
  const src = fs.readFileSync(path.join(import.meta.dir, "..", "daemon.ts"), "utf-8");
  expect((src.match(/new BrowserLinks\(|startBrowserLinks\(/g) ?? []).length).toBe(1);
});

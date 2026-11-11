// The remote `reinstall` command pipes the installer into sh, so the installer
// must arrive over https on every hop: a plain http fetch lets anyone on the
// network path choose the script. A source scan, because the handler runs
// inside the daemon's command loop.
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

test("the reinstall command fetches the installer over https only", () => {
  const source = fs.readFileSync(path.join(import.meta.dir, "daemon.ts"), "utf-8");
  const start = source.indexOf('case "reinstall": {');
  expect(start).toBeGreaterThan(0);
  const handler = source.slice(start, source.indexOf("return;", start));
  const curls = handler.match(/curl [^|"]*/g) ?? [];
  expect(curls.length).toBeGreaterThan(0);
  for (const curl of curls) {
    expect(curl).toContain("--proto '=https'");
    expect(curl).toContain("--proto-redir '=https'");
    expect(curl).toMatch(/ https:\/\/codecast\.sh\/install\b/);
  }
});

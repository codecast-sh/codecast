import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { selfExecInfo } from "./selfExec.js";

test("from source, a verb re-execs this tree's main.ts and the daemon its own module", () => {
  const { args } = selfExecInfo("sim", "reap");
  expect(args[0]).toBe(path.join(import.meta.dir, "main.ts"));
  expect(fs.existsSync(args[0])).toBe(true);
  expect(selfExecInfo("_daemon").args[0]).toBe(path.join(import.meta.dir, "daemon.ts"));
});

test("a bundle outside any dist/ or build/ directory re-execs its main.js", async () => {
  const dir = fs.mkdtempSync("/tmp/cast-darwin-dist-");
  try {
    const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "selfExec.ts")], outdir: dir, target: "bun" });
    expect(built.success).toBe(true);
    fs.writeFileSync(path.join(dir, "main.js"), "");
    const mod = await import(path.join(dir, "selfExec.js"));
    expect(mod.selfExecInfo("browser", "reap").args[0]).toBe(path.join(fs.realpathSync(dir), "main.js"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

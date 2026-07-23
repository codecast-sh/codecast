import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("probe environment", () => {
  console.log("CWD:", process.cwd());
  console.log("NODE_ENV:", process.env.NODE_ENV);
  console.log("ENV_KEYS:", Object.keys(process.env).sort().join(","));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: d });
    fs.writeFileSync(path.join(d, "a.txt"), "x\n");
    execFileSync("git", ["-C", d, "add", "a.txt"]);
    execFileSync("git", ["-C", d, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "base"]);
    const out = execFileSync("git", ["-C", d, "rev-parse", "HEAD"], { encoding: "utf-8" });
    console.log("GIT_OK:", out.trim().length === 40, "RAW:", JSON.stringify(out));
    const marker = path.join(d, "marker.txt");
    try {
      execFileSync("sh", ["-c", `echo ran > ${marker}; echo out; exit 0`], { encoding: "utf-8" });
    } catch (e: any) {
      console.log("SH_THREW status:", e.status, "stdout:", JSON.stringify(String(e.stdout)));
    }
    console.log("MARKER_EXISTS:", fs.existsSync(marker), fs.existsSync(marker) ? JSON.stringify(fs.readFileSync(marker, "utf-8")) : "");
    const bs = Bun.spawnSync(["/bin/echo", "bunspawn"]);
    console.log("BUN_SPAWN exit:", bs.exitCode, "out:", JSON.stringify(bs.stdout.toString()));
    const sp = require("node:child_process").spawnSync("/bin/echo", ["nodespawn"], { encoding: "utf-8" });
    console.log("NODE_SPAWNSYNC status:", sp.status, "out:", JSON.stringify(sp.stdout), "err:", sp.error?.message);
  } catch (e: any) {
    console.log("GIT_FAIL:", e.message, "stderr:", JSON.stringify(String(e.stderr)), "code:", e.code, "signal:", e.signal, "status:", e.status);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
  expect(true).toBe(true);
});

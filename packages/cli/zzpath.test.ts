import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
test("diag", () => {
  fs.rmSync("/tmp/zzdiag.txt", { force: true });
  const r = spawnSync("sh", ["-c", "echo PATH=$PATH > /tmp/zzdiag.txt; which -a git >> /tmp/zzdiag.txt 2>&1; git --version >> /tmp/zzdiag.txt 2>&1; echo exit=$? >> /tmp/zzdiag.txt"], { encoding: "utf-8" });
  console.log("status:", r.status);
  console.log("file:", fs.readFileSync("/tmp/zzdiag.txt", "utf-8"));
});

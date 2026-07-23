import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wipdbg-"));
execFileSync("git", ["init", "-q"], { cwd });
execFileSync("git", ["config", "user.email", "t@t.t"], { cwd });
execFileSync("git", ["config", "user.name", "t"], { cwd });
fs.writeFileSync(path.join(cwd, "tracked.txt"), "v1\n");
execFileSync("git", ["add", "tracked.txt"], { cwd });
execFileSync("git", ["commit", "-qm", "base"], { cwd });

const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-wip-"));
const indexFile = path.join(indexDir, "index");
const env = { ...process.env, GIT_INDEX_FILE: indexFile };
try {
  const r1 = await execFileAsync("git", ["read-tree", "HEAD"], { cwd, env });
  console.log("read-tree ok", JSON.stringify(r1.stdout));
  const r2 = await execFileAsync("git", ["add", "-A"], { cwd, env });
  console.log("add ok");
  const r3 = await execFileAsync("git", ["write-tree"], { cwd, env });
  console.log("write-tree ok", r3.stdout.trim());
} catch (e: any) {
  console.log("FAILED:", e.message);
  console.log("stderr:", JSON.stringify(e.stderr));
  console.log("stdout:", JSON.stringify(e.stdout));
  console.log("code:", e.code, "signal:", e.signal);
  console.log("GIT env keys:", Object.keys(env).filter(k => k.startsWith("GIT")));
}

import { test } from "bun:test";
test("noop", () => {});

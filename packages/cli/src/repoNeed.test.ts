import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { memoryDeath, oomKillCount, readRepoNeed, thisMachineTooSmall } from "./repoNeed";

const GiB = 1024 ** 3;

function repo(host: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-need-"));
  fs.mkdirSync(path.join(dir, ".codecast"));
  fs.writeFileSync(path.join(dir, ".codecast", "workspace.toml"), host);
  return dir;
}

test("the need comes from [host] memory_gb; none declared or a bad manifest means none", () => {
  expect(readRepoNeed(repo("[host]\nmemory_gb = 12\n"))).toEqual({ memoryBytes: 12 * GiB });
  expect(readRepoNeed(repo("[host]\npackages = [\"jq\"]\n"))).toBeUndefined();
  expect(readRepoNeed(repo("[host]\nmemory_gb = \"lots\"\n"))).toBeUndefined();
  expect(readRepoNeed(undefined)).toBeUndefined();
});

test("a tool starting on a machine below the need says so first", () => {
  const root = repo("[host]\nmemory_gb = 12\n");
  expect(thisMachineTooSmall(root, 3.7 * GiB)).toStartWith("this machine is too small for this repo: it has 3.7 GB of memory and this repo needs 12.0 GB");
  expect(thisMachineTooSmall(root, 15.3 * GiB)).toBeUndefined();
});

test("the kernel's OOM counter is read from /proc/vmstat", () => {
  expect(oomKillCount("pgfault 12\noom_kill 5\nnr_free_pages 3\n")).toBe(5);
  expect(oomKillCount("pgfault 12\n")).toBeUndefined();
});

// jx72f3a: `cast check web` on a t3.medium reported only that its watcher went away.
test("a SIGKILL while the OOM counter moved is named a memory kill, with the machine's numbers", () => {
  const root = repo("[host]\nmemory_gb = 12\n");
  const line = memoryDeath({ what: "the web typecheck (tsc)", killed: true, oomBefore: 3, oomAfter: 4, repoRoot: root, totalBytes: 3.7 * GiB, freeBytes: 0.2 * GiB });
  expect(line).toStartWith("the web typecheck (tsc) was killed by the kernel's out-of-memory killer: this machine has 3.7 GB of memory, 0.2 GB free now, and this repo needs more");
  expect(line).toContain("cast spawn --subagent");
});

test("anything else is not called memory", () => {
  // A kill by someone else: the counter did not move.
  expect(memoryDeath({ what: "tsc", killed: true, oomBefore: 3, oomAfter: 3 })).toBeUndefined();
  // Another process was OOM-killed while this one exited on its own.
  expect(memoryDeath({ what: "tsc", killed: false, oomBefore: 3, oomAfter: 4 })).toBeUndefined();
  // No counter (a Mac): SIGKILL alone, said as likely.
  expect(memoryDeath({ what: "tsc", killed: true, oomBefore: undefined, oomAfter: undefined, totalBytes: 16 * GiB, freeBytes: GiB })).toStartWith("tsc was killed (SIGKILL), most likely for memory");
});

// What the climb reads from git about a product's tree. A product's whole tree
// runs to megabytes (Union's `ls-tree -r` does), and a read past the default
// buffer once came back as an empty tree: the eval gate's scripts were then
// "not found" and every survivor was refused (ct-97125's third run).
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveCommand, tryGit } from "./protect";

let repo: string;
const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "climb-protect-"));
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t"); g("config", "user.name", "t");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

test("a git read past a megabyte comes back whole, and a command resolves through a large tree", () => {
  fs.mkdirSync(path.join(repo, "outreach/backend/scripts/eval"), { recursive: true });
  fs.writeFileSync(path.join(repo, "outreach/backend/scripts/eval/proof-tree.sh"), "exec \"$@\"\n");
  fs.writeFileSync(path.join(repo, "outreach/backend/scripts/line.ts"), "export {};\n");
  fs.writeFileSync(path.join(repo, "big.txt"), "x".repeat(3 * 1024 * 1024));
  g("add", "-A"); g("commit", "-q", "-m", "base");
  const base = g("rev-parse", "HEAD");
  expect(tryGit(repo, ["show", `${base}:big.txt`])!.length).toBe(3 * 1024 * 1024);
  const reach = resolveCommand(repo, base, "bash $project_path/backend/scripts/eval/proof-tree.sh --name $task_id -- bun scripts/line.ts eval", { project_path: repo, task_id: "ct-1" });
  expect(reach).toEqual({ files: ["outreach/backend/scripts/eval/proof-tree.sh", "outreach/backend/scripts/line.ts"], unresolved: [], project: "outreach" });
});

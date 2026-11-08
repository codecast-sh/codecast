import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTurnSnapshot } from "./treeSnapshot.js";
import { runRewindFilesCommand } from "./rewindFilesCommand.js";
import type { RewindRow } from "./rewindTree.js";

setDefaultTimeout(180_000);
const tmps: string[] = [];
afterEach(() => { while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true }); });
const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

test("plan, a refused stage while busy, stage, a refused stage while one is open, put back", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rwcmd-"));
  tmps.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t.t"]);
  git(root, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, "f.txt"), "v0\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  const rows: RewindRow[] = [];
  for (const [t, v] of [[1000, "v1"], [2000, "v2"]] as const) {
    fs.writeFileSync(path.join(root, "f.txt"), `${v}\n`);
    const s = (await createTurnSnapshot(root))!;
    rows.push({ sha: s.sha, base_sha: s.base, prev_sha: s.prev, taken_at: t, turn_completed_at: t });
  }
  const deps = (busy: boolean) => ({ root, busy, rows: async () => rows, edited: async () => ["f.txt"] });
  const args = { conversation_id: "c", message_ts: 1500 };

  const plan = await runRewindFilesCommand({ ...args, op: "plan" }, deps(false));
  expect(plan.counts).toEqual({ restore: 1, delete: 0, recreate: 0, conflict: 0, total: 1 });
  expect(plan.staged).toBeNull();

  const busy = await runRewindFilesCommand({ ...args, op: "stage", fingerprint: plan.fingerprint }, deps(true));
  expect(busy.refused).toMatch(/agent is working/);
  expect(fs.readFileSync(path.join(root, "f.txt"), "utf8")).toBe("v2\n");

  const staged = await runRewindFilesCommand({ ...args, op: "stage", fingerprint: plan.fingerprint }, deps(false));
  expect(staged.staged?.files).toEqual([{ path: "f.txt", action: "restore" }]);
  expect(fs.readFileSync(path.join(root, "f.txt"), "utf8")).toBe("v1\n");
  expect((await runRewindFilesCommand({ ...args, op: "plan" }, deps(false))).staged?.id).toBe(staged.staged!.id);
  const again = await runRewindFilesCommand({ ...args, op: "stage", fingerprint: plan.fingerprint }, deps(false));
  expect(again.refused).toBeTruthy();
  expect(again.staged?.id).toBe(staged.staged!.id);

  const back = await runRewindFilesCommand({ conversation_id: "c", op: "put_back" }, deps(false));
  expect(back).toMatchObject({ restored: 1, staged: null });
  expect(fs.readFileSync(path.join(root, "f.txt"), "utf8")).toBe("v2\n");
  expect((await runRewindFilesCommand({ conversation_id: "c", op: "keep" }, deps(false))).refused).toMatch(/no rewind is staged/);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildInfoPath, mainCheckoutOf, rebaseBuildInfo, seedBuildInfo, watchDir } from "./check.js";

let tmp: string;
let priorDir: string | undefined;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "check-seed-")));
  priorDir = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = path.join(tmp, "codecast");
});

afterEach(() => {
  if (priorDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = priorDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
};

// main/ with its own node_modules, wt/ a git worktree of it that links
// node_modules back into main (the layout Claude Code's worktrees use).
function trees(): { main: string; wt: string } {
  const main = path.join(tmp, "main");
  fs.mkdirSync(path.join(main, "src"), { recursive: true });
  fs.mkdirSync(path.join(main, "node_modules", "lib"), { recursive: true });
  fs.writeFileSync(path.join(main, "node_modules", "lib", "index.d.ts"), "export type X = 1;\n");
  fs.writeFileSync(path.join(main, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(main, ".gitignore"), "node_modules\n");
  git(main, "init", "-q");
  git(main, "add", "-A");
  git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const wt = path.join(tmp, "wt");
  git(main, "worktree", "add", "-q", wt, "HEAD");
  fs.symlinkSync(path.join(main, "node_modules"), path.join(wt, "node_modules"));
  return { main, wt };
}

test("a worktree's own files move to the worktree; files it links back into main stay main's", () => {
  const { main, wt } = trees();
  const from = { root: main, dir: path.join(tmp, "state", "main") };
  const to = { root: wt, dir: path.join(tmp, "state", "wt") };
  const rel = (dir: string, p: string) => path.relative(dir, p);
  const donor = JSON.stringify({
    fileNames: [
      rel(from.dir, path.join(main, "node_modules", "lib", "index.d.ts")),
      rel(from.dir, path.join(main, "src", "a.ts")),
      rel(from.dir, path.join(main, "src", "only-in-main.ts")),
      rel(from.dir, "/opt/global/lib.d.ts"),
    ],
    version: "5.9.3",
  });
  const out = JSON.parse(rebaseBuildInfo(donor, from, to)!) as { fileNames: string[]; version: string };
  expect(out.fileNames.map((n) => path.resolve(to.dir, n))).toEqual([
    path.join(main, "node_modules", "lib", "index.d.ts"),
    path.join(wt, "src", "a.ts"),
    path.join(wt, "src", "only-in-main.ts"),
    "/opt/global/lib.d.ts",
  ]);
  expect(out.version).toBe("5.9.3");
});

test("unreadable build info is not seeded", () => {
  expect(rebaseBuildInfo("{", { root: "/a", dir: "/s" }, { root: "/b", dir: "/t" })).toBeNull();
  expect(rebaseBuildInfo("{}", { root: "/a", dir: "/s" }, { root: "/b", dir: "/t" })).toBeNull();
});

test("a worktree seeds from its main checkout once; main itself never seeds", () => {
  const { main, wt } = trees();
  expect(mainCheckoutOf(main)).toBeNull();
  expect(fs.realpathSync(mainCheckoutOf(wt)!)).toBe(main);
  expect(seedBuildInfo(wt, "app")).toBe(false); // main has no pass yet
  const donorDir = watchDir(main, "app");
  fs.mkdirSync(donorDir, { recursive: true });
  fs.writeFileSync(buildInfoPath(donorDir), JSON.stringify({ fileNames: [path.relative(donorDir, path.join(main, "src", "a.ts"))] }));
  expect(seedBuildInfo(main, "app")).toBe(false);
  expect(seedBuildInfo(wt, "app")).toBe(true);
  const seeded = JSON.parse(fs.readFileSync(buildInfoPath(watchDir(wt, "app")), "utf-8")) as { fileNames: string[] };
  expect(path.resolve(watchDir(wt, "app"), seeded.fileNames[0])).toBe(path.join(wt, "src", "a.ts"));
  // The worktree's own pass now owns its build info.
  expect(seedBuildInfo(wt, "app")).toBe(false);
});

// A start on a machine without the repo clones it with the machine's own git
// credentials (2026-11-18: a rented Mac had none of the person's checkouts).
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { cloneCheckout } from "./daemon.js";
import { cloneDestination } from "./resumePlacement.js";

function bareRepo(root: string): string {
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  const git = (...a: string[]) => execFileSync("git", ["-C", work, ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  fs.mkdirSync(path.join(work, "backend"));
  fs.writeFileSync(path.join(work, "backend", "app.ts"), "export {};\n");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const bare = path.join(root, "remote.git");
  execFileSync("git", ["clone", "-q", "--bare", work, bare], { stdio: "ignore" });
  return bare;
}

test("the repo is cloned to the same place under this home, and the session's subfolder is there", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "start-clone-"));
  try {
    const remote = bareRepo(root);
    const home = path.join(root, "Users", "rentamac");
    fs.mkdirSync(home, { recursive: true });
    const dest = cloneDestination("/Users/david/git/littlebird/backend", { git_root: "/Users/david/git/littlebird", git_remote_url: remote }, home)!;
    expect(dest).toEqual({ root: path.join(home, "git", "littlebird"), cwd: path.join(home, "git", "littlebird", "backend") });
    expect(await cloneCheckout(remote, dest.root, "[TEST]")).toBe(true);
    expect(fs.existsSync(path.join(dest.cwd, "app.ts"))).toBe(true);
    // Never cloned over a folder that holds files, and a failed clone leaves nothing behind.
    expect(await cloneCheckout(remote, dest.root, "[TEST]")).toBe(false);
    const missing = path.join(home, "git", "nope");
    expect(await cloneCheckout(path.join(root, "absent.git"), missing, "[TEST]")).toBe(false);
    expect(fs.existsSync(missing)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

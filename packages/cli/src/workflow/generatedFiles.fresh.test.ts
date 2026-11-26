import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "../proc.js";
import { defaultExec } from "../lineMerge";
import { GENERATED_FILE, readGenerators } from "./generatedFiles";

// Each generator .codecast/generated.toml lists, run on a clean checkout of
// HEAD with its listed files deleted, writes back exactly those files and
// nothing else. A glob broader than what its generator writes leaves a file
// deleted; a typo leaves the real output unlisted, so it shows as a change; a
// stale committed file shows as a change too. Runs in a worktree of its own
// (the checkout's dependencies linked in), never in the checkout itself.

const root = join(import.meta.dir, "../../../..");
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

test.skipIf(!existsSync(join(root, GENERATED_FILE)))("each listed generator reproduces exactly its listed files on HEAD", () => {
  const dir = mkdtempSync(join(tmpdir(), "generated-fresh-"));
  const tree = join(dir, "tree");
  git(root, "worktree", "add", "-q", "--detach", tree, "HEAD");
  try {
    for (const nm of ["node_modules", ...readdirSync(join(root, "packages")).map((p) => join("packages", p, "node_modules"))]) {
      if (existsSync(join(root, nm)) && existsSync(join(tree, nm, ".."))) symlinkSync(join(root, nm), join(tree, nm));
    }
    const { generators, error } = readGenerators(defaultExec, tree, "HEAD");
    expect(error).toBeUndefined();
    const tracked = git(tree, "ls-files").split("\n").filter(Boolean);
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of ["CODECAST_LAUNCH_TOKEN", "CODECAST_CONVERSATION_ID", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
    for (const g of generators) {
      const listed = tracked.filter((f) => g.paths.some((p) => new Bun.Glob(p).match(f)));
      expect(listed.length).toBeGreaterThan(0);
      for (const f of listed) rmSync(join(tree, f));
      const r = spawnSync("/bin/bash", ["-c", g.run], { cwd: tree, encoding: "utf-8", env: env as NodeJS.ProcessEnv, timeout: 300_000 });
      expect({ run: g.run, status: r.status, err: r.status ? r.stderr : "" }).toEqual({ run: g.run, status: 0, err: "" });
      // The linked node_modules show as untracked (the ignore rule names directories); nothing else may.
      const changed = git(tree, "status", "--porcelain", "--untracked-files=all").split("\n").filter((l) => l && !/(^|\/)node_modules$/.test(l.slice(3)));
      expect({ run: g.run, changed }).toEqual({ run: g.run, changed: [] });
    }
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: root });
    rmSync(dir, { recursive: true, force: true });
  }
}, 900_000);

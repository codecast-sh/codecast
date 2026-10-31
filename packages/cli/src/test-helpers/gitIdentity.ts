// Tests build throwaway repos and commit in them. A CI runner has no global
// git user, so every commit there fails "Committer identity unknown" while the
// same test passes on a laptop. The default identity is the global git config
// (GIT_CONFIG_GLOBAL, git 2.32+), never GIT_AUTHOR_*/GIT_COMMITTER_*: those
// env vars outrank a repo's `git config user.name`, so a test that configures
// its own author would lose to them in every child that inherits process.env.
// Repo-level config outranks global, and the file replaces the developer's
// ~/.gitconfig for the run. It lives in a directory only this user can enter,
// made fresh per process: a path in shared /tmp that another user could
// pre-create would let them add `core.fsmonitor` or `core.hooksPath` and run
// commands as the developer on every git call. A GIT_CONFIG_GLOBAL already
// set is kept.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.GIT_CONFIG_GLOBAL === undefined) {
  const dir = mkdtempSync(join(tmpdir(), "codecast-gitcfg-"));
  const file = join(dir, "config");
  writeFileSync(file, "[user]\n\tname = test\n\temail = test@example.com\n");
  process.env.GIT_CONFIG_GLOBAL = file;
  process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* left for the OS temp sweep */ } });
}

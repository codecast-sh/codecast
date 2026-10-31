// Tests build throwaway repos and commit in them. A CI runner has no global
// git user, so every commit there fails "Committer identity unknown" while the
// same test passes on a laptop. The default identity is the global git config
// (GIT_CONFIG_GLOBAL, git 2.32+), never GIT_AUTHOR_*/GIT_COMMITTER_*: those
// env vars outrank a repo's `git config user.name`, so a test that configures
// its own author would lose to them in every child that inherits process.env.
// Repo-level config outranks the global one, and the file replaces the
// developer's ~/.gitconfig for the run. The file is shared by every process
// and written by rename, so a concurrent reader never sees a partial one.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = "[user]\n\tname = test\n\temail = test@example.com\n";

if (!process.env.GIT_CONFIG_GLOBAL) {
  const file = join(tmpdir(), `codecast-test-gitconfig-${process.getuid?.() ?? 0}`);
  if (!existsSync(file) || readFileSync(file, "utf8") !== config) {
    const staging = `${file}.${process.pid}`;
    writeFileSync(staging, config);
    renameSync(staging, file);
  }
  process.env.GIT_CONFIG_GLOBAL = file;
}

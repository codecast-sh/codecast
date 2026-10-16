// Tests build throwaway repos and commit in them. A CI runner has no global
// git user, so every commit there fails "Committer identity unknown" while the
// same test passes on a laptop. A default identity here reaches every git
// spawned with an env built from process.env. Under bun a child spawned with
// no env at all sees the environment the process started with, so a test that
// edits process.env at runtime passes `env: process.env` by name.
for (const [key, value] of Object.entries({
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
})) process.env[key] ??= value;

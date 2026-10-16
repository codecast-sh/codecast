// Tests build throwaway repos and commit in them. A CI runner has no global
// git user, so every commit there fails "Committer identity unknown" while the
// same test passes on a laptop. A default identity here reaches every git the
// suite spawns, since a child inherits process.env.
for (const [key, value] of Object.entries({
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
})) process.env[key] ??= value;

import { expect, test } from "bun:test";
import { join } from "node:path";

// `cast sessions --help` says what parks a session in DORMANT the way the
// inbox decides it (shared/contracts/inboxProjection rowVerifiedWake): a
// wake the system sees, or a bare claim for 2h of quiet.
test("cast sessions --help names the wakes that keep a session dormant", () => {
  const run = Bun.spawnSync(["bun", join(import.meta.dir, "index.ts"), "sessions", "--help"], { stdout: "pipe", stderr: "pipe" });
  const help = run.stdout.toString().replace(/\s+/g, " ");
  expect(help).toContain("A standing trigger or open background work parks a session with no declaration.");
  expect(help).toContain("parks while a wake the system sees stands: a trigger, a loop, open background work, a subagent still working, a blocker on its task, a wait it set (while it holds another task), or a run it started (the last only while its session's daemon reports).");
  expect(help).toContain("A park on a wait or a run comes back to you after 72h of quiet, and a pin older than the session's last turn parks nothing.");
  expect(help).toContain("A bare claim comes back to you after 2h of quiet, or at once if no daemon reports for it.");
});

import { expect, test } from "bun:test";
import { DAEMON_BUILD_ID } from "./daemonBuildId.js";
import { computeDaemonBuildId } from "./daemonBuildIdCompute.js";

test("the stamped build id has the generated shape", () => {
  expect(DAEMON_BUILD_ID).toMatch(/^[0-9a-f]{12}$/);
});

// Walking the whole closure costs about 50ms, which is fine in CI and noise in
// a local loop. CI sets DAEMON_BUILD_ID_CHECK=1, so a commit that changed
// daemon code without re-stamping fails there.
test.skipIf(!process.env.DAEMON_BUILD_ID_CHECK)("the stamp matches the current daemon closure", () => {
  const { id, files } = computeDaemonBuildId();
  expect(
    id,
    `The daemon build id is stale: the stamp says ${DAEMON_BUILD_ID}, the closure (${files.length} files) ` +
      `hashes to ${id}. Run: cd packages/cli && bun scripts/stamp-daemon-build-id.ts, then commit src/daemonBuildId.ts.`,
  ).toBe(DAEMON_BUILD_ID);
});

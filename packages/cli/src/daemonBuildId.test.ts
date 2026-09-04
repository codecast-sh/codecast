import { expect, test } from "bun:test";
import { DAEMON_BUILD_ID } from "./daemonBuildId.js";
import { computeDaemonBuildId } from "./daemonBuildIdCompute.js";

test("the stamped build id has the generated shape", () => {
  expect(DAEMON_BUILD_ID).toMatch(/^[0-9a-f]{12}$/);
});

// Walking the whole closure reads a few hundred files, which is fine in CI and
// noise in a local loop. CI sets DAEMON_BUILD_ID_CHECK=1, so a commit that
// changed daemon code without re-stamping fails there.
//
// The explicit timeout is the point of the third argument: a loaded machine has
// taken this past bun's 5s default, and the cli suite runs with --bail, so one
// slow read would fail the whole job on code nobody touched.
test.skipIf(!process.env.DAEMON_BUILD_ID_CHECK)("the stamp matches the current daemon closure", () => {
  const { id, files } = computeDaemonBuildId();
  expect(
    id,
    `The daemon build id is stale: the stamp says ${DAEMON_BUILD_ID}, the closure (${files.length} files) ` +
      `hashes to ${id}. Run: cd packages/cli && bun scripts/stamp-daemon-build-id.ts, then commit src/daemonBuildId.ts.`,
  ).toBe(DAEMON_BUILD_ID);
}, 60_000);

// The daemon's build id: a content hash of every first party source file the
// daemon imports. Generated. Run `bun scripts/stamp-daemon-build-id.ts` from
// packages/cli after changing daemon code, and commit the result.
//
// It exists so a CLI release that did not touch daemon code does not bounce a
// daemon running 200 sessions. It is a VETO, never a trigger: every restart
// decision keeps its own precondition (a newer CLI version, a disk version
// mismatch, a finished self update) and only skips the restart when the ids
// match. Nothing here can cause a restart that would not happen anyway.
//
// This file is excluded from its own hash, and it imports nothing on purpose:
// the CLI fast path reads it, so it must never pull in a module graph.
export const DAEMON_BUILD_ID = "e987a6c8972a";

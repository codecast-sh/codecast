// The daemon's build id: a content hash of every first party source file the
// daemon imports (daemonBuildIdCompute.ts). A compiled CLI carries it, defined
// by build-with-native.ts from the tree it compiles. A CLI run from source
// carries none: the source daemon hashes its tree itself (sourceRestart.ts).
// Nothing is committed, so two changes to the daemon never conflict on it.
//
// It exists so a CLI release that did not touch daemon code does not bounce a
// daemon running 200 sessions. It is a VETO, never a trigger: every restart
// decision keeps its own precondition (a newer CLI version, a disk version
// mismatch, a finished self update) and only skips the restart when the ids
// match. Nothing here can cause a restart that would not happen anyway.
//
// It imports nothing on purpose: the CLI fast path reads it, so it must never
// pull in a module graph.
declare const CODECAST_DAEMON_BUILD_ID: string | undefined;

export const DAEMON_BUILD_ID: string | null = typeof CODECAST_DAEMON_BUILD_ID === "string" ? CODECAST_DAEMON_BUILD_ID : null;

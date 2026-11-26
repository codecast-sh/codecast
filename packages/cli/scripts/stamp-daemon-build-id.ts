#!/usr/bin/env bun
// Prints the daemon build id the source on disk hashes to. A source daemon
// runs it in a child process to compare with the code it booted on
// (sourceRestart.ts); build-with-native.ts defines the same id into every build.
//
// The name is kept because a running source daemon calls this path, and one
// booted before a rename would stop restarting onto new code.

import { computeDaemonBuildId, findRepoRoot } from "../src/daemonBuildIdCompute.js";

console.log(computeDaemonBuildId(findRepoRoot()).id);

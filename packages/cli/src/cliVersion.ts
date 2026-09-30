// The running CLI's version, from its package.json (embedded in a compiled
// build). A leaf so a module that only stamps the version, like the harness
// ledger the workers write through, does not load update.ts: that module
// builds the self updater when it is imported.

import pkg from "../package.json";

export function getVersion(): string {
  return pkg.version;
}

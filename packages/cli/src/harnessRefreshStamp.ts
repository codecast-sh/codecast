// Which version last refreshed this machine's harness files (hooks, snippets,
// skills). The daemon reads it at boot and runs `cast snippets-refresh` when it
// differs from its own version, so a self update brings the hook scripts with
// it. It is a stamp of its own because daemon.version is removed on every
// clean exit, which made each update after a stop look like a first boot.

import * as fs from "fs";

export function harnessRefreshDue(stampFile: string, version: string | undefined): boolean {
  if (!version || version === "unknown") return false;
  try {
    return fs.readFileSync(stampFile, "utf-8").trim() !== version;
  } catch {
    return true;
  }
}

export function markHarnessRefreshed(stampFile: string, version: string): void {
  try {
    fs.writeFileSync(stampFile, version, { mode: 0o600 });
  } catch {
    // The next boot refreshes again, which rewrites the same files.
  }
}

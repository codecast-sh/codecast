import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";

// The build id is a VETO on a restart, never a trigger for one. Getting that
// backwards is the failure this guards: worktrees of this repo run the same
// CLI at different commits, so a build id that could START a restart would let
// a worktree bounce the main daemon into its own tree on every edit.
//
// The check is a source scan because the deciding code is inline in two module
// tails that cannot be imported without running the CLI.

const src = (rel: string) => fs.readFileSync(path.join(import.meta.dir, rel), "utf-8");

/** The body of `function <name>(...)`, by brace balance from its opening `{`. */
function functionBody(source: string, name: string): string {
  const at = source.indexOf(`function ${name}(`);
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced body for ${name}`);
}

describe("daemon restart gating", () => {
  const index = src("index.ts");

  test("ensureDaemonRunning only consults the build id inside the newer-version branch", () => {
    const body = functionBody(index, "ensureDaemonRunning");
    const versionBranch = body.indexOf("if (cliIsNewer)");
    const buildCheck = body.indexOf("DAEMON_BUILD_ID");
    expect(versionBranch).toBeGreaterThan(-1);
    expect(buildCheck).toBeGreaterThan(versionBranch);
  });

  test("bounceDaemonIfBuildChanged restarts only when the ids differ or one is unknown", () => {
    const body = functionBody(index, "bounceDaemonIfBuildChanged");
    // Equal AND both known is the only case that returns without restarting.
    expect(body).toContain("if (runningBuild && installedBuild && runningBuild === installedBuild) return false;");
    expect(body).toContain("stopDaemon();");
    expect(body).toContain("startDaemon();");
  });

  test("the update paths no longer stop the daemon before performUpdate", () => {
    // performUpdate renames the executable and the running daemon holds the old
    // inode, so a pre-update stop bought nothing and left the machine
    // daemonless whenever the update failed.
    const updateAction = index.slice(index.indexOf('.command("update")'));
    const performAt = updateAction.indexOf("await performUpdate()");
    expect(performAt).toBeGreaterThan(-1);
    expect(updateAction.slice(0, performAt)).not.toContain("stopDaemon()");
  });

  test("the split brain sweeps match off the process table, not pgrep", () => {
    const daemon = src("daemon.ts");
    expect(functionBody(index, "stopDaemon")).toContain("findOtherDaemonPids(snapshotProcessTable())");
    expect(functionBody(daemon, "acquireLock")).toContain("findOtherDaemonPids(snapshotProcessTable())");
    for (const source of [index, daemon]) {
      expect(source).not.toContain("pgrep -f 'daemon");
    }
  });

  // The claim runs after all three delivery paths have already marked the
  // command as handled here. Skipping without undoing that marking loses the
  // command outright when the winner dies before executing: the lease lapses,
  // the poll re-offers it, and the dedup check drops it forever.
  test("a refused claim is bounded, narrow, and forgets the command it skipped", () => {
    // Read a window around the claim, not a balanced body: executeRemoteCommand
    // is thousands of lines of command handlers with braces inside strings.
    const daemon = src("daemon.ts");
    const claimAt = daemon.indexOf("/cli/command-claim");
    expect(claimAt).toBeGreaterThan(-1);
    const claimBlock = daemon.slice(claimAt, claimAt + 1600);
    expect(claimBlock).toContain("AbortSignal.timeout(");
    expect(claimBlock).toContain('claim.reason === "held_by_other"');
    expect(claimBlock).toContain('claim.reason === "already_executed"');
    expect(claimBlock).toContain("forgetProcessedCommand(commandId)");
  });

  test("forgetProcessedCommand clears both dedup sets", () => {
    const body = functionBody(src("daemon.ts"), "forgetProcessedCommand");
    expect(body).toContain("processedPollCommandIds.delete(commandId)");
    expect(body).toContain("processedCommandIds.delete(commandId)");
  });

  test("checkDiskVersionMismatch keeps restarting when the disk build id is unknown", () => {
    const body = functionBody(src("daemon.ts"), "checkDiskVersionMismatch");
    // The only early return is the ids-match case; a null id falls through.
    expect(body).toContain("if (diskBuildId && diskBuildId === DAEMON_BUILD_ID) {");
    expect(body).toContain("restartDaemonProcess(\"disk version mismatch\")");
  });
});

import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { daemonBuildUnchanged } from "./daemonBuildGate.js";

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

describe("daemonBuildUnchanged", () => {
  // The rule the three gates share: stand down only when both ids are known
  // and equal. An unknown id must never suppress a restart, or a daemon with no
  // stamp would sit on old code forever.
  test("equal and known is the only stand down", () => {
    expect(daemonBuildUnchanged("abc123abc123", "abc123abc123")).toBe(true);
    expect(daemonBuildUnchanged("abc123abc123", "def456def456")).toBe(false);
    expect(daemonBuildUnchanged(null, null)).toBe(false);
    expect(daemonBuildUnchanged(null, "abc123abc123")).toBe(false);
    expect(daemonBuildUnchanged("abc123abc123", null)).toBe(false);
    expect(daemonBuildUnchanged(undefined, undefined)).toBe(false);
    expect(daemonBuildUnchanged("", "")).toBe(false);
  });
});

describe("daemon restart gating", () => {
  const index = src("index.ts");

  test("ensureDaemonRunning consults the build id only where the CLI is newer", () => {
    const body = functionBody(index, "ensureDaemonRunning");
    const versionBranch = body.indexOf("if (cliIsNewer)");
    const buildCheck = body.indexOf("daemonBuildUnchanged(");
    expect(versionBranch).toBeGreaterThan(-1);
    expect(buildCheck).toBeGreaterThan(versionBranch);
  });

  // One predicate, three gates. Inlining the rule again in any of them is how
  // the three drifted apart before it existed.
  test("every gate asks the shared predicate", () => {
    const daemon = src("daemon.ts");
    expect(functionBody(index, "ensureDaemonRunning")).toContain("daemonBuildUnchanged(");
    expect(functionBody(index, "bounceDaemonIfBuildChanged")).toContain("daemonBuildUnchanged(");
    expect(functionBody(daemon, "checkDiskVersionMismatch")).toContain("daemonBuildUnchanged(");
  });

  test("bounceDaemonIfBuildChanged restarts unless the ids match", () => {
    const body = functionBody(index, "bounceDaemonIfBuildChanged");
    expect(body).toContain("if (daemonBuildUnchanged(runningBuild, installedBuild)) return false;");
    expect(body).toContain("stopDaemon();");
    expect(body).toContain("startDaemon();");
  });

  test("the update paths no longer stop the daemon before performUpdate", () => {
    // performUpdate renames the executable and the running daemon holds the old
    // inode. The stop that used to run before the update bought nothing and
    // left the machine with no daemon whenever the update failed.
    const updateAction = index.slice(index.indexOf('.command("update")'));
    const performAt = updateAction.indexOf("await performUpdate()");
    expect(performAt).toBeGreaterThan(-1);
    expect(updateAction.slice(0, performAt)).not.toContain("stopDaemon()");
  });

  test("the split brain sweeps match off the process table, not pgrep", () => {
    const daemon = src("daemon.ts");
    expect(functionBody(index, "stopDaemon")).toContain("findOtherDaemonPids(snapshotProcessTable(");
    expect(functionBody(daemon, "sweepOrphanDaemons")).toContain("findOtherDaemonPids(await snapshotProcessTableAsync(");
    for (const source of [index, daemon]) {
      expect(source).not.toContain("pgrep -f 'daemon");
    }
  });

  // acquireLock decides whether this process may run at all, and it runs before
  // the listener binds. A `ps` there put seconds back into the boot blackout,
  // and matching the live pid file holder made the newcomer kill the very
  // daemon it was supposed to defer to.
  test("acquireLock consults the pid file only", () => {
    const body = functionBody(src("daemon.ts"), "acquireLock");
    expect(body).not.toContain("snapshotProcessTable");
    expect(body).not.toContain("findOtherDaemonPids");
    expect(body).toContain("tryAcquirePidFileLock(PID_FILE, process.pid)");
  });

  test("the orphan sweep spares a live pid file holder and terminates before it kills", () => {
    const body = functionBody(src("daemon.ts"), "sweepOrphanDaemons");
    expect(body).toContain("readPidFile(PID_FILE)");
    expect(body).toContain("pid !== protectedPid");
    // killProcessTree is SIGTERM, wait, then SIGKILL, so the victim flushes.
    // The wait is the budget `cast stop` uses, because the victim runs the same
    // shutdown: a shorter one kills it mid retry flush, which is the one case
    // the flush exists for.
    expect(body).toContain("killProcessTree(pids, DAEMON_STOP_SIGKILL_MS)");
    expect(body).not.toContain('"SIGKILL"');
  });

  // A throw here used to reach the signal handler's catch, which exits(1)
  // before the pid file release and the stop lifecycle line.
  test("the shutdown flush and the claim release are each guarded", () => {
    const daemon = src("daemon.ts");
    const flushAt = daemon.indexOf("Flushing ${pendingOps} pending retry operation(s) before exit");
    expect(flushAt).toBeGreaterThan(-1);
    const around = daemon.slice(flushAt - 600, flushAt + 1400);
    expect(around).toContain("Retry flush failed:");
    expect(around).toContain("releaseHeldCommandClaims(");
    expect(around).toContain("Command claim release failed:");
  });

  // A second daemon taking SIGTERM used to unlink the live daemon's
  // daemon.version and daemon.build, and an absent build id turns the veto off.
  // The guard cannot be "do I own the pid file": `cast stop` unlinks it before
  // the daemon gets here, so that would leave the stamps behind after a stop.
  test("the version and build stamps survive a stop by a daemon that does not hold the lock", () => {
    const daemon = src("daemon.ts");
    const body = functionBody(daemon, "clearDaemonStampsIfUnheld");
    expect(body).toContain("if (stampHolder && stampHolder !== process.pid && isProcessRunning(stampHolder)) return;");
    expect(body).toContain("fs.unlinkSync(VERSION_FILE)");
    expect(body).toContain("fs.unlinkSync(BUILD_FILE)");
    // Both exit paths use it. The hard exit timer used to unlink the two files
    // outright, so a second daemon that timed out on the way out erased the
    // live daemon's stamps and turned the veto off for every later gate.
    expect(daemon.split("clearDaemonStampsIfUnheld();").length - 1).toBe(2);
    const hardExit = daemon.slice(daemon.indexOf("Hard exit after shutdown timeout"));
    expect(hardExit.slice(0, 400)).toContain("clearDaemonStampsIfUnheld();");
    // And nowhere else may unlink them.
    expect(daemon.split("fs.unlinkSync(BUILD_FILE)").length - 1).toBe(1);
  });

  // The lease is per device. An untargeted command (kill_session, an admin
  // restart) is inserted for the whole fleet, so a claim that omitted the
  // device would let one machine swallow every broadcast.
  test("the claim carries the device and the lease is given back on the way out", () => {
    const daemon = src("daemon.ts");
    const at = daemon.indexOf("async function requestCommandClaim(");
    expect(at).toBeGreaterThan(-1);
    const body = daemon.slice(at, daemon.indexOf("\n}\n", at));
    expect(body).toContain("device_id: deviceId()");
    // The boot id is overridable: a release for the previous daemon's leases
    // has to carry ITS id, because only the holder may let go.
    expect(body).toContain("boot_id: opts.bootId ?? BOOT_ID");
    expect(body).toContain("AbortSignal.timeout(");
    expect(functionBody(daemon, "releaseHeldCommandClaims")).toContain("release: true");
  });

  // The claim runs after all three delivery paths have already marked the
  // command as handled here. Skipping without undoing that marking loses the
  // command outright when the winner dies before executing: the lease lapses,
  // the poll re-offers it, and the dedup check drops it forever.
  test("a refused claim is bounded, narrow, and forgets the command it skipped", () => {
    // Read a window around the claim, not a balanced body: executeRemoteCommand
    // is thousands of lines of command handlers with braces inside strings.
    const daemon = src("daemon.ts");
    const claimAt = daemon.indexOf("const claim = await takePrimedClaim(");
    expect(claimAt).toBeGreaterThan(-1);
    const claimBlock = daemon.slice(claimAt, claimAt + 1200);
    expect(claimBlock).toContain('claim.reason === "held_by_other"');
    expect(claimBlock).toContain('claim.reason === "already_executed"');
    expect(claimBlock).toContain("forgetProcessedCommand(commandId)");
  });

  // The three delivery paths (the subscription, the 10s poll, the heartbeat
  // response) used to carry three copies of the same dedup-and-execute loop, so
  // the claim ran inside the executor and a batch of N paid N round trips
  // before the first command ran.
  test("all three delivery paths run one batch executor that claims up front", () => {
    const daemon = src("daemon.ts");
    for (const source of ["SUBSCRIPTION", "POLL", "HEARTBEAT"]) {
      expect(daemon).toContain(`executeCommandBatch(`);
      expect(daemon).toContain(`, config, "${source}");`);
    }
    const at = daemon.indexOf("async function executeCommandBatch(");
    expect(at).toBeGreaterThan(-1);
    const body = daemon.slice(at, daemon.indexOf("\n}\n", at));
    expect(body).toContain("processedCommandIds.has(c.id)");
    expect(body).toContain("processedPollCommandIds.has(c.id)");
    // The claim goes out for the whole batch before the serial execute loop.
    const primeAt = body.indexOf("primeCommandClaims(");
    const executeAt = body.indexOf("await executeRemoteCommand(");
    expect(primeAt).toBeGreaterThan(-1);
    expect(executeAt).toBeGreaterThan(primeAt);
    // And the old per-path loops are gone: one call site, inside the batch.
    expect(daemon.split("await executeRemoteCommand(").length - 1).toBe(1);
  });

  // Priming ahead of the owner guard is safe only because the guard hands the
  // lease back when it defers the command to the device that owns the session.
  test("the owner guard gives back a lease it primed", () => {
    const daemon = src("daemon.ts");
    const at = daemon.indexOf("leave the rest of the command for the owner device");
    expect(at).toBeGreaterThan(-1);
    expect(daemon.slice(at - 400, at)).toContain("discardPrimedClaim(commandId, siteUrl, config.auth_token);");
  });

  // Most restarts never reach the graceful shutdown: launchd kickstart kills
  // us, the self heal exits at once, the watchdog sends SIGKILL. The held set
  // is on disk so the NEXT daemon gives those leases back, which the shutdown
  // release alone cannot do.
  test("held leases are written to disk and released by the next daemon at boot", () => {
    const daemon = src("daemon.ts");
    expect(functionBody(daemon, "holdClaim")).toContain("persistHeldClaims()");
    expect(functionBody(daemon, "dropClaim")).toContain("persistHeldClaims()");
    expect(functionBody(daemon, "persistHeldClaims")).toContain("heldClaimsFile(BOOT_ID)");
    expect(functionBody(daemon, "releaseHeldCommandClaims")).toContain("persistHeldClaims()");
    // Boot releases them after the port answers, off the boot path.
    expect(daemon).toContain("void releaseStrandedCommandClaims(config)");
    // The raw set is touched only inside those helpers, so no write can skip
    // the disk mirror.
    expect(daemon.split("heldClaimIds.add(").length - 1).toBe(1);
    expect(daemon.split("heldClaimIds.delete(").length - 1).toBe(1);
  });

  test("forgetProcessedCommand clears both dedup sets", () => {
    const body = functionBody(src("daemon.ts"), "forgetProcessedCommand");
    expect(body).toContain("processedPollCommandIds.delete(commandId)");
    expect(body).toContain("processedCommandIds.delete(commandId)");
  });

  test("checkDiskVersionMismatch keeps restarting when the disk build id is unknown", () => {
    const body = functionBody(src("daemon.ts"), "checkDiskVersionMismatch");
    // The only early return is the case where the ids match. A null id falls
    // through and still restarts.
    expect(body).toContain("if (daemonBuildUnchanged(DAEMON_BUILD_ID, diskBuildId)) {");
    expect(body).toContain("restartDaemonProcess(\"disk version mismatch\")");
  });

  // The veto is a steady state and this check runs every five minutes, so the
  // stand down line has to be said once per disk version. Otherwise it repeats
  // forever in the file operators read for freeze and delivery evidence.
  test("the build id veto logs once per disk version", () => {
    const body = functionBody(src("daemon.ts"), "checkDiskVersionMismatch");
    const guardAt = body.indexOf("if (vetoedDiskVersion !== diskVersion) {");
    const logAt = body.indexOf("but the daemon build id is unchanged");
    expect(guardAt).toBeGreaterThan(-1);
    expect(logAt).toBeGreaterThan(guardAt);
  });
});

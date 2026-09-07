/**
 * The two TCC grants `cast computer` needs, read and requested through the
 * helper itself.
 *
 * The status read is the subtle part. Exec'ing the helper binary from this
 * process can report the PARENT's already-granted context, which reads as a
 * false positive — the helper would look trusted on a machine where nothing
 * granted it anything. Two routes avoid that, and both are here:
 *
 *  - the disclaimed spawn (`cast _disclaimed --`), which makes the helper
 *    responsible for itself, so TCC evaluates its own identity. This is the
 *    default, because it yields a real child pid and a real spawn error.
 *  - `/usr/bin/open -n <app> --args --permission-status-file <path>`, which
 *    hands the launch to LaunchServices. This is Orca's route
 *    (macos-computer-use-permission-status.ts:77-110) and the documented
 *    fallback for the cases where disclaiming is unavailable:
 *    CODECAST_NO_DISCLAIM=1, and a macOS that drops the private symbol.
 *
 * `CODECAST_COMPUTER_PERMISSION_ROUTE=open` forces the fallback, which is how
 * the two routes get compared on a machine where the helper is granted and the
 * parent is not: same answer means the disclaimed route is not inheriting.
 *
 * Either way, the answer comes from a file the helper writes about ITSELF.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnSync } from "../proc.js";
import { ComputerError } from "./errors.js";
import { resolveCastInvocation } from "../castInvocation.js";
import { HELPER_BUNDLE_ID, helperAppPath, helperExecutablePath } from "./helperApp.js";
import { stampComputerRaise } from "./instance.js";
import { spawnObserved, type ObservedLaunch } from "./launchObserver.js";
import type { ComputerPermissionId, ComputerPermissionStatus, ComputerPermissionStatusResult } from "./types.js";

/**
 * How long to wait for the helper's answer, measured rather than guessed
 * (ct-49671).
 *
 * This was 5 seconds, and the helper did not fit in it. On a Mac with no TCC
 * row for the bundle, one status read took 3.4 s to 25.7 s, so the first
 * command a new user ran reported `timed out checking permissions` more often
 * than it reported a state. Most of that was the helper's settle loop counting
 * only its own naps against a 1500 ms budget while each probe call cost real
 * time; fixing the accounting brought the helper itself to a flat 2.2-2.6 s.
 *
 * The launch on top of it is what makes a tight budget wrong anyway. The
 * disclaim wrapper is this CLI, and starting it costs 0.3 s compiled and up to
 * 6.5 s from source on a cold module cache, so end to end runs measured 3.8 s
 * to 8.8 s.
 *
 * 30 s is therefore a ceiling, not an expected wait: the poll returns the
 * instant the file appears, and a probe that DIES is reported immediately with
 * its exit and its stderr (ct-49674), so the ceiling is only ever reached by a
 * child that is alive and still waiting on tccd. Waiting longer for that costs
 * nothing; failing early costs the user a true answer.
 */
export const STATUS_POLL_TIMEOUT_MS = 30_000;
const STATUS_POLL_INTERVAL_MS = 100;

export const PERMISSION_IDS: ComputerPermissionId[] = ["accessibility", "screenshots"];

function unsupported(): ComputerPermissionStatusResult {
  return {
    platform: process.platform,
    helperAppPath: null,
    helperUnavailableReason: null,
    permissions: PERMISSION_IDS.map((id) => ({ id, status: "unsupported" as ComputerPermissionStatus })),
  };
}

function unavailable(reason: string, appPath: string | null): ComputerPermissionStatusResult {
  return {
    platform: process.platform,
    helperAppPath: appPath,
    helperUnavailableReason: reason,
    permissions: PERMISSION_IDS.map((id) => ({ id, status: "not-granted" as ComputerPermissionStatus })),
  };
}

function helperIsMaterialized(): boolean {
  try {
    return fs.statSync(helperExecutablePath()).isFile();
  } catch {
    return false;
  }
}

export interface PermissionStatusOptions {
  /** Overrides how the probe is launched. Exists for tests; production always
   *  takes one of the two routes above, never an in-process exec. A test that
   *  returns nothing gets no launch observation, which is the point: it is
   *  driving the poll, not a child. */
  launch?: (appPath: string, statusPath: string, logFile: string) => ObservedLaunch | void;
  /** Which launch route to take, overriding the environment. Design 3.4 asks
   *  for the two to be COMPARED on a granted machine, and that comparison is
   *  only worth anything if it runs the code that ships. */
  route?: PermissionProbeRoute;
  /** Overrides the poll ceiling. Exists so a test can drive the give-up path
   *  without spending the real budget on it. */
  timeoutMs?: number;
}

export type PermissionProbeRoute = "disclaimed" | "open";

/** Ask the helper what IT is granted. Never exec's the binary in-process. */
export async function getPermissionStatus(opts: PermissionStatusOptions = {}): Promise<ComputerPermissionStatusResult> {
  if (process.platform !== "darwin") return unsupported();
  const appPath = helperAppPath();
  if (!helperIsMaterialized()) {
    return unavailable(`${helperExecutablePath()} was not found — run \`cast computer capabilities\` to materialize the helper`, appPath);
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-computer-permissions-"));
  fs.chmodSync(tempDir, 0o700);
  const statusPath = path.join(tempDir, "status.json");
  const probe =
    (opts.launch ?? ((app, status, log) => launchStatusProbe(app, status, log, opts.route)))(
      appPath,
      statusPath,
      path.join(tempDir, "probe.log"),
    ) || null;
  const report = (raw: Partial<Record<ComputerPermissionId, unknown>>): ComputerPermissionStatusResult => ({
    platform: process.platform,
    helperAppPath: appPath,
    helperUnavailableReason: null,
    permissions: PERMISSION_IDS.map((id) => ({ id, status: normalizeStatus(raw[id]) })),
  });
  const deadline = Date.now() + (opts.timeoutMs ?? STATUS_POLL_TIMEOUT_MS);
  try {
    for (;;) {
      const raw = readStatusFile(statusPath);
      if (raw) return report(raw);
      // Why: the probe writes the file and exits, so an exit is either the
      // answer landing a beat before this read or a real death — and a death
      // is worth reporting NOW, with its reason, rather than as a timeout the
      // poll reaches seconds later (ct-49674).
      if (probe?.exitReason()) {
        const late = readStatusFile(statusPath);
        if (late) return report(late);
        throw new ComputerError("accessibility_error", `the permission probe ${probe.explain()}`);
      }
      if (Date.now() >= deadline) break;
      await sleep(STATUS_POLL_INTERVAL_MS);
    }
    const said = probe?.explain();
    throw new ComputerError("accessibility_error", said ? `timed out checking permissions: ${said}` : "timed out checking permissions");
  } finally {
    probe?.cleanup();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function normalizeStatus(value: unknown): ComputerPermissionStatus {
  return value === "granted" || value === "unsupported" ? value : "not-granted";
}

function readStatusFile(statusPath: string): Partial<Record<ComputerPermissionId, unknown>> | null {
  try {
    // The helper writes atomically, so a readable file is a complete one; a
    // parse failure here means a partial write we should keep waiting on.
    return JSON.parse(fs.readFileSync(statusPath, "utf-8")) as Partial<Record<ComputerPermissionId, unknown>>;
  } catch {
    return null;
  }
}

function useOpenRoute(route?: PermissionProbeRoute): boolean {
  if (route) return route === "open";
  return process.env.CODECAST_COMPUTER_PERMISSION_ROUTE === "open" || process.env.CODECAST_NO_DISCLAIM === "1";
}

function launchStatusProbe(appPath: string, statusPath: string, logFile: string, route?: PermissionProbeRoute): ObservedLaunch {
  const args = ["--permission-status-file", statusPath];
  if (useOpenRoute(route)) {
    // `open` is a launcher, not the probe: it hands the app to LaunchServices
    // and exits, so watching IT for an exit would report success as a death.
    // It does report a refusal (a bundle LaunchServices will not open) in its
    // own exit code, so that is what is checked, synchronously.
    runOpen(["-n", appPath, "--args", ...args], "start the permission probe");
    return silentLaunch();
  }
  const cast = resolveCastInvocation();
  // The disclaim wrapper execs in place, so this pid IS the helper and its
  // exit is the helper's exit.
  return spawnObserved(cast.cmd, [...cast.prefixArgs, "_disclaimed", "--", helperExecutablePath(appPath), ...args], logFile);
}

/** Nothing to watch: the child we started was a launcher that already
 *  reported for itself. */
function silentLaunch(): ObservedLaunch {
  return {
    child: null as never,
    exitReason: () => null,
    said: () => "",
    explain: () => "",
    cleanup: () => {},
  };
}

/** `open`, with its refusal turned into an error that names itself. */
function runOpen(args: string[], what: string): void {
  const result = spawnSync("/usr/bin/open", args, { encoding: "utf8", timeout: 30_000 });
  if (result.error) throw new ComputerError("accessibility_error", `could not ${what}: ${result.error.message}`);
  if (result.status === 0) return;
  const detail = (result.stderr || result.stdout || `exit ${result.status ?? "unknown"}`).replace(/\s+/g, " ").trim();
  throw new ComputerError("accessibility_error", `could not ${what}: ${detail}`);
}

export interface PermissionSetupResult extends ComputerPermissionStatusResult {
  permissionId?: ComputerPermissionId;
  launchedHelper: boolean;
  nextStep: string | null;
}

function requireKnownPermissionId(permissionId?: ComputerPermissionId): void {
  if (permissionId && !PERMISSION_IDS.includes(permissionId)) {
    throw new ComputerError("invalid_argument", '--id must be "accessibility" or "screenshots"');
  }
}

/**
 * Report the two grants and the next step, and put nothing on screen.
 *
 * Why: `permissions` is what six of the error recoveries tell an agent to run
 * as a diagnostic, and it used to open the System Settings pane and activate a
 * helper window whenever a grant was missing — which is exactly the machine
 * where an agent runs it (ct-49667). A status read raises nothing;
 * `--open-settings` is the explicit ask.
 */
export async function readPermissionStatus(
  permissionId?: ComputerPermissionId,
  opts: PermissionStatusOptions = {},
): Promise<PermissionSetupResult> {
  requireKnownPermissionId(permissionId);
  const status = await getPermissionStatus(opts);
  return { ...status, permissionId, launchedHelper: false, nextStep: nextPermissionStep(status) };
}

/**
 * Open the System Settings pane for one grant, through the helper's own setup
 * window (it shows the drag instruction beside the deep link).
 *
 * This is the second of the feature's two raise sites, and it runs only when
 * the caller asked for it with `--open-settings`. Like `--restore-window` it
 * stamps the raise, so the daemon's focus sentinel does not bounce the window
 * a second after it appears.
 */
export async function openPermissionSettings(permissionId?: ComputerPermissionId): Promise<PermissionSetupResult> {
  const base = await readPermissionStatus(permissionId);
  if (process.platform !== "darwin") return base;
  if (base.helperUnavailableReason) throw new ComputerError("accessibility_error", base.helperUnavailableReason);

  closeExistingSetupHelpers();
  const appPath = base.helperAppPath ?? helperAppPath();
  const args = permissionId ? ["--permission", permissionId] : ["--permissions"];
  stampComputerRaise();
  // LaunchServices, not a disclaimed spawn: this mode puts a window on screen,
  // and `open` is what gives a bundled app a normal activation. Synchronously,
  // because `open` exits as soon as it has handed the bundle over — and when
  // it refuses one, that exit code is the only account of why (ct-49674).
  runOpen(["-n", appPath, "--args", ...args], "open the permission settings window");
  return { ...base, launchedHelper: true };
}

/**
 * Kill a setup window that is already open, so the new one is the only one.
 *
 * The patterns deliberately do NOT match `--permission-status-file`: a status
 * probe running concurrently must survive, or `permissions --id` would race
 * its own status read.
 */
function closeExistingSetupHelpers(): void {
  for (const flag of ["--permission", "--permissions"]) {
    spawnSync("/usr/bin/pkill", ["-f", `codecast-computer[[:space:]]+${flag}([[:space:]]|$)`], { stdio: "ignore", timeout: 10_000 });
  }
}

export interface PermissionResetResult extends ComputerPermissionStatusResult {
  bundleId: string;
}

/** Clear both TCC rows for the helper's stable identity. macOS keeps them
 *  after an uninstall, so a stale deny needs an explicit way out. */
export async function resetPermissions(): Promise<PermissionResetResult> {
  if (process.platform !== "darwin") return { ...unsupported(), bundleId: HELPER_BUNDLE_ID };
  const status = await getPermissionStatus();
  if (status.helperUnavailableReason) throw new ComputerError("accessibility_error", status.helperUnavailableReason);
  const bundleId = readBundleId(status.helperAppPath ?? helperAppPath());
  closeExistingSetupHelpers();
  for (const service of ["Accessibility", "ScreenCapture"]) resetTcc(service, bundleId);
  return { ...(await getPermissionStatus()), bundleId };
}

function readBundleId(appPath: string): string {
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", path.join(appPath, "Contents", "Info.plist")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
  const id = result.status === 0 ? (result.stdout ?? "").trim() : "";
  return id || HELPER_BUNDLE_ID;
}

function resetTcc(service: string, bundleId: string): void {
  const result = spawnSync("/usr/bin/tccutil", ["reset", service, bundleId], { encoding: "utf8", timeout: 30_000 });
  if (result.status === 0) return;
  const detail = (result.stderr || result.stdout || `exit ${result.status ?? "unknown"}`).trim();
  throw new ComputerError("accessibility_error", `could not reset ${service}: ${detail}`);
}

export function nextPermissionStep(status: ComputerPermissionStatusResult): string | null {
  const missing = status.permissions.find((p) => p.status !== "granted");
  if (!missing) return null;
  // Why: the read is now the whole of a bare `cast computer permissions`
  // (ct-49667), so its one next step has to name the real obstacle. Telling an
  // agent to grant Accessibility to an app that is not on the machine, or to a
  // feature that does not exist on this platform, sends it to System Settings
  // to look for a row that is not there.
  if (missing.status === "unsupported") return `cast computer is macOS only; this is ${status.platform}.`;
  if (status.helperUnavailableReason) return `No grant can be read yet: ${status.helperUnavailableReason}`;
  const label = missing.id === "accessibility" ? "Accessibility" : "Screen Recording";
  return `Grant ${label} to codecast computer, then retry get-app-state.`;
}

/** The human-readable report for `cast computer permissions`. */
export function formatPermissionsReport(status: ComputerPermissionStatusResult): string[] {
  const lines = ["Computer permissions checked."];
  if (status.helperAppPath) lines.push(`  Helper app: ${status.helperAppPath}`);
  if (status.helperUnavailableReason) lines.push(`  Helper: ${status.helperUnavailableReason}`);
  lines.push(`  Permissions: ${status.permissions.map((p) => `${p.id}=${p.status}`).join(", ")}`);
  const next = nextPermissionStep(status);
  if (next) lines.push(`  Next: ${next}`);
  return lines;
}

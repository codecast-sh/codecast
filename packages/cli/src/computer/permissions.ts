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
import { spawn, spawnSync } from "../proc.js";
import { ComputerError } from "./errors.js";
import { resolveCastInvocation } from "../castInvocation.js";
import { HELPER_BUNDLE_ID, helperAppPath, helperExecutablePath } from "./helperApp.js";
import type { ComputerPermissionId, ComputerPermissionStatus, ComputerPermissionStatusResult } from "./types.js";

const STATUS_POLL_ATTEMPTS = 50;
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
   *  takes one of the two routes above, never an in-process exec. */
  launch?: (appPath: string, statusPath: string) => void;
}

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
  try {
    (opts.launch ?? launchStatusProbe)(appPath, statusPath);
    for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt++) {
      const raw = readStatusFile(statusPath);
      if (raw) {
        return {
          platform: process.platform,
          helperAppPath: appPath,
          helperUnavailableReason: null,
          permissions: PERMISSION_IDS.map((id) => ({ id, status: normalizeStatus(raw[id]) })),
        };
      }
      await sleep(STATUS_POLL_INTERVAL_MS);
    }
    throw new ComputerError("accessibility_error", "timed out checking permissions");
  } finally {
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

function useOpenRoute(): boolean {
  return process.env.CODECAST_COMPUTER_PERMISSION_ROUTE === "open" || process.env.CODECAST_NO_DISCLAIM === "1";
}

function launchStatusProbe(appPath: string, statusPath: string): void {
  const args = ["--permission-status-file", statusPath];
  const child = useOpenRoute()
    ? spawn("/usr/bin/open", ["-n", appPath, "--args", ...args], { detached: true, stdio: "ignore" })
    : spawnDisclaimed(appPath, args);
  child.unref();
}

function spawnDisclaimed(appPath: string, args: string[]) {
  const cast = resolveCastInvocation();
  return spawn(cast.cmd, [...cast.prefixArgs, "_disclaimed", "--", helperExecutablePath(appPath), ...args], {
    detached: true,
    stdio: "ignore",
  });
}

export interface PermissionSetupResult extends ComputerPermissionStatusResult {
  permissionId?: ComputerPermissionId;
  launchedHelper: boolean;
  nextStep: string | null;
}

/**
 * Open the System Settings pane for one grant, through the helper's own setup
 * window (it shows the drag instruction beside the deep link).
 *
 * With no `--id` and nothing missing this launches nothing: an agent running
 * `permissions` to check should not put a window on the human's screen.
 */
export async function openPermissionSettings(permissionId?: ComputerPermissionId): Promise<PermissionSetupResult> {
  if (permissionId && !PERMISSION_IDS.includes(permissionId)) {
    throw new ComputerError("invalid_argument", '--id must be "accessibility" or "screenshots"');
  }
  const status = await getPermissionStatus();
  const nextStep = nextPermissionStep(status);
  if (process.platform !== "darwin") return { ...status, permissionId, launchedHelper: false, nextStep };
  if (status.helperUnavailableReason) throw new ComputerError("accessibility_error", status.helperUnavailableReason);
  if (!permissionId && !nextStep) return { ...status, permissionId, launchedHelper: false, nextStep };

  closeExistingSetupHelpers();
  const appPath = status.helperAppPath ?? helperAppPath();
  const args = permissionId ? ["--permission", permissionId] : ["--permissions"];
  // LaunchServices, not a disclaimed spawn: this mode puts a window on screen,
  // and `open` is what gives a bundled app a normal activation.
  const helper = spawn("/usr/bin/open", ["-n", appPath, "--args", ...args], { detached: true, stdio: "ignore" });
  helper.unref();
  return { ...status, permissionId, launchedHelper: true, nextStep };
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

/**
 * `xcrun simctl` and `axe` as functions. They behave the same wherever the
 * caller runs: a laptop terminal, an agent under the laptop daemon, or an agent
 * under a cloud Mac's codecast service (a system LaunchDaemon). CoreSimulator
 * starts its service in the user's own launchd domain from any of those, so
 * nothing here needs a GUI login or a domain hop (measured on the AWS Mac,
 * 2026-10-05: a cold boot, screenshot and describe-ui from a LaunchDaemon).
 */

import * as fs from "node:fs";
import { spawnSync } from "../proc.js";
import { readPool, writePool, type PoolDevice } from "./pool.js";

export interface RunResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], opts: { timeoutMs?: number; input?: string } = {}): RunResult {
  const r = spawnSync(cmd, args, {
    encoding: "utf-8",
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
    input: opts.input,
    stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const stderr = (r.stderr ?? "").split("\n").filter((l) => !/^objc\[\d+\]: Class .* is implemented in both/.test(l)).join("\n").trim();
  return { ok: r.status === 0 && !r.error, status: r.status, stdout: r.stdout ?? "", stderr: r.error ? `${stderr}\n${r.error.message}`.trim() : stderr };
}

export function simctl(args: string[], opts?: { timeoutMs?: number; input?: string }): RunResult {
  return run("xcrun", ["simctl", ...args], opts);
}

/** The failure text of a run, for an error message. */
export function why(r: RunResult): string {
  return (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ") || `exit ${r.status}`;
}

export function hasSimctl(): boolean {
  return process.platform === "darwin" && spawnSync("xcrun", ["--find", "simctl"], { stdio: "ignore" }).status === 0;
}

/** The axe binary: AXE_BIN, else the first on PATH or in Homebrew's prefixes. */
export function axeBin(): string | undefined {
  if (process.env.AXE_BIN) return process.env.AXE_BIN;
  for (const dir of [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    if (dir && fs.existsSync(`${dir}/axe`)) return `${dir}/axe`;
  }
  return undefined;
}

export function axe(args: string[], opts?: { timeoutMs?: number }): RunResult {
  const bin = axeBin();
  if (!bin) return { ok: false, status: null, stdout: "", stderr: "axe is not installed (brew install cameroncooke/axe/axe, or `cast hosts setup` on a cloud Mac)" };
  return run(bin, args, opts);
}

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  available: boolean;
}

export function listDevices(): SimDevice[] {
  const r = simctl(["list", "devices", "-j"]);
  if (!r.ok) throw new Error(`simctl list failed: ${why(r)}`);
  const out: SimDevice[] = [];
  for (const [runtime, devices] of Object.entries<any[]>(JSON.parse(r.stdout).devices ?? {})) {
    for (const d of devices) out.push({ udid: d.udid, name: d.name, state: d.state, runtime: runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, ""), available: d.isAvailable !== false });
  }
  return out;
}

export interface SimRuntime {
  identifier: string;
  name: string;
  platform: string;
  version: string;
  available: boolean;
  deviceTypes: Array<{ identifier: string; name: string; productFamily?: string }>;
}

export function listRuntimes(): SimRuntime[] {
  const r = simctl(["list", "runtimes", "-j"]);
  if (!r.ok) throw new Error(`simctl list runtimes failed: ${why(r)}`);
  return (JSON.parse(r.stdout).runtimes ?? []).map((rt: any) => ({
    identifier: rt.identifier,
    name: rt.name,
    platform: rt.platform ?? rt.name.split(" ")[0],
    version: rt.version,
    available: rt.isAvailable !== false,
    deviceTypes: rt.supportedDeviceTypes ?? [],
  }));
}

const versionKey = (v: string) => v.split(".").map((n) => n.padStart(4, "0")).join(".");

/** The newest available iOS runtime and the iPhone a pool is built from (the newest plain "Pro", else the newest iPhone). */
export function pickIphone(runtimes: SimRuntime[]): { runtime: SimRuntime; deviceType: { identifier: string; name: string } } | undefined {
  const ios = runtimes.filter((r) => r.available && r.platform === "iOS").sort((a, b) => versionKey(b.version).localeCompare(versionKey(a.version)));
  for (const runtime of ios) {
    const phones = runtime.deviceTypes.filter((t) => /^iPhone/.test(t.name));
    const pro = phones.filter((t) => /^iPhone \d+ Pro$/.test(t.name));
    const deviceType = pro[pro.length - 1] ?? phones[phones.length - 1];
    if (deviceType) return { runtime, deviceType };
  }
  return undefined;
}

export const DEFAULT_POOL_SIZE = 3;

/**
 * The pool, created when this machine has none: `size` iPhones named
 * "Codecast 1…n" on the newest iOS runtime, written to ~/.codecast/sim/pool.json.
 * Devices of that name that already exist are reused, so a lost pool file never
 * multiplies devices.
 */
export function ensurePool(size = DEFAULT_POOL_SIZE): PoolDevice[] {
  const pool = readPool();
  if (pool.length) return pool;
  if (!hasSimctl()) throw new Error("no simulators on this machine: Xcode is not installed (on a cloud Mac, `cast hosts setup` installs it)");
  const pick = pickIphone(listRuntimes());
  if (!pick) throw new Error("no iOS simulator runtime is installed: run `xcodebuild -downloadPlatform iOS`");
  const existing = listDevices();
  const devices: PoolDevice[] = [];
  for (let i = 1; i <= size; i++) {
    const name = `Codecast ${i}`;
    const found = existing.find((d) => d.name === name && d.available);
    if (found) { devices.push({ udid: found.udid, name }); continue; }
    const r = simctl(["create", name, pick.deviceType.identifier, pick.runtime.identifier]);
    if (!r.ok) throw new Error(`could not create ${name} (${pick.deviceType.name}, ${pick.runtime.name}): ${why(r)}`);
    devices.push({ udid: r.stdout.trim(), name });
  }
  writePool(devices);
  return devices;
}

export function deviceState(udid: string): string | undefined {
  return listDevices().find((d) => d.udid === udid)?.state;
}

/** Boot (when not booted) and wait until the device has finished booting. */
export function boot(udid: string, timeoutMs = 600_000): void {
  const state = deviceState(udid);
  if (state === undefined) throw new Error(`no simulator ${udid} on this machine`);
  if (state !== "Booted") {
    const r = simctl(["boot", udid], { timeoutMs });
    if (!r.ok && !/current state: Booted/i.test(r.stderr)) throw new Error(`boot failed: ${why(r)}`);
  }
  const s = simctl(["bootstatus", udid, "-b"], { timeoutMs });
  if (!s.ok) throw new Error(`the simulator did not finish booting: ${why(s)}`);
}

export function shutdown(udid: string): boolean {
  const r = simctl(["shutdown", udid]);
  return r.ok || /current state: Shutdown/i.test(r.stderr);
}

/** The bundle id of an .app directory (its Info.plist). */
export function bundleIdOf(appPath: string): string | undefined {
  const r = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", `${appPath.replace(/\/$/, "")}/Info.plist`], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/** Screenshot to `file` (PNG, device pixels). */
export function screenshot(udid: string, file: string): void {
  const r = simctl(["io", udid, "screenshot", "--type=png", file], { timeoutMs: 60_000 });
  if (!r.ok) throw new Error(`screenshot failed: ${why(r)}`);
}

/**
 * Shut down pool simulators nobody is using. The daemon runs this on its reap
 * cadence on every Mac, laptop and cloud host alike (`cast sim reap` runs one
 * pass by hand).
 *
 * A pool simulator is an orphan when it is Booted and nothing owns it: its lock
 * is free or STALE, no app inside it was launched within the grace period or is
 * using CPU, and a person is not looking at it (Simulator.app frontmost on that
 * device). Each pass stamps a first-seen marker; the device is shut down only
 * when a marker from an earlier pass has aged past the grace period, so a
 * simulator booted moments before an acquire is never reaped. A stale lock goes
 * with the shutdown so the next acquire sees a free pool.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "../proc.js";
import { lockDir, poolStatus, readPool, releaseLock, type PoolEntry } from "./pool.js";
import { hasSimctl, listDevices, shutdown } from "./simctl.js";

export const REAP_GRACE_SECS = 600;
/** An app at rest idles near 1% (heartbeats); 5% means someone is driving it. */
const BUSY_CPU = 5;

export function etimeSecs(etime: string): number {
  let rest = etime.trim();
  let days = 0;
  const dash = rest.indexOf("-");
  if (dash >= 0) { days = parseInt(rest.slice(0, dash), 10) || 0; rest = rest.slice(dash + 1); }
  const parts = rest.split(":").map((n) => parseInt(n, 10) || 0);
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0] ?? 0, parts[1] ?? 0];
  return days * 86400 + h * 3600 + m * 60 + s;
}

/** Whether `ps -axo pid=,pcpu=,etime=,args=` shows an app of this device launched recently or burning CPU. */
export function deviceBusy(psOutput: string, udid: string, graceSecs: number): boolean {
  const needle = `CoreSimulator/Devices/${udid}/data/Containers/Bundle/`;
  for (const line of psOutput.split("\n")) {
    if (!line.includes(needle)) continue;
    const [, pcpu, etime] = line.trim().split(/\s+/);
    if (parseFloat(pcpu) >= BUSY_CPU) return true;
    if (etimeSecs(etime) < graceSecs) return true;
  }
  return false;
}

/** skip clears any strike; wait keeps a strike that has not aged past the grace period yet. */
export type ReapAction = "skip" | "strike" | "wait" | "reap" | "clear-stale";

/** What one pass does with one pool device: the pure decision, for tests. */
export function reapDecision(e: { state: PoolEntry["state"]; booted: boolean; watched: boolean; busy: boolean; seenAt?: number }, now: number, graceSecs = REAP_GRACE_SECS): ReapAction {
  if (!e.booted) return e.state === "stale" ? "clear-stale" : "skip";
  if (e.state === "held" || e.watched || e.busy) return "skip";
  if (e.seenAt === undefined) return "strike";
  return now - e.seenAt >= graceSecs ? "reap" : "wait";
}

export interface ReapReport {
  reaped: string[];
  struck: string[];
  cleared: string[];
}

export function reapIdleSimulators(opts: { graceSecs?: number; log?: (m: string) => void } = {}): ReapReport {
  const report: ReapReport = { reaped: [], struck: [], cleared: [] };
  const pool = readPool();
  if (!pool.length || !hasSimctl()) return report;
  const grace = opts.graceSecs ?? REAP_GRACE_SECS;
  const dir = lockDir();
  const booted = new Set(listDevices().filter((d) => d.state === "Booted").map((d) => d.udid));
  const ps = spawnSync("ps", ["-axo", "pid=,pcpu=,etime=,args="], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }).stdout ?? "";
  const front = spawnSync("osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'], { encoding: "utf-8", timeout: 10_000 }).stdout?.trim();
  const current = front === "Simulator" ? spawnSync("defaults", ["read", "com.apple.iphonesimulator", "CurrentDeviceUDID"], { encoding: "utf-8" }).stdout?.trim() : undefined;
  const now = Math.floor(Date.now() / 1000);
  for (const entry of poolStatus(pool, dir)) {
    const marker = path.join(dir, `${entry.udid}.orphan-seen`);
    let seenAt: number | undefined;
    try { seenAt = parseInt(fs.readFileSync(marker, "utf-8"), 10) || undefined; } catch {}
    const isBooted = booted.has(entry.udid);
    const action = reapDecision({ state: entry.state, booted: isBooted, watched: current === entry.udid, busy: isBooted && deviceBusy(ps, entry.udid, grace), seenAt }, now, grace);
    if (action === "skip" || action === "clear-stale") fs.rmSync(marker, { force: true });
    if (action === "clear-stale") {
      releaseLock(entry.udid, dir);
      report.cleared.push(entry.udid);
      opts.log?.(`cleared stale lock on ${entry.name} (${entry.udid}), not booted`);
    } else if (action === "strike") {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(marker, String(now));
      report.struck.push(entry.udid);
      opts.log?.(`orphan candidate ${entry.name} (${entry.udid}): booted, lock ${entry.state}, no app activity`);
    } else if (action === "reap") {
      if (shutdown(entry.udid)) {
        report.reaped.push(entry.udid);
        opts.log?.(`reaped ${entry.name} (${entry.udid}), orphaned ${now - (seenAt ?? now)}s, lock was ${entry.state}`);
      }
      if (entry.state === "stale") releaseLock(entry.udid, dir);
      fs.rmSync(marker, { force: true });
    }
  }
  return report;
}

/**
 * `cast check-status`: the typecheck watchers on this machine, the memory
 * they hold against the budget that admits them, and what each (repo,
 * project) has been learned to need (watcherMemory.ts).
 */

import * as os from "node:os";
import * as path from "node:path";
import { coldBuildCap, isColdBuild, listWatchers, machineCapacity } from "./check.js";
import { machineCap } from "./machineCaps.js";
import { fmtGb, learnedSizes, MIN_SAMPLES, procTable, reserveBytes, treeRssBytes, type LearnedSize, type MachineMemory } from "./watcherMemory.js";

export interface WatcherStatus {
  totalBytes: number;
  /** What watchers may hold now: measured, never above capBytes. */
  budgetBytes: number;
  /** Total memory less reserveBytes. */
  capBytes: number;
  reserveBytes: number;
  /** What the machine could give when measured; null when it could not be read. */
  memory: MachineMemory | null;
  pressure: boolean;
  ceilingBytes: number;
  coldBytes: number;
  maxWatchers: number;
  heldBytes: number;
  /** Watchers still on their first pass, and how many may run at once (checkCapacity.ts). */
  coldBuilds: number;
  coldCap: number;
  watchers: Array<{ project: string; root: string; pid: number; checking: boolean; errors?: number; finishedAt?: number; rssBytes: number; holdBytes: number }>;
  learned: LearnedSize[];
}

export function watcherStatus(): WatcherStatus {
  const table = procTable();
  const live = listWatchers();
  const cap = machineCapacity(process.cwd(), "", machineCap("check"), table);
  const watchers = live.map((w) => ({
    project: w.project, root: w.root, pid: w.pid, checking: w.inProgress, errors: w.errors, finishedAt: w.finishedAt,
    rssBytes: treeRssBytes(w.pid, table), holdBytes: cap.holdOf!(w),
  }));
  return {
    totalBytes: os.totalmem(),
    budgetBytes: cap.budgetBytes,
    capBytes: cap.capBytes,
    reserveBytes: reserveBytes(),
    memory: cap.memory,
    pressure: cap.pressure,
    ceilingBytes: cap.ceilingBytes,
    coldBytes: cap.coldBytes,
    maxWatchers: cap.maxWatchers,
    heldBytes: watchers.reduce((a, w) => a + w.holdBytes, 0),
    coldBuilds: live.filter(isColdBuild).length,
    coldCap: coldBuildCap(),
    watchers,
    learned: learnedSizes(cap.ceilingBytes, cap.coldBytes),
  };
}

const ago = (at: number, now: number): string => {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

const table = (rows: string[][]): string[] => {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => `  ${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ")}`.trimEnd());
};

export function renderWatcherStatus(s: WatcherStatus, now = Date.now()): string {
  const measured = s.memory
    ? `${fmtGb(s.memory.availableBytes)} available now, swap ${fmtGb(s.memory.swapUsedBytes)} of ${fmtGb(s.memory.swapTotalBytes)} used${s.pressure ? ", under memory pressure: a new watcher only replaces old ones" : ""}; `
    : "memory available now unreadable; ";
  const lines = [
    `Typecheck memory  ${fmtGb(s.heldBytes)} reserved of ${fmtGb(s.budgetBytes)}  (${fmtGb(s.totalBytes)} machine: ${measured}never above ${fmtGb(s.capBytes)}, ${fmtGb(s.reserveBytes)} kept for everything else; up to ${s.maxWatchers} watchers as memory allows)`,
    `Cold builds       ${s.coldBuilds}/${s.coldCap} running  (first passes; more wait in the queue, a project past 8 GB counts as two)`,
  ];
  if (s.watchers.length) {
    lines.push("", "Watchers");
    lines.push(...table(s.watchers.map((w) => [
      w.project, w.root, `pid ${w.pid}`, fmtGb(w.rssBytes), `reserves ${fmtGb(w.holdBytes)}`,
      w.checking ? "checking" : `${w.errors ?? "?"} errors, ${w.finishedAt ? ago(w.finishedAt, now) : "no pass yet"}`,
    ])));
  } else {
    lines.push("", "No typecheck watchers running");
  }
  if (s.learned.length) {
    lines.push("", `Learned sizes  (a new watcher reserves p95 x 1.25, or ${fmtGb(s.coldBytes)} until ${MIN_SAMPLES} clean passes are known)`);
    lines.push(...table(s.learned.map((l) => [
      path.basename(l.repo), l.project, `${l.samples} pass${l.samples === 1 ? "" : "es"}`,
      l.p95Bytes === null ? "p95 -" : `p95 ${fmtGb(l.p95Bytes)}`,
      `reserves ${fmtGb(l.reservationBytes)}${l.warm ? "" : " (learning)"}`,
      `last ${fmtGb(l.lastBytes)} ${ago(l.lastAt, now)}${l.ooms ? `, ${l.ooms} out of memory` : ""}`,
    ])));
  }
  lines.push("", "Change it: cast config check.reserve_gb <n> · check.per_machine <n>");
  return lines.join("\n");
}

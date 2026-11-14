/**
 * `cast check-status`: the typecheck watchers on this machine, the memory
 * they hold against the budget that admits them, and what each (repo,
 * project) has been learned to need (watcherMemory.ts).
 */

import * as os from "node:os";
import * as path from "node:path";
import { listWatchers, machineCapacity } from "./check.js";
import { machineCap } from "./machineCaps.js";
import { fmtGb, learnedSizes, MIN_SAMPLES, procTable, reserveBytes, treeRssBytes, type LearnedSize } from "./watcherMemory.js";

export interface WatcherStatus {
  totalBytes: number;
  budgetBytes: number;
  reserveBytes: number;
  ceilingBytes: number;
  coldBytes: number;
  maxWatchers: number;
  minWatchers: number;
  heldBytes: number;
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
    reserveBytes: reserveBytes(),
    ceilingBytes: cap.ceilingBytes,
    coldBytes: cap.coldBytes,
    maxWatchers: cap.maxWatchers,
    minWatchers: cap.minWatchers,
    heldBytes: watchers.reduce((a, w) => a + w.holdBytes, 0),
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
  const lines = [
    `Typecheck memory  ${fmtGb(s.heldBytes)} reserved of ${fmtGb(s.budgetBytes)}  (${fmtGb(s.totalBytes)} machine, ${fmtGb(s.reserveBytes)} kept for everything else; ${s.minWatchers} watchers always run, up to ${s.maxWatchers} as memory allows)`,
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

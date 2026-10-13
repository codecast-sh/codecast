// `cast bench boot`: what a command costs before it does any work.
//
// Two meters, because they answer different questions. The static import graph
// (bootGraph.ts) is the cause — every module reachable from the entry without
// an `await import()` is loaded and evaluated before the first statement runs,
// and that number is deterministic. The clock is the effect.
//
// The clock measures CPU (user + sys), not wall time. An agent box runs dozens
// of sessions; wall time on a loaded one swings 30% between identical runs,
// which is wider than anything this bench is trying to see, while CPU time on
// the same runs holds to about 5%. Reported as the median of N runs.
//
// Every run gets an empty HOME, so nothing finds a config, a daemon or a token
// and nothing reaches the network: what is left on the clock is the module
// graph and commander, which is what the bench is about.

import { spawnSync } from "../proc.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildBootGraph, exclusiveTo, repoRootFrom } from "./bootGraph.js";

export interface BootSample {
  argv: string[];
  runs: number;
  medianCpuMs: number;
  minCpuMs: number;
  maxCpuMs: number;
}

export interface BootBenchReport {
  entry: string;
  /** What was actually timed — the source entry under bun, or a compiled binary. */
  runner: string[];
  graph: { modules: number; kilobytes: number; packages: number };
  heaviest: Array<{ file: string; exclusiveModules: number }>;
  samples: BootSample[];
}

/** The three shapes the lazy-group work is about: help, a group that is one
 *  dynamic import away, and a typo. None of them should pay for the CLI. */
export const BOOT_BENCH_ARGV: string[][] = [["--help"], ["state"], ["bogus"]];

/** CPU milliseconds one run spent, via /usr/bin/time. NaN when it is absent. */
function cpuMsOnce(runner: readonly string[], argv: readonly string[], cwd: string, home: string): number {
  const r = spawnSync("/usr/bin/time", ["-p", ...runner, ...argv], {
    cwd,
    env: { ...process.env, HOME: home, NO_COLOR: "1" },
    encoding: "utf8",
  });
  const text = r.stderr ?? "";
  const user = Number.parseFloat(/^user\s+([\d.]+)/m.exec(text)?.[1] ?? "");
  const sys = Number.parseFloat(/^sys\s+([\d.]+)/m.exec(text)?.[1] ?? "");
  return (user + sys) * 1000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function graphSummary(entry: string): Pick<BootBenchReport, "graph" | "heaviest"> {
  const graph = buildBootGraph(entry);
  const root = repoRootFrom(path.resolve(entry));
  const entryNode = graph.nodes.get(graph.entry)!;
  return {
    graph: { modules: graph.nodes.size, kilobytes: Math.round(graph.totalBytes / 1024), packages: graph.externals.size },
    heaviest: entryNode.imports
      .map((file) => ({ file: path.relative(root, file), exclusiveModules: exclusiveTo(graph, file).size }))
      .filter((row) => row.exclusiveModules > 1)
      .sort((a, b) => b.exclusiveModules - a.exclusiveModules)
      .slice(0, 12),
  };
}

export function runBootBench(opts: {
  entry: string;
  runner: readonly string[];
  cwd: string;
  runs: number;
  argvs?: readonly string[][];
}): BootBenchReport {
  const summary = graphSummary(opts.entry);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-boot-bench-"));
  const samples: BootSample[] = [];
  try {
    for (const argv of opts.argvs ?? BOOT_BENCH_ARGV) {
      cpuMsOnce(opts.runner, argv, opts.cwd, home); // warm the file cache; not recorded
      const times = Array.from({ length: opts.runs }, () => cpuMsOnce(opts.runner, argv, opts.cwd, home));
      samples.push({
        argv: [...argv],
        runs: opts.runs,
        medianCpuMs: Math.round(median(times)),
        minCpuMs: Math.round(Math.min(...times)),
        maxCpuMs: Math.round(Math.max(...times)),
      });
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  return { entry: opts.entry, runner: [...opts.runner], ...summary, samples };
}

export function renderBootBench(report: BootBenchReport): string {
  const lines = [
    `entry     ${report.entry}`,
    `runner    ${report.runner.join(" ")}`,
    `graph     ${report.graph.modules} source files, ${report.graph.kilobytes} KB, ${report.graph.packages} packages`,
    "",
    "| command | runs | median cpu ms | min | max |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const s of report.samples) {
    lines.push(`| cast ${s.argv.join(" ")} | ${s.runs} | ${s.medianCpuMs} | ${s.minCpuMs} | ${s.maxCpuMs} |`);
  }
  if (report.heaviest.length) {
    lines.push("", "heaviest direct imports, by modules only they pull in:");
    for (const h of report.heaviest) lines.push(`  ${String(h.exclusiveModules).padStart(4)}  ${h.file}`);
  }
  return lines.join("\n");
}

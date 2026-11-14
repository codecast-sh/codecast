#!/usr/bin/env bun
/**
 * What one `cast computer` process costs around the helper's own work.
 *
 *   bun scripts/computer-startup-bench.ts run --cli base='bun /path/a/src/main.ts' --cli new='bun src/main.ts' \
 *       [--runs 15] [--app com.apple.finder] --out /tmp/cc-startup/x.json
 *   bun scripts/computer-startup-bench.ts compare a.json b.json
 *   bun scripts/computer-startup-bench.ts stop-helper
 *
 * computer-bench.ts measures the helper and deliberately skips argv. This is
 * the other half: exec to exit of the real command, run as an agent runs it,
 * minus the same request made over an already-open connection. The difference
 * is what every agent step pays before and after the helper answers.
 *
 * Several CLIs are measured in one run, round robin, so a load swing on this
 * machine lands on every variant alike instead of on whichever ran second.
 * Everything here talks to the INSTALLED helper: hold the helper slot lock.
 *
 * A helper serves only the executable that first drove it (the peer check in
 * SocketHandshake.swift), so a compiled CLI and `bun src/main.ts` cannot share
 * one. To time a compiled CLI: `stop-helper`, run it alone with
 * `--helper-from <a source run's report>` (this process is bun, so its own
 * helper timing would be refused), then `stop-helper` again so the next bun
 * caller relaunches a helper of its own.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { cpus, loadavg } from "node:os";

import { ComputerClient } from "../src/computer/client.js";

type Row = { name: string; ms: number[] };
type Report = { at: string; load: number[]; runs: number; app: string; clis: Record<string, string>; rows: Row[] };

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === `--${name}` && args[i + 1] !== undefined) out.push(args[++i]!);
  return out;
}

/** The commands each CLI runs. Output goes nowhere: the cost of printing it is
 *  the terminal's, not the CLI's, and the text is checked once up front. */
function commands(app: string): Record<string, string[]> {
  return {
    version: ["--version"],
    "list-apps": ["computer", "list-apps"],
    "get-app-state": ["computer", "get-app-state", "--app", app, "--no-screenshot"],
  };
}

function exec(cli: string, args: string[]): { ms: number; status: number | null; out: string; err: string } {
  const [bin, ...pre] = cli.split(" ").filter(Boolean);
  const started = performance.now();
  const r = spawnSync(bin!, [...pre, ...args], { encoding: "utf-8", maxBuffer: 64 << 20 });
  return { ms: performance.now() - started, status: r.status, out: r.stdout, err: r.stderr };
}

/** The same requests over one warm connection: the helper's share of a call. */
async function helperTimes(app: string, runs: number): Promise<Row[]> {
  const client = new ComputerClient();
  try {
    await client.capabilities();
    const apps: number[] = [];
    const state: number[] = [];
    for (let i = 0; i < runs; i++) {
      let t = performance.now();
      await client.listApps();
      apps.push(performance.now() - t);
      t = performance.now();
      await client.getAppState({ app, noScreenshot: true });
      state.push(performance.now() - t);
    }
    return [
      { name: "helper:list-apps", ms: apps },
      { name: "helper:get-app-state", ms: state },
    ];
  } finally {
    client.shutdown();
  }
}

async function run(args: string[]): Promise<void> {
  const clis = Object.fromEntries(
    flags(args, "cli").map((spec) => {
      const at = spec.indexOf("=");
      if (at <= 0) throw new Error(`--cli takes name=command, got ${spec}`);
      return [spec.slice(0, at), spec.slice(at + 1)];
    }),
  );
  if (!Object.keys(clis).length) clis.src = `bun ${path.join(import.meta.dir, "..", "src", "main.ts")}`;
  const runs = Number(flags(args, "runs")[0] ?? 15);
  const app = flags(args, "app")[0] ?? "com.apple.finder";
  const out = flags(args, "out")[0];
  const helperFrom = flags(args, "helper-from")[0];
  const cmds = commands(app);

  // One untimed pass: proves each command works, and warms the helper and the
  // file cache so the first timed sample is not an outlier of its own.
  for (const [name, cli] of Object.entries(clis)) {
    for (const [cmd, argv] of Object.entries(cmds)) {
      const r = exec(cli, argv);
      if (r.status !== 0) throw new Error(`${name} ${cmd} exited ${r.status}: ${r.err.trim().slice(0, 400)}`);
    }
  }

  const samples = new Map<string, number[]>();
  const loadBefore = loadavg()[0]!;
  for (let i = 0; i < runs; i++) {
    for (const [cmd, argv] of Object.entries(cmds)) {
      for (const [name, cli] of Object.entries(clis)) {
        const key = `${name}:${cmd}`;
        const r = exec(cli, argv);
        if (r.status !== 0) throw new Error(`${key} exited ${r.status}: ${r.err.trim().slice(0, 400)}`);
        (samples.get(key) ?? samples.set(key, []).get(key)!).push(r.ms);
      }
    }
    process.stderr.write(`\r${i + 1}/${runs}`);
  }
  process.stderr.write("\n");
  const rows: Row[] = [...samples].map(([name, ms]) => ({ name, ms }));
  rows.push(
    ...(helperFrom
      ? (JSON.parse(fs.readFileSync(helperFrom, "utf-8")) as Report).rows.filter((r) => r.name.startsWith("helper:"))
      : await helperTimes(app, runs)),
  );

  const report: Report = { at: new Date().toISOString(), load: [loadBefore, loadavg()[0]!], runs, app, clis, rows };
  print(report);
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
  }
}

/** exec median, and for computer verbs the overhead: exec minus helper. */
function summarize(report: Report): Map<string, { exec: number; overhead?: number }> {
  const byName = new Map(report.rows.map((r) => [r.name, median(r.ms)]));
  const out = new Map<string, { exec: number; overhead?: number }>();
  for (const row of report.rows) {
    if (row.name.startsWith("helper:")) continue;
    const verb = row.name.slice(row.name.indexOf(":") + 1);
    const helper = byName.get(`helper:${verb}`);
    const exec = median(row.ms);
    out.set(row.name, { exec, overhead: helper === undefined ? undefined : exec - helper });
  }
  return out;
}

const fmtMs = (ms: number | undefined) => (ms === undefined || Number.isNaN(ms) ? "-" : `${Math.round(ms)} ms`);

function print(report: Report): void {
  console.log(`${report.at}  load ${report.load.map((l) => l.toFixed(0)).join("→")} on ${cpus().length} cores  runs ${report.runs}  app ${report.app}`);
  for (const [name, cli] of Object.entries(report.clis)) console.log(`  ${name} = ${cli}`);
  for (const row of report.rows.filter((r) => r.name.startsWith("helper:"))) console.log(`  ${row.name.padEnd(28)} ${fmtMs(median(row.ms)).padStart(9)}`);
  for (const [name, s] of summarize(report)) {
    console.log(`  ${name.padEnd(28)} exec ${fmtMs(s.exec).padStart(9)}   overhead ${fmtMs(s.overhead).padStart(9)}`);
  }
}

function compare(a: Report, b: Report): void {
  const sa = summarize(a);
  const sb = summarize(b);
  for (const [name, x] of sa) {
    const y = sb.get(name);
    if (!y) continue;
    const ratio = x.overhead && y.overhead ? `${(x.overhead / y.overhead).toFixed(1)}x` : "";
    console.log(`${name.padEnd(28)} overhead ${fmtMs(x.overhead).padStart(9)} → ${fmtMs(y.overhead).padStart(9)}  ${ratio}`);
  }
}

const [verb, ...rest] = process.argv.slice(2);
if (verb === "run") await run(rest);
else if (verb === "stop-helper") await new ComputerClient().terminate();
else if (verb === "compare" && rest.length === 2) {
  const [a, b] = rest.map((f) => JSON.parse(fs.readFileSync(f!, "utf-8")) as Report);
  compare(a!, b!);
} else {
  console.error("usage: computer-startup-bench.ts run [--cli name=command]... [--runs n] [--app id] [--helper-from report.json] [--out file] | compare a.json b.json | stop-helper");
  process.exit(2);
}

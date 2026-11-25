#!/usr/bin/env bun
// Splits a package's test files into CI shards of about equal run time, by the
// time each file took on a recent run (scripts/ci/test-times.json). `bun test
// --shard` splits by file count, and a few slow files then make one shard the
// whole run's tail: 49s to 136s across eight web shards on 2026-11-25.
//
//   bun scripts/ci/test-shards.ts <package> <k>/<n>   the files of shard k, one per line
//   bun scripts/ci/test-shards.ts --record <dir>...   rewrite test-times.json from JUnit
//                                                     reports (gh run download <run> -p 'junit-*')
//
// Every file lands in exactly one shard, recorded or not: a file with no
// recorded time counts as the median, so a stale record only costs balance.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const TIMES_PATH = join(import.meta.dir, "test-times.json");

/** What each package's test job hands bun, relative to the package: where it looks, and what its bunfig ignores. */
export const SUITES: Record<string, { roots: string[]; ignore: RegExp[] }> = {
  "packages/web": { roots: ["."], ignore: [] },
  "packages/cli": { roots: ["src"], ignore: [/^src\/computer\//] },
};

const TEST_FILE = /(\.test|_test|\.spec|_spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

function walk(dir: string, out: string[]): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (TEST_FILE.test(ent.name)) out.push(p);
  }
  return out;
}

export function testFiles(pkg: string): string[] {
  const suite = SUITES[pkg];
  if (!suite) throw new Error(`no suite for ${pkg}: one of ${Object.keys(SUITES).join(", ")}`);
  const dir = join(ROOT, pkg);
  return suite.roots
    .flatMap((r) => walk(join(dir, r), []))
    .map((p) => relative(dir, p))
    .filter((f) => !suite.ignore.some((re) => re.test(f)))
    .sort();
}

/** Longest first onto the least loaded shard. Deterministic: ties break by name. */
export function shard(files: string[], times: Record<string, number>, n: number): string[][] {
  const known = files.map((f) => times[f]).filter((t): t is number => t !== undefined).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const cost = (f: string) => times[f] ?? median;
  const order = [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b));
  const shards = Array.from({ length: n }, () => ({ load: 0, files: [] as string[] }));
  for (const f of order) {
    let min = shards[0];
    for (const s of shards) if (s.load < min.load) min = s;
    min.files.push(f);
    min.load += cost(f);
  }
  return shards.map((s) => s.files.sort());
}

/** File times from bun's JUnit report: one top-level <testsuite> per file. */
export function junitTimes(xml: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of xml.matchAll(/^ {2}<testsuite [^>]*>/gm)) {
    const file = /\bfile="([^"]+)"/.exec(m[0])?.[1];
    const time = /\btime="([^"]+)"/.exec(m[0])?.[1];
    if (file && time) out[file.replace(/&amp;/g, "&")] = Math.round(Number(time) * 10) / 10;
  }
  return out;
}

function readTimes(): Record<string, Record<string, number>> {
  try {
    return JSON.parse(readFileSync(TIMES_PATH, "utf8"));
  } catch {
    return {};
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--record") {
    const times = readTimes();
    for (const dir of args.slice(1)) {
      for (const ent of readdirSync(dir, { recursive: true }) as string[]) {
        if (!ent.endsWith(".xml")) continue;
        // Artifacts are named junit-<package>-<shard>, so the package rides in the path.
        const pkg = Object.keys(SUITES).find((p) => ent.includes(`junit-${p.split("/")[1]}-`) || dir.includes(`junit-${p.split("/")[1]}-`));
        if (!pkg) continue;
        Object.assign((times[pkg] ??= {}), junitTimes(readFileSync(join(dir, ent), "utf8")));
      }
    }
    for (const pkg of Object.keys(times)) {
      const live = new Set(testFiles(pkg));
      times[pkg] = Object.fromEntries(Object.entries(times[pkg]).filter(([f]) => live.has(f)).sort(([a], [b]) => a.localeCompare(b)));
    }
    writeFileSync(TIMES_PATH, `${JSON.stringify(times, null, 1)}\n`);
  } else {
    const [pkg, spec] = args;
    const [k, n] = (spec ?? "").split("/").map(Number);
    if (!pkg || !(k >= 1 && k <= n)) {
      console.error("usage: test-shards.ts <package> <k>/<n> | --record <dir>...");
      process.exit(2);
    }
    for (const f of shard(testFiles(pkg), readTimes()[pkg] ?? {}, n)[k - 1]) console.log(`./${f}`);
  }
}

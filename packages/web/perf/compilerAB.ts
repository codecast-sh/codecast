// React Compiler on against off, on one workload of the perf harness.
//
//   bun perf/compilerAB.ts                                  # switch, the allowlist in plugins/reactCompiler.ts
//   bun perf/compilerAB.ts --workload inbox-load --pairs 8 --runs 10
//   REACT_COMPILER_SOURCES=components/inbox/ bun perf/compilerAB.ts --workload inbox-load   # a candidate
//
// strobe (scripts/perf-bench.sh) compares two git refs; the compiler is the
// same tree under an environment variable, so this does the same kind of
// comparison directly. Each block is a fresh bun process that builds the
// workload, discards warm-up runs, then measures `--runs` runs. Blocks go in
// pairs with the order alternating (off on, on off, …), so drift in the
// machine lands on both sides. Per run it records:
//   cpu     CPU time of the process during the action (user + system), what
//           strobe calls cpu.work: React, the store, app code and jsdom
//   render  time React spent rendering in the action's commits (the harness's
//           Profiler), the part the compiler can change
//   counts  the harness's exact counts
// The verdict is the median over pairs of (on - off) of each block's median,
// with a bootstrap 95% interval; it says "no difference" when the interval
// holds zero. React runs its development build here (see README.md), and
// jsdom's DOM cost sits in cpu on both sides, so read the direction and the
// rough size, not the absolute milliseconds.
import type { Report, Workload } from "./harness";

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const workload = arg("workload", "switch") as Workload;
const runs = Number(arg("runs", "8"));
const pairs = Number(arg("pairs", "6"));
const WARMUP = 2;

type Block = { cpu: number[]; render: number[]; counts: Record<string, number>[] };

if (process.argv.includes("--child")) {
  // The compiled side must really be compiled: the harness loads the helper
  // quietly, and "on" against an accidental "off" would read as no difference.
  const { reactCompilerActive } = await import("../test-helpers/reactCompiler");
  if (reactCompilerActive !== (process.env.REACT_COMPILER === "1")) throw new Error("compilerAB: the compiler is not in the state this block asked for (is the allowlist empty?)");
  const { reset, run, setup } = await import("./harness");
  await setup(workload);
  for (let i = 0; i < WARMUP; i++) { await run(); await reset(); }
  const block: Block = { cpu: [], render: [], counts: [] };
  for (let i = 0; i < runs; i++) {
    const before = process.cpuUsage();
    const report: Report = await run();
    const used = process.cpuUsage(before);
    block.cpu.push((used.user + used.system) / 1000);
    block.render.push(Number(report.detail.renderMs?.[0] ?? 0));
    block.counts.push(report.counts);
    await reset();
  }
  console.log(`\n@@block ${JSON.stringify(block)}`);
  process.exit(0);
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// A shared checkout changes under a long run: a block that lands on another
// session's half-written file is tried again a few seconds later.
function block(on: boolean): Block {
  for (let attempt = 1; ; attempt++) {
    const child = Bun.spawnSync(["bun", import.meta.path, "--child", "--workload", workload, "--runs", String(runs)], {
      env: { ...process.env, REACT_COMPILER: on ? "1" : "0" }, stdout: "pipe", stderr: "pipe",
    });
    const line = child.stdout.toString().split("\n").find((l) => l.startsWith("@@block "));
    if (child.exitCode === 0 && line) return JSON.parse(line.slice("@@block ".length));
    const why = child.stderr.toString();
    if (attempt === 4) throw new Error(`compilerAB: the ${on ? "compiled" : "plain"} block failed ${attempt} times\n${why.slice(-2000)}`);
    process.stderr.write(`  (${on ? "compiled" : "plain"} block failed, trying again: ${why.match(/\w*Error: .*/)?.[0] ?? "no error line"})\n`);
    Bun.sleepSync(5000);
  }
}

// Deterministic resampling, so the same data gives the same interval.
function bootstrap(diffs: number[]): [number, number] {
  let seed = 0x2f6e2b1;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const medians: number[] = [];
  for (let i = 0; i < 4000; i++) medians.push(median(diffs.map(() => diffs[Math.floor(random() * diffs.length)])));
  medians.sort((a, b) => a - b);
  return [medians[Math.floor(medians.length * 0.025)], medians[Math.floor(medians.length * 0.975)]];
}

const { reactCompilerSources } = await import("../plugins/reactCompiler");
const os = await import("node:os");
console.log(`compiler A/B: workload ${workload}, ${pairs} pairs of blocks, ${runs} runs a block, load ${os.loadavg()[0].toFixed(1)} on ${os.cpus().length} CPUs`);
console.log(`compiled files: ${reactCompilerSources().join(", ") || "(none: the allowlist is empty)"}`);

const off: Block[] = [];
const on: Block[] = [];
for (let i = 0; i < pairs; i++) {
  if (i % 2 === 0) { off.push(block(false)); on.push(block(true)); } else { on.push(block(true)); off.push(block(false)); }
  process.stderr.write(`  pair ${i + 1}/${pairs}: cpu ${median(off[i].cpu).toFixed(1)} → ${median(on[i].cpu).toFixed(1)} ms, render ${median(off[i].render).toFixed(1)} → ${median(on[i].render).toFixed(1)} ms\n`);
}

for (const metric of ["cpu", "render"] as const) {
  const a = off.map((b) => median(b[metric]));
  const b = on.map((x) => median(x[metric]));
  const diffs = a.map((x, i) => b[i] - x);
  const [lo, hi] = bootstrap(diffs);
  const base = median(a);
  const d = median(diffs);
  const verdict = lo > 0 ? "compiler is SLOWER" : hi < 0 ? "compiler is faster" : "no difference";
  console.log(`${metric.padEnd(7)} off ${base.toFixed(1)} ms   on ${median(b).toFixed(1)} ms   diff ${d >= 0 ? "+" : ""}${d.toFixed(1)} ms (${((d / base) * 100).toFixed(1)}%)   95% [${lo.toFixed(1)}, ${hi.toFixed(1)}]   ${verdict}`);
}

// Counts: every run of every block, as "value xN". Timer-driven counts
// (commits, layout reads in the switch) spread on both sides; a count that
// moves only on one side is the compiler's doing.
const names = Object.keys(off[0].counts[0]);
const spread = (blocks: Block[], name: string) => {
  const seen = new Map<number, number>();
  for (const b of blocks) for (const c of b.counts) seen.set(c[name], (seen.get(c[name]) ?? 0) + 1);
  return [...seen].sort((x, y) => x[0] - y[0]).map(([v, n]) => `${v} x${n}`).join(", ");
};
console.log("counts (value x runs):");
for (const name of names) {
  const [a, b] = [spread(off, name), spread(on, name)];
  console.log(`  ${name.padEnd(17)} off ${a}${a === b ? "   (same on)" : `\n  ${"".padEnd(17)} on  ${b}`}`);
}

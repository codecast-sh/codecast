// Times the command palette's open and typing workloads (perf/harness.tsx)
// in one process: a warm-up, then each run's wall time, React render time and
// counts. Profile with `bun --cpu-prof-md --cpu-prof-dir=/tmp perf/palette.ts`.
//   bun perf/palette.ts [open|type|both] [runs]
const which = process.argv[2] ?? "both";
const runs = Number(process.argv[3] ?? 5);
const harness = await import("./harness");
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const workload of which === "both" ? ["palette-open", "palette-type"] : [`palette-${which}`]) {
  const t0 = performance.now();
  await harness.setup(workload as any);
  const setupMs = performance.now() - t0;
  const wall: number[] = [];
  const render: number[] = [];
  const cpu: number[] = [];
  const first: number[] = [];
  let last: any;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const c = process.cpuUsage();
    last = await harness.run();
    const used = process.cpuUsage(c);
    cpu.push((used.user + used.system) / 1000);
    wall.push(performance.now() - t);
    render.push(Number(last.detail.renderMs[0]));
    first.push(Number(last.detail.commitMs[0] ?? 0));
    await harness.reset();
  }
  console.log(JSON.stringify({ workload, setupMs: Math.round(setupMs), cpuMedian: Math.round(median(cpu)), wallMedian: Math.round(median(wall)), cpu: cpu.map(Math.round), renderMedian: Math.round(median(render)), firstCommitMedian: Math.round(median(first)), counts: last.counts, rendered: last.detail.rendered.slice(0, 12), subs: last.detail.subscribe }));
  if (which === "both") break;
}
process.exit(0);

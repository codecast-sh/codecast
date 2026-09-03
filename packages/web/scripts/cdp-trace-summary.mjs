const input = process.argv[2];
if (!input) throw new Error("Usage: bun scripts/cdp-trace-summary.mjs <trace.json>");

const trace = await Bun.file(input).json();
const events = trace.traceEvents ?? trace;
const threadNames = new Map();
for (const event of events) {
  if (event.ph === "M" && event.name === "thread_name") {
    threadNames.set(`${event.pid}:${event.tid}`, event.args?.name ?? "");
  }
}

const taskTotals = new Map();
for (const event of events) {
  if (event.ph !== "X" || event.name !== "RunTask" || !event.dur) continue;
  const key = `${event.pid}:${event.tid}`;
  taskTotals.set(key, (taskTotals.get(key) ?? 0) + event.dur);
}
const candidates = [...taskTotals]
  .filter(([key]) => threadNames.get(key) === "CrRendererMain")
  .sort((a, b) => b[1] - a[1]);
const [mainThread] = candidates[0] ?? [...taskTotals].sort((a, b) => b[1] - a[1])[0] ?? [];
if (!mainThread) throw new Error("No renderer main-thread tasks found");

const [pid, tid] = mainThread.split(":").map(Number);
const main = events.filter((event) => event.pid === pid && event.tid === tid && event.ph === "X" && event.dur);
const tasks = main.filter((event) => event.name === "RunTask");
const longTasks = tasks.filter((event) => event.dur >= 50_000).sort((a, b) => b.dur - a.dur);
const durationMs = (items) => items.reduce((sum, event) => sum + event.dur, 0) / 1000;
const rounded = (value) => Number(value.toFixed(1));
const byName = (pattern) => {
  const matched = main.filter((event) => pattern.test(event.name));
  return { count: matched.length, totalMs: rounded(durationMs(matched)) };
};
const allTimestamps = main.flatMap((event) => [event.ts, event.ts + event.dur]);
const minTs = Math.min(...allTimestamps);
const maxTs = Math.max(...allTimestamps);

console.log(JSON.stringify({
  input,
  thread: { pid, tid, name: threadNames.get(mainThread) },
  rangeMs: rounded((maxTs - minTs) / 1000),
  tasks: {
    count: tasks.length,
    totalMs: rounded(durationMs(tasks)),
    longCount: longTasks.length,
    longTotalMs: rounded(durationMs(longTasks)),
    longestMs: rounded((longTasks[0]?.dur ?? 0) / 1000),
    top: longTasks.slice(0, 10).map((event) => ({
      startMs: rounded((event.ts - minTs) / 1000),
      durationMs: rounded(event.dur / 1000),
    })),
  },
  gc: byName(/^(MajorGC|MinorGC|V8\.GC)/),
  script: byName(/^(EvaluateScript|v8\.evaluateModule|v8\.compile)/),
  layout: byName(/^(Layout|UpdateLayoutTree|RecalculateStyles)$/),
  paint: byName(/^(Paint|PrePaint|CompositeLayers)$/),
}, null, 2));

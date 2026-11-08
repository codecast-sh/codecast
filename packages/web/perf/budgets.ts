// The exact counts the perf benches (perf/web.bench.ts) hold, asserted
// (scripts/perf-budgets.sh). It runs under plain `bun`, not `bun test`: the
// test preload stands in for the diff viewer, and the budgets must hold for
// the modules strobe times. A
// count here has one right value: what the action must cost, independent of
// machine speed. Counts that follow wall time (commits and layout reads while
// the transcript's interval timers tick) are left to the A/B comparison.
// A failure prints what changed (the store keys written, the Convex
// functions asked); if the new value is intended, change it here and say why
// in the change.
// Each workload runs in a fresh process, as strobe runs every block: a world
// built earlier in the process (a module clock, a warmed cache) would leak
// into the next one's counts.
import { deepStrictEqual } from "node:assert/strict";
import type { Report, Workload } from "./harness";

const only = process.argv[2] as Workload | undefined;
if (!only) {
  let failed = 0;
  for (const workload of ["switch", "inbox-load", "inbox-heartbeat", "diff"]) {
    const child = Bun.spawnSync(["bun", import.meta.path, workload], { stdout: "inherit", stderr: "inherit" });
    if (child.exitCode !== 0) failed++;
  }
  process.exit(failed ? 1 : 0);
}
const { reset, run, setup } = await import("./harness");

const failures: string[] = [];
async function test(workload: Workload, name: string, fn: () => Promise<void>) {
  if (workload !== only) return;
  const t0 = performance.now();
  try {
    await fn();
    console.log(`pass  ${name} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name}\n${err instanceof Error ? err.message : String(err)}`);
  }
}
const expect = (actual: unknown) => ({ toEqual: (expected: unknown) => deepStrictEqual(actual, expected), toBe: (expected: unknown) => deepStrictEqual(actual, expected) });

const pick = (r: Report, keys: string[]) => Object.fromEntries(keys.map((k) => [k, r.counts[k]]));

async function twice(): Promise<Report[]> {
  const out: Report[] = [];
  for (let i = 0; i < 2; i++) {
    out.push(await run());
    await reset();
  }
  return out;
}

await test("switch", "a warm conversation switch fetches no history and opens the same 15 subscriptions each way", async () => {
  await setup("switch");
  for (const r of await twice()) {
    expect({ ...pick(r, ["convexQueries", "convexActions", "convexSubscribes", "storeWrites", "domMutations"]), asked: r.detail.query }).toEqual({
      // A cached window of 200 rows needs no snapshot, backfill or reread.
      convexQueries: 0, convexActions: 0, asked: [],
      // The destination's live queries (tail, meta, watermark, pane chrome).
      convexSubscribes: 15,
      // Two writes that change no key: each wakes every subscriber for nothing.
      storeWrites: 2,
      // The pane swaps its subtrees; nothing else on the page moves.
      domMutations: 23,
    });
  }
});

await test("inbox-load", "the inbox over 5,000 sessions draws a bounded list and asks the server for nothing but its two queries", async () => {
  await setup("inbox-load");
  for (const r of await twice()) {
    expect(pick(r, ["cards", "convexQueries", "convexSubscribes", "convexMutations"])).toEqual({
      // GLOBAL_CARD_BUDGET plus the active row the panel always keeps.
      cards: 51,
      convexQueries: 0, convexSubscribes: 2, convexMutations: 0,
    });
  }
});

await test("inbox-heartbeat", "a heartbeat on a drawn session re-renders nothing in a 5,000-session inbox", async () => {
  await setup("inbox-heartbeat");
  for (const r of await twice()) {
    expect({ ...pick(r, ["storeWrites", "commits", "domMutations", "layoutReads"]), rendered: r.detail.rendered }).toEqual({ storeWrites: 1, commits: 0, domMutations: 0, layoutReads: 0, rendered: [] });
  }
});

await test("inbox-heartbeat", "a rename that arrives through the feed reaches its card", async () => {
  const { act } = await import("react");
  const { useInboxStore } = await import("../store/inboxStore");
  const id = document.querySelector("[data-session-id]")!.getAttribute("data-session-id")!;
  await act(async () => {
    const row = useInboxStore.getState().sessions[id] as any;
    useInboxStore.getState().syncTable("sessions", [{ ...row, title: "Renamed by the server" }] as any, { isDelta: true } as any);
  });
  await reset();
  expect(document.querySelector(`[data-session-id="${id}"] [data-sv-title]`)?.textContent).toBe("Renamed by the server");
});

await test("diff", "opening a long diff commits once, draws in 11 DOM mutation records, reads no layout and writes nothing to the store", async () => {
  await setup("diff");
  for (const r of await twice()) {
    expect({ ...pick(r, ["commits", "domMutations", "layoutReads", "storeWrites", "convexQueries", "convexSubscribes"]), reads: r.detail.layoutReads }).toEqual({
      commits: 1, domMutations: 11, layoutReads: 0, storeWrites: 0, convexQueries: 0, convexSubscribes: 0, reads: [],
    });
    // Pierre draws every line, unwindowed: the file's 1,560 lines plus the
    // removed side of its 52 changed lines.
    expect(r.counts.diffLines).toBe(1612);
  }
});

process.exit(failures.length ? 1 : 0);

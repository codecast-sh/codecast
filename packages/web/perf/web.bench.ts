// The web app's hot paths, timed with strobe (perf/README.md). Each case runs
// perf/harness.tsx in a fresh Bun process per block: the real components in
// jsdom over a synthetic cache. The primary is cpu.work, the CPU the action
// costs on the JS thread (React, the store, the app's own code; no style,
// layout or paint, which jsdom does not do). Every count the harness reports
// is compared exactly between base and head; perf/budgets.ts asserts the
// ones with a known right value.
import { bench, script, type Case } from "@hona/strobe";

type Report = { counts: Record<string, number> };

const COUNTS = ["commits", "storeWrites", "domMutations", "layoutReads", "convexSubscribes", "convexQueries", "convexMutations", "convexActions"];

function harnessCase(extra: string[] = []): Case<{}> {
  return {
    primary: "cpu.work",
    metrics: ["run.duration", ...[...COUNTS, ...extra].map((name) => `count.${name}`)],
    async run(ctx) {
      const report = await ctx.call<Report>("run");
      for (const [name, n] of Object.entries(report.counts)) ctx.count(name, n);
    },
    reset: (ctx) => ctx.call("reset"),
  };
}

// Case names hold no comma: strobe's --filter splits its list on commas.
const WORKLOAD: Record<string, string> = {
  // Two conversations of 200 messages, both cached and visited, over 2,000
  // sessions: switch to the other until its last answer is on screen.
  "switch conversation (warm)": "switch",
  // One message arriving in an open conversation of 200, until it is drawn.
  "a message arrives in an open conversation": "append",
  // The inbox's session list mounting over 5,000 cached sessions.
  "load an inbox of 5000 sessions": "inbox-load",
  // One drawn session's heartbeat through the liveness overlay.
  "heartbeat in an inbox of 5000 sessions": "inbox-heartbeat",
  // A 1,560-line diff shown whole, highlighted, in a warm app.
  "open a long diff": "diff",
  // The command palette opening over a busy account's cache (32k sessions,
  // 52k tasks, 20k docs), with heartbeats and a task edit between opens.
  "open the command palette": "palette-open",
  // Typing "sync review" into it, a key at a time.
  "type into the command palette": "palette-type",
};

export default bench({
  targets: {
    // A git ref's worktree has no node_modules until this runs; a checkout
    // that has them (head, usually a shared tree) is left alone.
    web: script("./harness.tsx", { build: "test -d node_modules || bun install --frozen-lockfile" }),
  },
  async setup(ctx) {
    await ctx.call("setup", WORKLOAD[ctx.case]);
  },
  cases: {
    "switch conversation (warm)": harnessCase(),
    "a message arrives in an open conversation": harnessCase(),
    "load an inbox of 5000 sessions": harnessCase(["cards"]),
    "heartbeat in an inbox of 5000 sessions": harnessCase(),
    "open a long diff": harnessCase(["diffLines"]),
    "open the command palette": harnessCase(),
    "type into the command palette": harnessCase(),
  },
});

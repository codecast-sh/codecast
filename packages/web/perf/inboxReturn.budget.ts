// ct-97296: going back to the inbox from Threads re-renders none of the session
// rail's 50 cards. Run with plain `bun perf/inboxReturn.budget.ts` (like
// perf/budgets.ts, not `bun test`: the test preload stands in for modules the
// shell draws).
//
// The workload lives in perf/inboxReturn.workload.tsx, a fragment appended to
// perf/harness.tsx here at run time, so this check runs against whatever
// harness and app code the tree holds without editing the harness itself.
import { deepStrictEqual } from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
const generated = join(dir, `.inbox-return-harness-${process.pid}.tsx`);
writeFileSync(generated, `${readFileSync(join(dir, "harness.tsx"), "utf8")}\n${readFileSync(join(dir, "inboxReturn.workload.tsx"), "utf8")}`);
let failed = false;
try {
  const { setup, run, reset } = await import(generated);
  await setup("inbox-return");
  for (let i = 0; i < 2; i++) {
    const r = await run();
    await reset();
    const renders = (name: string) => Number(r.detail.rendered.find((x: string) => x.startsWith(`${name} x`))?.split(" x")[1] ?? 0);
    try {
      deepStrictEqual({ cards: r.counts.cards, SessionCard: renders("SessionCard"), SessionCardView: renders("SessionCardView") }, {
        // The rail stays open beside the inbox, drawing its bounded list.
        cards: 50,
        // A route change moves the tab's path; no session row changed, so no
        // card has anything new to draw (ct-97296: the shell re-rendered every
        // card, twice, and the page froze for seconds).
        SessionCard: 0, SessionCardView: 0,
      });
    } catch (err) {
      failed = true;
      console.log(`FAIL  run ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`      commits ${r.counts.commits}, renderMs ${r.detail.renderMs[0]}; top renders: ${r.detail.rendered.slice(0, 12).join(", ")}`);
    }
  }
} finally {
  rmSync(generated, { force: true });
}
console.log(failed ? "FAIL  going back to the inbox from Threads re-renders the session rail's cards" : "pass  going back to the inbox from Threads re-renders none of the session rail's 50 cards");
process.exit(failed ? 1 : 0);

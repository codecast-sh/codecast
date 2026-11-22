// ct-97296: going back to the inbox from Threads re-renders none of the session
// rail's 50 cards. The check itself is the "inbox-return" budget in
// perf/budgets.ts (run by scripts/perf-budgets.sh); this file is the flow's
// repro entry, kept so it still runs on a tree whose harness predates that
// workload.
//
// When perf/harness.tsx registers "inbox-return", this runs that budget. On an
// older harness it appends perf/inboxReturn.workload.tsx (the same setup, as a
// fragment) to the harness at run time and checks the card renders alone.
import { deepStrictEqual } from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
if (readFileSync(join(dir, "harness.tsx"), "utf8").includes('"inbox-return": setupInboxReturn')) {
  const child = Bun.spawnSync(["bun", join(dir, "budgets.ts"), "inbox-return"], { stdout: "inherit", stderr: "inherit" });
  process.exit(child.exitCode ?? 1);
}
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

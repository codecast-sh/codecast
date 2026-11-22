// One shared checkout runs one pass through a flow at a time (ship-checkout.md,
// "A pass through a flow"): two `cast flow run --checkout` runs would freeze the
// same files twice, brief their writers twice and land them twice. The run that
// holds the checkout is written to .git/codecast/checkout-run.json: the pid of
// the `cast flow run` starting it until the run exists, then the run's id. A
// hold is stale once its starter's process is gone or it has been starting for
// longer than any start takes (a pid can be reused), or once its run is no
// longer pending, running or paused, so nothing has to clear it.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

type Hold = { pid: number; run_id?: string; task?: string; at: number };

const holdFile = (gitDir: string) => path.join(gitDir, "codecast", "checkout-run.json");

// Freezing and making the task and worktree take minutes; a hold still starting after this is a dead starter's
// whose pid another process now has.
export const STARTING_HOLD_MS = 5 * 60_000;

const readText = (file: string) => { try { return fs.readFileSync(file, "utf-8"); } catch { return null; } };

function parseHold(text: string | null): Hold | null {
  try {
    const h = text === null ? null : JSON.parse(text);
    return typeof h?.pid === "number" ? h : null;
  } catch {
    return null;
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; } };

/** Another pass through a flow holds this checkout. */
export class CheckoutRunHeld extends Error {}

/** Why `hold` still holds the checkout, or null when it is stale. */
async function holding(hold: Hold | null, pid: number, runLive: (runId: string) => Promise<boolean | null>, now: number): Promise<string | null> {
  if (!hold) return null;
  const on = hold.task ? ` on ${hold.task}` : "";
  if (hold.run_id) {
    const live = await runLive(hold.run_id);
    if (live === false) return null;
    return live
      ? `A pass through a flow is already live in this checkout: run ${hold.run_id}${on}. Wait for it to end, or stop it (cast workflow cancel ${hold.run_id}), then run this again.`
      : `A pass through a flow started in this checkout (run ${hold.run_id}${on}) and whether it is still live cannot be read. Run this again once it can, or remove the checkout's .git/codecast/checkout-run.json if that run is over.`;
  }
  return hold.pid !== pid && alive(hold.pid) && now - (hold.at ?? 0) < STARTING_HOLD_MS ? `Another cast flow run --checkout (pid ${hold.pid}) is starting a pass in this checkout. Wait for it, then run this again.` : null;
}

/**
 * Take a stale hold out of the way, but only the one judged stale: two passes that both judged it so would otherwise
 * each delete the other's fresh hold. It is moved aside under a name of this process's own, read again, and deleted
 * when it is the same hold; a fresh one moved by mistake goes back (link fails if a third hold is already there, and
 * then that one stands).
 */
function clearStale(file: string, judged: string): void {
  const aside = `${file}.stale-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return; // another pass moved it first
  }
  if (readText(aside) !== judged) {
    try { fs.linkSync(aside, file); } catch { /* a newer hold is there */ }
  }
  fs.rmSync(aside, { force: true });
}

/**
 * Hold the checkout for this process's pass, or throw CheckoutRunHeld naming the run that holds it. `runLive` says
 * whether a run is pending, running or paused, and null when that cannot be read (which keeps the hold).
 */
export async function claimCheckoutRun(gitDir: string, runLive: (runId: string) => Promise<boolean | null>, pid = process.pid, now = Date.now): Promise<void> {
  const file = holdFile(gitDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, at: now() } satisfies Hold), { flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const judged = readText(file);
    if (judged === null) continue;
    const why = await holding(parseHold(judged), pid, runLive, now());
    if (why) throw new CheckoutRunHeld(why);
    clearStale(file, judged);
  }
  throw new CheckoutRunHeld("Another cast flow run --checkout keeps taking this checkout's hold. Run this again in a moment.");
}

/** The pass this process started is now `runId`: the hold names it until that run ends. Throws when this process no longer holds the checkout. */
export function recordCheckoutRun(gitDir: string, runId: string, task: string | undefined, pid = process.pid): void {
  const file = holdFile(gitDir);
  const held = parseHold(readText(file));
  if (held?.pid !== pid || held.run_id) throw new CheckoutRunHeld(`This pass no longer holds the checkout (${held ? `pid ${held.pid}${held.run_id ? `, run ${held.run_id}` : ""} does` : "nothing does"}), so run ${runId} is not recorded as its pass.`);
  fs.writeFileSync(file, JSON.stringify({ pid, run_id: runId, ...(task ? { task } : {}), at: Date.now() } satisfies Hold));
}

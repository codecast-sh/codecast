// A reviewer read as finished with nothing pinned and no verdict on its task has left no verdict, and its station
// routes on one (runner.ts waitOnStation). One read so in the middle of a tool call (ct-102683's reviewer settled two
// minutes into a test run it waited on, its last message a Bash call, and its run stopped "no review") or stopped on a
// question nobody here answers is asked once to finish. It has until it takes that ask and settles again, or the
// grace, before the station settles verdictless and the flow's own route for a missing verdict (a fresh reviewer, a
// stop) decides. A hand that never ran a turn is not asked: it fails as one.
import { c } from "../colors.js";

type Call = (route: string, body: Record<string, any>) => Promise<any>;

/** What the reviewer is asked: its brief says how to record and pin its verdict. */
export const VERDICT_ASK = "The run reads this review as finished, but you have left no verdict, and this station goes on only from the verdict you record. If a check you started is still running, let it finish. If you asked a question, nobody here answers it: settle it yourself from the change and your brief, and say so in the verdict. Then end as your brief says, with your verdict recorded and pinned.";
/** How long it has to take the ask: a foreground tool call runs at most ten minutes. */
export const VERDICT_ASK_GRACE_MS = 10 * 60_000;

/** The one ask a reviewer's wait makes: when, and the transcript's length then. */
export type VerdictAsk = { at: number; count: number } | null;

/**
 * Whether a reviewer's settled read is held: it pinned nothing and recorded no verdict on the task since `since`, and
 * it is asked now (the first such read) or has not taken the ask within the grace. `state.ask` keeps the ask.
 */
export async function holdForVerdict(call: Call, state: { ask: VerdictAsk }, o: {
  row: { message_count?: number; is_killed?: boolean }; pinned: { status?: string } | null; taskId?: string; since: number;
  to: string; from?: string; shortId: string; graceMs?: number;
}): Promise<boolean> {
  const count = o.row.message_count ?? 0;
  if (o.row.is_killed || count === 0 || o.pinned?.status) return false;
  if (o.taskId && ((await call("/cli/work/get", { short_id: o.taskId }))?.review_verdict?.at ?? 0) >= o.since) return false;
  if (!state.ask) {
    state.ask = { at: Date.now(), count };
    console.log(`${c.yellow}  ${o.shortId}: read as finished with no verdict; asking it once to finish the review${c.reset}`);
    await call("/cli/messages/send", { to: o.to, ...(o.from ? { from: o.from } : {}), body: VERDICT_ASK, wake: true });
    return true;
  }
  return count < state.ask.count + 2 && Date.now() - state.ask.at < (o.graceMs ?? VERDICT_ASK_GRACE_MS);
}

// A step's tally in words (lineModel StepTally), the one phrasing every
// surface uses: "open 17×, dissolved 6×, failed 1×".
import type { StepTally } from "../../../lib/line/lineModel";
import { outcomeWords } from "./parts";

export const tallyRowWords = (key: string, n: number) => `${outcomeWords(key)} ${n}×`;

/** A step's failures in words: a session killed or timed out before deciding failed its run, so it counts as failed, as the run does: "3 failed"; empty when none. */
export function failureWords(t: Pick<StepTally, "failed" | "cutOff">): string {
  const n = t.failed + t.cutOff;
  return n ? `${n} failed` : "";
}

export function tallyWords(tally: StepTally, max = Infinity): string {
  return tally.rows.slice(0, max).map((r) => tallyRowWords(r.key, r.n)).join(", ");
}

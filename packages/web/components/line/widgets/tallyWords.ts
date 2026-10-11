// A step's tally in words (lineModel StepTally), the one phrasing every
// surface uses: "open 17×, dissolved 6×, failed 1×".
import type { StepTally } from "../../../lib/line/lineModel";
import { outcomeWords } from "./parts";

export const tallyRowWords = (key: string, n: number) => `${outcomeWords(key)} ${n}×`;

/** A step's failures in words, the decided ones apart from the sessions cut off: "2 failed, 1 cut off"; empty when none. */
export function failureWords(t: Pick<StepTally, "failed" | "cutOff">): string {
  return [t.failed ? `${t.failed} failed` : "", t.cutOff ? `${t.cutOff} cut off` : ""].filter(Boolean).join(", ");
}

export function tallyWords(tally: StepTally, max = Infinity): string {
  return tally.rows.slice(0, max).map((r) => tallyRowWords(r.key, r.n)).join(", ");
}

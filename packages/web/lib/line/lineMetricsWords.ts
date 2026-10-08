/**
 * The line's three quality numbers (lineMetrics, the-line-model.md LM8) as
 * words a person reads cold: each a short phrase with its number inside, and
 * an honest phrase when the window holds nothing to count, never a 0%.
 */
import type { LineMetrics } from "./lineMetrics";

/** One phrase: `num` is the part drawn bold (null when there is no number), `text` follows it. */
export type MetricPhrase = { key: "breaks" | "explained" | "holding"; num: string | null; text: string; tip: string };

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** A rate to one decimal, without a trailing ".0". */
const rate = (n: number) => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));

export function lineMetricsPhrases(m: LineMetrics): MetricPhrase[] {
  const { breaks, explained, holding } = m;
  const placed = explained.explained + explained.opened;
  const ended = holding.held + holding.reopened;
  return [
    breaks.breaks === 0
      ? { key: "breaks", num: null, text: "no expectation breaks", tip: "No signal in the window cited one of the line's expectations" }
      // A rate under 0.1 a day reads better as the count over the window.
      : breaks.perDay < 0.1
        ? { key: "breaks", num: String(breaks.breaks), text: plural(breaks.breaks, " expectation break", " expectation breaks"), tip: "Signals that cite an expectation and were not refuted" }
        : { key: "breaks", num: rate(breaks.perDay), text: rate(breaks.perDay) === "1" ? " expectation break a day" : " expectation breaks a day", tip: `${breaks.breaks} ${plural(breaks.breaks, "signal", "signals")} cited an expectation and ${plural(breaks.breaks, "was", "were")} not refuted, per day of the window` },
    explained.share === null
      ? { key: "explained", num: null, text: "no new signals yet", tip: "No signal in the window was placed on a cause by the line" }
      : { key: "explained", num: `${Math.round(explained.share * 100)}%`, text: " of new signals joined a known cause", tip: `${explained.explained} of ${placed} ${plural(placed, "signal", "signals")} the line placed joined a cause it already had; ${explained.opened} opened a new one` },
    holding.share === null
      ? { key: "holding", num: null, text: "no watches ended yet", tip: "No shipped fix finished its watch in the window" }
      : { key: "holding", num: `${holding.held} of ${ended}`, text: plural(ended, " fix held", " fixes held"), tip: `Of the watches that ended in the window, ${holding.held} ended quiet and ${holding.reopened} saw a signal come back` },
  ];
}

/** The window, said in full: "24h" reads "the last 24 hours", "7d" "the last 7 days". */
export function windowWords(w: string): string {
  const m = /^(\d+)([hd])$/.exec(w);
  if (!m) return `the last ${w}`;
  const n = Number(m[1]);
  return `the last ${n} ${m[2] === "h" ? plural(n, "hour", "hours") : plural(n, "day", "days")}`;
}

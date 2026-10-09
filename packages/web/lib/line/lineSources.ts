// A line's sources in words (docs/architecture/line-map.md LX7): what each
// watches for, whether it is healthy or has gone quiet, how much it reported
// and what it reported last. One derivation for the sources panel and the
// map's source nodes, so both say the same thing. Pure.
import type { LineFinderDecl } from "@codecast/shared/contracts/lineProfile";
import { ageShort, silentText, type SenseSource } from "../lineFlow";

/** What a kind of report is, as a reader says it. */
const KIND_WORDS: Record<string, string> = {
  bug: "bugs",
  regression: "regressions",
  error: "errors",
  crash: "crashes",
  prompt_miss: "agents not doing what they should",
  eval: "eval drops",
  eval_drop: "eval drops",
  metric: "metrics moving the wrong way",
  feedback: "feedback from people",
  lesson: "lessons from past sessions",
};
const kindWord = (k: string) => KIND_WORDS[k] ?? k.replace(/_/g, " ");

/** "bugs and regressions", "anything worth fixing". */
export function watchesFor(kind: LineFinderDecl["kind"] | string[] | undefined): string {
  if (!kind || kind === "any" || kind.length === 0) return "anything worth fixing";
  const words = kind.map(kindWord);
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** A source's grouping in plain words: `union:<key>` counts reports with
 *  the same Union key as one cause. Anything else reads as its own pattern. */
export function groupingWords(fingerprint: string): string {
  const m = fingerprint.match(/^([\w.-]+):<([\w ]+)>$/);
  if (!m) return `counts reports with the same ${fingerprint} as one cause`;
  const [, prefix, key] = m;
  const name = prefix.charAt(0).toUpperCase() + prefix.slice(1);
  return `counts reports with the same ${name} ${key} as one cause`;
}

export type SourceHealth = { tone: "ok" | "quiet" | "new"; words: string };

/** Healthy, quiet, or nothing yet: the one word a reader needs first. */
export function sourceHealth(s: Pick<SenseSource, "newest" | "silent" | "day">, now: number): SourceHealth {
  if (s.silent) return { tone: "quiet", words: silentText(s, now).replace(/^silent /, "quiet for ") };
  if (!s.newest) return { tone: "new", words: "nothing reported yet" };
  return { tone: "ok", words: s.day > 0 ? `healthy, ${s.day} today` : "healthy" };
}

/** "Reported 209 in the last 7 days; the last, 2h ago:". */
export function sourceCounts(s: Pick<SenseSource, "week" | "newest">, now: number): string {
  const last = s.newest ? `; the last ${ageShort(now - s.newest.created_at)} ago` : "";
  return s.week > 0 ? `Reported ${s.week} in the last 7 days${last}` : s.newest ? `Nothing in the last 7 days${last}` : "Nothing reported yet";
}

/** The one sentence a source is: what it watches and how its reports group. */
export function sourceSentence(source: string, finder: Pick<LineFinderDecl, "kind" | "fingerprint"> | undefined, kinds: string[] = []): string {
  const what = watchesFor(finder?.kind ?? (kinds.length ? kinds : undefined));
  const name = source.toLowerCase() === "person" ? "People on the team" : source;
  return `${name} ${source.toLowerCase() === "person" ? "report" : "reports"} ${what}${finder ? `, and ${groupingWords(finder.fingerprint)}` : ""}.`;
}

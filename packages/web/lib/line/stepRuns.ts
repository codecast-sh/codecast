// A step's runs as the drawer lists them (line-workspace.md LW3): one row per
// run, grouped by problem, each naming the problem, where its findings came
// from, what the step put out and where the run went next. Pure.
import { decisionKey, decisionSaid, decisionsByCase, type CaseDecisions, type StepDecision } from "./lineModel";
import { knownName } from "./sourceNames";

/** Where a problem came from: the source most of its findings name, and the judge most of those name. */
export type ProblemSource = { source: string; judge: string | null; findings: number; others: number };

type SourceSignal = { source: string; judge?: string; task_id: string };

/** "AgentWatch", "comms judge": a source or judge name as a reader says it. */
export const sourceName = (raw: string) => knownName(raw) ?? raw;
export const judgeName = (raw: string) => raw.replace(/[_-]+/g, " ").trim();

/** "AgentWatch · comms judge", "+1" when other sources also reported it. */
export function sourceChipWords(s: ProblemSource): string {
  return `${sourceName(s.source)}${s.judge ? ` · ${judgeName(s.judge)}` : ""}`;
}

const most = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

/** Each problem's source, by its task id. */
export function problemSources(signals: ReadonlyArray<SourceSignal>): Map<string, ProblemSource> {
  const by = new Map<string, { n: number; sources: Map<string, number>; judges: Map<string, Map<string, number>> }>();
  for (const s of signals) {
    if (!s.task_id) continue;
    const row = by.get(s.task_id) ?? { n: 0, sources: new Map(), judges: new Map() };
    row.n++;
    row.sources.set(s.source, (row.sources.get(s.source) ?? 0) + 1);
    if (s.judge) {
      const j = row.judges.get(s.source) ?? new Map<string, number>();
      j.set(s.judge, (j.get(s.judge) ?? 0) + 1);
      row.judges.set(s.source, j);
    }
    by.set(s.task_id, row);
  }
  const out = new Map<string, ProblemSource>();
  for (const [task, row] of by) {
    const source = most(row.sources)!;
    const judges = row.judges.get(source);
    out.set(task, { source, judge: judges ? most(judges) : null, findings: row.n, others: row.sources.size - 1 });
  }
  return out;
}

/** Words that say only that the step finished: never shown as what it did. */
const BARE = /^(done|ok|running|failed|waiting|handed on|open|next|completed?|success)\.?$/i;

/** What the step put out on this run, in its own words (a script's printed line, an agent's
 *  finding, a person's note), or null when it said nothing beyond finishing or its outcome. */
export function runOutput(d: Pick<StepDecision, "reasoning" | "decided" | "caseTitle" | "status" | "closed">): string | null {
  const said = decisionSaid(d).trim();
  if (!said || BARE.test(said) || said === d.caseTitle.trim()) return null;
  return said.toLowerCase() === decisionKey(d).toLowerCase() ? null : said;
}

/** Where the run went next: the step it moved to, or null when it ended here. */
export const runNext = (d: Pick<StepDecision, "decided">) => d.decided.toLabel ?? null;

/** A step's runs grouped by problem (newest first), narrowed to one outcome. */
export function stepRunGroups(decisions: ReadonlyArray<StepDecision>, outcome: string | null): CaseDecisions[] {
  return decisionsByCase(outcome ? decisions.filter((d) => decisionKey(d) === outcome) : decisions);
}

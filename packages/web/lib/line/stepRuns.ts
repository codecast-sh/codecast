// A step's runs as the drawer lists them (line-workspace.md LW3): one row per
// run, grouped by problem, each naming the problem, where its findings came
// from, what the step put out and where the run went next. Pure.
import { decisionKey, decisionSaid, decisionsByCase, type CaseDecisions, type StepDecision } from "./lineModel";
import { knownName } from "./sourceNames";

/** Where a problem came from: the source most of its findings name, the judge most of those name, and for a
 *  person's findings the person who filed most of them. */
export type ProblemSource = { source: string; judge: string | null; by: string | null; findings: number; others: number; byAgent?: boolean };

type SourceSignal = { source: string; judge?: string; task_id: string; user_id?: string };

/** "AgentWatch", "comms judge": a source or judge name as a reader says it. */
export const sourceName = (raw: string) => knownName(raw) ?? (raw.toLowerCase() === "person" ? "Person" : raw);
export const judgeName = (raw: string) => raw.replace(/[_-]+/g, " ").trim();
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** "AgentWatch · comms judge", "Person · Ashot", "Agent · Aivery": the source and who in it reported. A finding
 *  filed by hand reads by who filed it: an agent's account is an agent, never a person. */
export function sourceChipWords(s: Pick<ProblemSource, "source" | "judge"> & { by?: string | null; byAgent?: boolean }): string {
  // Codecast's own judges file under `judge:<name>`: the judge is the whole source.
  if (s.source.startsWith("judge:")) return `${cap(judgeName(s.judge || s.source.slice(6)))} judge`;
  const who = s.judge ? judgeName(s.judge) : s.by ?? null;
  const name = s.byAgent && s.source.toLowerCase() === "person" ? "Agent" : sourceName(s.source);
  return `${name}${who ? ` · ${who}` : ""}`;
}

const most = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

/** Each problem's source, by its task id. */
export function problemSources(signals: ReadonlyArray<SourceSignal>, names?: ReadonlyMap<string, string>, bots?: ReadonlySet<string>): Map<string, ProblemSource> {
  const bump = (m: Map<string, Map<string, number>>, k: string, v: string) => {
    const inner = m.get(k) ?? new Map<string, number>();
    inner.set(v, (inner.get(v) ?? 0) + 1);
    m.set(k, inner);
  };
  const by = new Map<string, { n: number; sources: Map<string, number>; judges: Map<string, Map<string, number>>; people: Map<string, Map<string, number>>; agents: Set<string> }>();
  for (const s of signals) {
    if (!s.task_id) continue;
    const row = by.get(s.task_id) ?? { n: 0, sources: new Map(), judges: new Map(), people: new Map(), agents: new Set<string>() };
    row.n++;
    row.sources.set(s.source, (row.sources.get(s.source) ?? 0) + 1);
    if (s.judge) bump(row.judges, s.source, s.judge);
    const person = s.source.toLowerCase() === "person" && s.user_id ? names?.get(s.user_id) : null;
    if (person) bump(row.people, s.source, person);
    if (person && s.user_id && bots?.has(s.user_id)) row.agents.add(person);
    by.set(s.task_id, row);
  }
  const out = new Map<string, ProblemSource>();
  for (const [task, row] of by) {
    const source = most(row.sources)!;
    const judges = row.judges.get(source);
    const people = row.people.get(source);
    const who = people ? most(people)! : null;
    out.set(task, { source, judge: judges ? most(judges) : null, by: who ? firstName(who) : null, findings: row.n, others: row.sources.size - 1, ...(who && row.agents.has(who) ? { byAgent: true } : {}) });
  }
  return out;
}

/** A person as a chip names them: the first word of their name, or an email's local part. */
const firstName = (name: string) => (name.includes("@") ? name.split("@")[0] : name.split(/\s+/)[0]) || name;

/** Words that say only that the step finished: never shown as what it did. */
const BARE = /^(done|ok|running|failed|waiting|handed on|open|next|completed?|success)\.?$/i;

/** What the step put out on this run, in its own words (a script's printed line, an agent's
 *  finding, a person's note), or null when it said nothing beyond finishing or its outcome. */
export function runOutput(d: Pick<StepDecision, "reasoning" | "decided" | "caseTitle" | "status" | "closed">): string | null {
  const said = decisionSaid(d).trim();
  if (!said || BARE.test(said) || said === d.caseTitle.trim()) return null;
  return said.toLowerCase() === decisionKey(d).toLowerCase() ? null : said;
}

/** An end step decides nothing: what a run there amounts to is the decision of the step that sent it (Dissolve's
 *  "dissolved", with its words). By decision id, for an end step's decisions; empty for any other step. */
export function endArrivals(step: { kind: string; decisions: ReadonlyArray<StepDecision> }, steps: Readonly<Record<string, { decisions: ReadonlyArray<StepDecision> }>>): Map<string, StepDecision> {
  const out = new Map<string, StepDecision>();
  if (step.kind !== "end") return out;
  for (const d of step.decisions) {
    const from = d.received.from ? steps[d.received.from] : undefined;
    const sent = from?.decisions.find((x) => x.runId === d.runId);
    if (sent) out.set(d.id, sent);
  }
  return out;
}

/** Where the run went next: the step it moved to, or null when it ended here. */
export const runNext = (d: Pick<StepDecision, "decided">) => d.decided.toLabel ?? null;

/** A step's runs grouped by problem (newest first), narrowed to one outcome. */
export function stepRunGroups(decisions: ReadonlyArray<StepDecision>, outcome: string | null): CaseDecisions[] {
  return decisionsByCase(outcome ? decisions.filter((d) => decisionKey(d) === outcome) : decisions);
}

// A step's runs as the drawer lists them (line-workspace.md LW3): one row per
// run, grouped by problem, each naming the problem, where its findings came
// from, what the step put out and where the run went next. Pure.
import { decisionKey, decisionsByCase, tallyKey, type CaseDecisions, type StepDecision } from "./lineModel";
import { judgeName, sourceName } from "./sourceNames";

/** Where a problem came from: the source most of its findings name, the judge most of those name, and for a
 *  person's findings the person who filed most of them. */
/** `all`: every source its findings name, most first; `judges`: each "source/judge" they name, lowercased (the Sources view's key). */
export type ProblemSource = { source: string; judge: string | null; by: string | null; findings: number; others: number; byAgent?: boolean; all: Array<{ source: string; n: number }>; judges: string[] };

type SourceSignal = { source: string; judge?: string; task_id: string; user_id?: string };


/** "AgentWatch comms judge", "Codecast comms judge", "Person · Ashot", "Agent · Aivery": a judge by its one name
 *  (sourceNames judgeName), else the source and who in it reported. A finding filed by hand reads by who filed it: an
 *  agent's account is an agent, never a person. */
export function sourceChipWords(s: Pick<ProblemSource, "source" | "judge"> & { by?: string | null; byAgent?: boolean }): string {
  // Codecast's own judges file under `judge:<name>`: the judge is the whole source.
  if (s.source.startsWith("judge:")) return judgeName("Codecast", s.judge || s.source.slice(6));
  if (s.judge) return judgeName(sourceName(s.source), s.judge);
  const who = s.by ?? null;
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
    const all = [...row.sources].map(([src, n]) => ({ source: src, n })).sort((a, b) => b.n - a.n || a.source.localeCompare(b.source));
    const judgeKeys = [...row.judges].flatMap(([src, js]) => [...js.keys()].map((j) => `${src}/${j}`.toLowerCase()));
    out.set(task, { source, judge: judges ? most(judges) : null, by: who ? firstName(who) : null, findings: row.n, others: row.sources.size - 1, ...(who && row.agents.has(who) ? { byAgent: true } : {}), all, judges: judgeKeys });
  }
  return out;
}

/** Every problem's source, the one reading every list, filter and search uses: its findings first; a problem whose
 *  findings are older than the window reads its kept quotes; one whose findings have all left it since (moved to
 *  another problem, or withdrawn when a run closed it as the judge's mistake) reads the sources its occurrence record
 *  kept, so a close is still counted against the source that raised it; one filed by hand reads by who filed it. */
export function problemOrigins(input: {
  signals: ReadonlyArray<SourceSignal>;
  issues: ReadonlyArray<{ id: string; findings: number; quotes: ReadonlyArray<{ source: string }> }>;
  tasks: ReadonlyArray<{ _id: string; source?: string; user_id?: string }>;
  isCause: (t: { _id: string; source?: string; user_id?: string }) => boolean;
  names?: ReadonlyMap<string, string>;
  bots?: ReadonlySet<string>;
  /** Each problem's occurrence record (lineWorkspace.occurrences): the sources that ever filed on it. */
  occurrences?: ReadonlyArray<{ task_id: string; sources?: ReadonlyArray<string> }>;
}): Map<string, ProblemSource> {
  const out = problemSources(input.signals, input.names, input.bots);
  for (const i of input.issues) {
    if (out.has(i.id) || !i.quotes.length) continue;
    const n = new Map<string, number>();
    for (const q of i.quotes) n.set(q.source, (n.get(q.source) ?? 0) + 1);
    const all = [...n].map(([source, c]) => ({ source, n: c })).sort((a, b) => b.n - a.n);
    out.set(i.id, { source: all[0].source, judge: null, by: null, findings: i.findings, others: n.size - 1, all, judges: [] });
  }
  for (const o of input.occurrences ?? []) {
    if (out.has(o.task_id) || !o.sources?.length) continue;
    out.set(o.task_id, { source: o.sources[0], judge: null, by: null, findings: 0, others: o.sources.length - 1, all: o.sources.map((source) => ({ source, n: 0 })), judges: [] });
  }
  // A problem filed by hand, not from a finding, came from whoever filed it: an agent or a person, by role.
  for (const t of input.tasks) {
    if (out.has(t._id) || t.source === "signal" || !input.isCause(t)) continue;
    const by = t.user_id ? input.names?.get(t.user_id) ?? null : null;
    const source = t.source === "insight" ? "Session insight" : "person";
    out.set(t._id, {
      source, judge: null, by: source === "person" && by ? firstName(by) : null, findings: 0, others: 0, all: [{ source, n: 0 }], judges: [],
      ...(source === "person" && (t.source === "agent" || (t.user_id && input.bots?.has(t.user_id))) ? { byAgent: true } : {}),
    });
  }
  return out;
}

/** A person as a chip names them: the first word of their name, or an email's local part. */
const firstName = (name: string) => (name.includes("@") ? name.split("@")[0] : name.split(/\s+/)[0]) || name;

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
  return decisionsByCase(outcome ? decisions.filter((d) => tallyKey(d) === outcome) : decisions);
}

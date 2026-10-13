// What waits on the viewer in the line (line-journeys.md LJ6.1): one selector
// over the Inbox's rows (lineInbox buildLineInbox, every process), read by the
// nav's one count, the For you page, a problem's act band, a run's person step
// and a step's waiting rows. A need is counted only when the viewer can answer
// it now, in the reader, with no run started:
//   decision  a fix a session presents            -> answered on the decision
//   question  a problem holding on a fact         -> answered in the Ask block
//   confirm   a new problem: is this real?        -> answered in the Ask block
// and listed, uncounted, under "Needs a new ask" while no answer can land:
//   lapsed    a fix built, asked, never answered  -> a new run asks again
//   stopped   a run that ended needing a yes      -> a new run asks again
//   reask     a paused run nobody can answer      -> its agent presents again
// A run whose step failed, a silent run, a problem waiting for more findings
// and a project whose line is off are never needs: they are Problems statuses.
// Pure.
import type { FailCause } from "./runReport";
import { askLine, type InboxGroup, type InboxKind, type InboxRow } from "./lineInbox";
import { wholeSentences } from "./problemPage";

export type NeedKind = "decision" | "question" | "confirm" | "lapsed" | "stopped" | "reask";

export type LineNeed = {
  /** The list's key. It changes when a confirm becomes a question, so it is never in the URL. */
  key: string;
  /** The thing that waits, as the URL's `need` names it: the decision (sd-N), the trial card (tc-N), else the problem (ct-N). */
  ref: string;
  kind: NeedKind;
  /** Whether it is in the "for you" count: answerable now, in the reader. */
  counted: boolean;
  /** What is asked, whole: the decision's question, the problem's question, else the problem's title. */
  ask: string;
  /** What the list's row says: what is asked when it stands on its own, else the problem's title (a question that
   *  points back, "Choose which before work starts.", says nothing in a list). */
  line: string;
  /** The problem's title. */
  title: string;
  problemRef: string | null;
  caseId: string | null;
  projectId: string | null;
  /** The process (graph key) it belongs to: every link out of a need carries it. */
  process: string | null;
  /** When it started waiting; null when unknown. */
  since: number | null;
  runId: string | null;
  /** The decision to open (sd-N, else its row id), when a session presented one. */
  decisionRef: string | null;
  /** The trial card (tc-N), for a need a trial run asks. */
  cardRef: string | null;
  trial: boolean;
  /** Grounding's whole note, for a question or a confirm. */
  note: string | null;
  /** For a stopped run: the step it ended at and what it said. */
  fail: FailCause | null;
  /** For a reask: why no answer can land, in a sentence. */
  why: string | null;
  findings: number | null;
  /** Every other name an older link may give it: the decision's row id, the trial card's row id. */
  aliases: string[];
};

/** Words in a step's last message that ask a person for something: a yes, a sign-off, a decision, an answer. */
const ASKS_A_PERSON = /\b(?:yes|approv\w*|sign[- ]?off|go[- ]ahead|confirm\w*|decid\w*|decision|answer|permission|ok to|your call|needs? (?:a |an |the )?(?:person|human|owner|founder|you)|waits? (?:on|for) (?:you|a person|the owner|[A-Z][a-z]+))\b/i;

/** A run that finished a step without failing, had no next step, and whose step said it needs a person: it stopped
 *  waiting on a yes. A dead end whose step said nothing of the kind (`{"reproduced": true}` with no edge for it) is the
 *  line's own gap: a failure, a Problems status, never something to ask the viewer about. */
export const stoppedNeedingYes = (fail: FailCause | null | undefined): boolean => !!fail && fail.key.startsWith("deadend:") && ASKS_A_PERSON.test(fail.label);

/** The need an Inbox row is; null for a row that asks the viewer nothing. */
export function needKind(row: Pick<InboxRow, "kind" | "fail">): NeedKind | null {
  const by: Partial<Record<InboxKind, NeedKind>> = { decide: "decision", question: "question", confirm: "confirm", unapproved: "lapsed", proposal: "reask" };
  if (row.kind === "failed") return stoppedNeedingYes(row.fail) ? "stopped" : null;
  return by[row.kind] ?? null;
}

const COUNTED: ReadonlySet<NeedKind> = new Set(["decision", "question", "confirm"]);
export const needCounted = (kind: NeedKind): boolean => COUNTED.has(kind);

type ProcessOf = { row: (row: Pick<InboxRow, "caseId" | "runId" | "projectId">) => string | null | undefined };

/** Every need in the rows given, in no order (needGroups orders them). */
export function lineNeeds(groups: ReadonlyArray<InboxGroup>, of?: ProcessOf): LineNeed[] {
  const out: LineNeed[] = [];
  for (const g of groups) for (const r of g.rows) {
    const kind = needKind(r);
    if (!kind) continue;
    const decisionRef = kind === "decision" ? (r.trial ? r.decisionRef ?? null : r.cardRef ?? r.cardId) : null;
    const cardRef = r.trial ? r.cardRef : null;
    const ref = decisionRef ?? (kind === "reask" ? cardRef : null) ?? r.ref ?? r.caseId ?? r.key;
    // A note stored cut at its cap ends mid-word: the question is read to its last full sentence.
    const ask = kind === "stopped" ? r.fail?.label ?? r.title : (kind === "question" || kind === "confirm") && r.note ? askLine(wholeSentences(r.note)) : r.ask || r.title;
    out.push({
      key: r.key, ref, kind, counted: needCounted(kind),
      ask, line: rowLine(kind, ask, r.title),
      title: r.title, problemRef: r.ref, caseId: r.caseId, projectId: r.projectId, process: of?.row(r) ?? null, since: r.at, runId: r.runId,
      decisionRef, cardRef, trial: !!r.trial, note: r.note ?? null, fail: kind === "stopped" ? r.fail ?? null : null, why: kind === "reask" ? r.hold ?? null : null, findings: r.findings ?? null,
      aliases: [r.cardId, r.cardRef, r.decisionRef].filter((x): x is string => !!x && x !== ref),
    });
  }
  return out;
}

/** A question stands on its own in a list when it asks something whole; otherwise the row names the problem. */
export function rowLine(kind: NeedKind, ask: string, title: string): string {
  if (kind === "stopped" || kind === "lapsed") return title;
  if (kind !== "question" && kind !== "confirm") return ask || title;
  const whole = ask.length >= 70 || (/\?$/.test(ask) && ask.length >= 40 && !/^(?:is this a real problem)/i.test(ask));
  return whole ? ask : title;
}

/** "For you": the needs the viewer can clear in the reader. The one count, shown on the nav entry. */
export const needCount = (needs: ReadonlyArray<LineNeed>): number => needs.reduce((n, x) => n + (x.counted ? 1 : 0), 0);

export type NeedGroupKey = "decision" | "question" | "confirm" | "newask";
export type NeedGroup = { key: NeedGroupKey; label: string; counted: boolean; needs: LineNeed[] };

/** Each group named for its act (LJ8.1), in the order a person clears them. */
export const NEED_GROUP_LABELS: Record<NeedGroupKey, string> = { decision: "Fixes to decide", question: "Questions", confirm: "New: is this real?", newask: "Needs a new ask" };
const GROUP_ORDER: NeedGroupKey[] = ["decision", "question", "confirm", "newask"];
/** A built fix on a branch is worth the most, so it leads "Needs a new ask". */
const NEWASK_ORDER: NeedKind[] = ["lapsed", "stopped", "reask"];
const groupOf = (kind: NeedKind): NeedGroupKey => (COUNTED.has(kind) ? (kind as NeedGroupKey) : "newask");

/** The needs as the For you list shows them: the counted groups, then "Needs a new ask"; inside a group, oldest first. */
export function needGroups(needs: ReadonlyArray<LineNeed>): NeedGroup[] {
  const oldest = (a: LineNeed, b: LineNeed) => (a.since ?? Infinity) - (b.since ?? Infinity);
  return GROUP_ORDER.map((key) => {
    const rows = needs.filter((n) => groupOf(n.kind) === key).sort((a, b) => (key === "newask" ? NEWASK_ORDER.indexOf(a.kind) - NEWASK_ORDER.indexOf(b.kind) : 0) || oldest(a, b));
    return { key, label: NEED_GROUP_LABELS[key], counted: key !== "newask", needs: rows };
  }).filter((g) => g.needs.length > 0);
}

/** The needs in list order: what the reader's previous and next walk. */
export const needOrder = (groups: ReadonlyArray<NeedGroup>): LineNeed[] => groups.flatMap((g) => g.needs);

/** The need a ref names: the URL's `need`, or an older link's decision (sd-N or its row id), trial card or problem. */
export function needForRef(needs: ReadonlyArray<LineNeed>, ref: string | null | undefined): LineNeed | null {
  if (!ref) return null;
  return needs.find((n) => n.ref === ref) ?? needs.find((n) => n.aliases.includes(ref)) ?? needs.find((n) => n.problemRef === ref || n.caseId === ref) ?? null;
}

/** What waits on the viewer about one problem: its act band and its Problems status read this. */
export const needOfCase = (needs: ReadonlyArray<LineNeed>, caseId: string | null | undefined): LineNeed | null => (caseId ? needs.find((n) => n.caseId === caseId) ?? null : null);

/** The problems that cannot start because their project's line is off: For you's last row, which opens Problems. Not a need. */
export function notStarted(groups: ReadonlyArray<InboxGroup>): { problems: number; lines: number } {
  let problems = 0, lines = 0;
  for (const g of groups) for (const r of g.rows) if (r.kind === "stuck" && r.switchOff) { lines++; problems += r.waiting ?? 0; }
  return { problems, lines };
}

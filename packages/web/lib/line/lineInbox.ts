// What waits on the viewer in the line (line-workspace.md LW1, the Inbox), as
// rows grouped by what to do: fixes to decide (a run's decision, or a trial
// run's card, convex lineTrial.ts, in one group), fixes that shipped past an
// unanswered card, problems holding for a person's answer, runs that
// failed or went silent, and projects whose line cannot start. Each row names
// the concrete thing (the problem, the question, the failure) and carries one
// action. The counts agree with the roll-up (lineFlow lineRollup): the waiting
// problems come from the same flow, split by the same reasons. Pure.
import { causeHeading } from "./causeHeading";
import { cardAsRead, emptyWords, trialHold, trialLane } from "../trialEvidence";
import type { TrialCardRow, TrialEvidence } from "../../hooks/useSyncTrial";
import {
  admissionHold, buildLineFlow, causeAsks, causeName, isCause, isLineCard, unapprovedShips, waitingCauseIds, NO_PROJECT,
  type LineAdmission, type LineCauseTask, type LineDecision, type LineFlowRun, type LineProject, type LineSignal, type RollupRow,
} from "../lineFlow";
import { graphKeyOf, newestRunByTask, processIndex, type GraphRun } from "./lineGraphs";
import type { LineIssue } from "./lineModel";
import { isCountedActive } from "./problemTable";
import { failCause, stoppedOnPurpose, type FailCause } from "./runReport";
import { needCounted, needKind, stopAnswered } from "./lineNeeds";
import { restsOnNothing } from "./findingEvidence";
import { contactsOf, decisionAssignee, mostOf, type DecisionChange } from "./decisionFacts";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { runEnd } from "@codecast/shared/contracts/causeHistory";

export type InboxKind = "decide" | "unapproved" | "confirm" | "question" | "failed" | "stalled" | "fixed" | "mine" | "watching" | "proposal" | "stuck";

export type InboxRow = {
  key: string;
  kind: InboxKind;
  /** When it started waiting; null when unknown. */
  at: number | null;
  projectId: string | null;
  /** The thing itself: the problem's title, or the project's name for a line that cannot start. */
  title: string;
  /** The problem's written name (lineFlow causeName), else null: every list and head names it by problemListName. */
  name?: string | null;
  /** The problem's ref (ct-N), else null. */
  ref: string | null;
  /** The concrete detail, short: why the run failed, the step a silent run sits at, why the line holds. */
  detail: string | null;
  /** What the viewer is asked, for a problem holding on a person (askLine): the row's main line, the problem's title under it. */
  ask?: string | null;
  /** Grounding's whole note, for a problem holding on a person: the ask comes out of it, and its reader shows the rest. */
  note?: string | null;
  caseId: string | null;
  runId: string | null;
  cardId: string | null;
  cardRef: string | null;
  /** For a stuck project: problems waiting there, and whether the one fix is the start switch. */
  waiting?: number;
  switchOff?: boolean;
  /** For a failed run: the station it stopped at and what happened, short (runReport failCause). */
  fail?: FailCause;
  /** For a trial card that is its station's own decision: sd-N, whose page holds the session's card and its discussion. */
  decisionRef?: string | null;
  /** Set on a fix to decide that a trial run asks: its card (tc-N) is cardRef. Answering it records what you would do and ships nothing. */
  trial?: boolean;
  /** A trial card whose answer changes what is live all the same: a judge fix's Publish writes the judges. */
  publishes?: boolean;
  /** Why the pipeline would rather a trial card wait (lib/trialEvidence trialHold), in a chip's words: it still waits on you. */
  hold?: string | null;
  /** The hold as a chip's fixed label ("regrouped", "waiting on evidence", "drop?"); `hold` is its whole wording. */
  holdLabel?: string | null;
  /** For a trial card: how many of its checks failed. */
  failing?: number;
  /** For a problem: how many findings it holds. */
  findings?: number;
  /** For a fix to decide: what its run recommends (ship, revise, drop, build, wait), when its card says. */
  recommend?: string | null;
  /** For a problem a run parked because main already carries its fix: that commit. */
  sha?: string | null;
  /** For a fix to decide: the decision's row id, which assigning it names. */
  decisionId?: string | null;
  /** For a fix to decide: what answering it changes (lib/line/decisionFacts). */
  change?: DecisionChange;
  /** For a fix to decide: the teammate it is assigned to (decisionAssignee), else null. */
  assignee?: string | null;
  /** For a fix to decide: the people its problem reached (contacts its evidence names, or conversations its card read). */
  reach?: number | null;
  /** For a fix to decide: the worst finding's severity on its problem, 1 to 10, when a judge scored one. */
  severity?: number | null;
};

/** The commit a park note says main already carries the fix in ("Already fixed on main by fc0d85ba65"). */
export const fixedOnMain = (note: string | null | undefined): string | null =>
  /\b(?:already )?fixed on main (?:by|in|at) ([0-9a-f]{7,40})\b/i.exec(note ?? "")?.[1] ?? null;

export type InboxGroup = { kind: InboxKind; label: string; rows: InboxRow[] };

export const INBOX_LABELS: Record<InboxKind, string> = {
  decide: "Fixes to decide",
  unapproved: "Not shipped: no answer",
  confirm: "New, confirm",
  question: "Questions",
  failed: "Pipeline health",
  stalled: "Silent runs",
  fixed: "Already fixed on main",
  mine: "Assigned to you",
  watching: "Watching",
  proposal: "Runs to ask again",
  stuck: "Not starting",
};
/** Most urgent first: the groups' order, and the one group a problem asked for twice is listed under. */
const ORDER: InboxKind[] = ["decide", "question", "unapproved", "confirm", "failed", "stalled", "fixed", "mine", "watching", "proposal", "stuck"];

/** A note that parks a problem until more findings come ("so it waits for more signals"): it asks a person nothing. */
const WAITS_FOR_SIGNALS = /\bwaits? (?:for|on) more (?:signals|findings)\b/i;
/** Whether grounding's note parks the problem for more findings (watched, not asked). The Inbox and the problem's page read it alike. */
export const waitsForFindings = (note: string | null | undefined): boolean => WAITS_FOR_SIGNALS.test(note ?? "");

export type LineInboxInput = {
  signals: ReadonlyArray<LineSignal>;
  tasks: ReadonlyArray<LineCauseTask>;
  runs: ReadonlyArray<LineFlowRun>;
  /** The decisions in view: the viewer's queue and the team's open line decisions, each open one with its live status. */
  decisions: ReadonlyArray<LineDecision & { short_id?: string; created_at?: number; gate_node_id?: string; question?: string }>;
  projects: ReadonlyArray<LineProject>;
  /** The roll-up rows in view (one project's, or every project's). */
  rollups: ReadonlyArray<RollupRow>;
  admissions: ReadonlyMap<string, LineAdmission>;
  /** `decisions` holds every open, current line decision the viewer can read (the team's feed is in), so a trial card
   *  whose decision is not among them was replaced and is not listed. */
  decisionsComplete?: boolean;
  /** The workspace's trial cards (useSyncTrial useTrialCards): the waiting ones are rows. */
  trialCards?: ReadonlyArray<TrialInboxCard>;
  /** Trial projects: their runs start on their own, so they never wait on a start switch. */
  trialProjects?: ReadonlySet<string>;
  /** The viewer: a problem assigned to them waits on them, since the line never starts a problem a person holds. */
  viewer?: string | null;
  /** Tasks a run's decision is about that are not line problems in view, by id: the decision still names its problem. */
  otherTasks?: ReadonlyMap<string, { title: string; short_id: string | null; project_id: string | null }>;
  now: number;
};

/** A trial card as the Inbox reads it (hooks/useSyncTrial TrialCardRow). */
export type TrialInboxCard = {
  _id: string;
  short_id: string;
  project_id: string;
  task_id: string;
  task_short_id?: string;
  task_title?: string;
  task_name?: string | null;
  run_id: string;
  kind: "card" | "gate";
  question: string;
  options: ReadonlyArray<{ key: string; label: string }>;
  card?: { headline?: string; change?: string; checks?: ReadonlyArray<{ ok: boolean }>; recommend?: { verdict: string } } | null;
  status: "waiting" | "answered" | "closed";
  created_at: number;
  /** The session decision the card is (sd-N), when its station posted one. */
  decision?: { _id: string; short_id: string | null; status: string } | null;
  /** Sent back to rebuild on main: on its way to the next card, so it waits on nobody now. */
  rebuilding?: unknown;
  /** It settles an expectations proposal: its Apply writes the project's expectations. */
  expectations?: boolean;
  /** The run waits at a step its line no longer has: no answer has anywhere to go until it is asked again. */
  stale_gate?: boolean;
  /** Where its run stands: a card no session posted is answered straight into its run's gate while the run is paused. */
  run_status?: string;
  /** A judge route's card: Publish writes the measured edit into the judges, so its answer changes what is live. */
  judge_fix?: { ab?: { verdict?: string } | null } | null;
  /** The problem's live findings, read now (lib/trialEvidence). */
  evidence?: TrialEvidence | null;
};

/**
 * Whether a trial card waits on a person now. One reading for the Inbox's rows, a run's "Waiting on tc-N" and the
 * Problems banner, so the three agree. A card its station posted as a session decision waits while that decision is
 * pending, read from the decision's own row when the store holds one (`live`, an answer given a moment ago) before the
 * card's copy. A hold the pipeline would put on it (evals owed, one conversation) is a chip on the row, never a reason
 * to hide it: the run still waits on the answer.
 */
export function trialCardWaits(c: Pick<TrialInboxCard, "status" | "decision" | "rebuilding">, live?: string | null): boolean {
  if (c.status !== "waiting" || c.rebuilding) return false;
  return !c.decision || (live ?? c.decision.status) === "pending";
}

/**
 * Whether a waiting trial card can take an answer now, while the step it waits at is still on the line: a session
 * posted it as a decision, or its run is paused at that very gate and takes the answer itself (convex lineTrial
 * answerTrialCardCore hands the key to the run's gate; the run's own session is the one to talk it over with). One that
 * cannot (its step was removed, or its run left the gate) is never a fix to decide: its run has to be asked again
 * first, and the Inbox, the Problems list and a run's chip all say that instead.
 */
export function trialCardAnswerable(c: Pick<TrialInboxCard, "status" | "decision" | "rebuilding" | "stale_gate" | "run_status">, live?: string | null): boolean {
  return trialCardWaits(c, live) && !c.stale_gate && (!!c.decision || c.run_status === "paused");
}

/** A card no station posted, answered at its run's own gate (trialCardAnswerable). */
export const answersAtGate = (c: Pick<TrialInboxCard, "decision" | "run_status" | "stale_gate">): boolean => !c.decision && !c.stale_gate && c.run_status === "paused";

/** Why a waiting card cannot take an answer, in a chip's two words. */
export const reaskWhy = (c: Pick<TrialInboxCard, "decision" | "stale_gate">): string => (c.stale_gate ? "step removed" : "no session");

/** Why the pipeline would rather a waiting trial card wait, in a chip's few words; null when nothing holds it. */
export function trialHoldWords(c: TrialCardRow): string | null {
  return trialHoldChip(c)?.words ?? null;
}

/** A hold's fixed label, by what holds it: the chip reads at a glance, its words go in the tooltip. */
const HOLD_LABEL: Record<string, string> = {
  rebuilding: "rebuilding", stale: "behind main", stale_gate: "step removed", one_case: "one case", uncarded: "no card", remeasure: "regrouped",
  recase: "case left", wait: "waiting on evidence", controls: "few controls",
};

/** Why a waiting trial card would rather wait: a short fixed label and the whole of it. Null when nothing holds it. */
export function trialHoldChip(c: TrialCardRow): { label: string; words: string } | null {
  const lane = trialLane(c);
  if (lane === "empty") return { label: "drop?", words: emptyWords(c) };
  if (lane === "tooling") return { label: "review tooling", words: "review tooling" };
  const h = trialHold(c);
  return h ? { label: HOLD_LABEL[h.kind] ?? h.kind.replace(/_/g, " "), words: h.words } : null;
}

const firstSentence = (t: string) => t.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? t;

/** What a trial card asks, short: a change card's headline, else what it changes (its question only wraps the
 *  problem's title in "Ship the fix for …?"), else the question's first sentence. */
export function trialAsk(c: Pick<TrialInboxCard, "kind" | "question" | "card">): string {
  const head = oneLine(c.card?.headline) ?? (c.card?.change ? firstSentence(oneLine(c.card.change) ?? "").replace(/^On this local branch,\s*/i, "").replace(/^./, (x) => x.toUpperCase()) : null);
  if (c.kind === "card" && head) return head;
  const q = oneLine(c.question) ?? "";
  return q.match(/^.+?[?.!](?=\s|$)/)?.[0] ?? q;
}

/** A decision's question as a row says it: its first sentence, on one line. */
const decisionAsk = (q: string | null | undefined) => { const t = oneLine(q); return t ? t.match(/^.+?[?.!](?=\s|$)/)?.[0] ?? t : null; };

const terminal = (s: string) => s === "done" || s === "dropped";
const oneLine = (s: string | null | undefined) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t || null;
};

/** The ask itself, out of grounding's note: the sentence that says what a person must answer, said as an instruction
 *  ("A person needs to confirm which state is true." reads "Confirm which state is true."). */
export function askLine(note: string | null | undefined): string {
  return askParts(note).question;
}

/** Where lineGround cut a readiness note mid-word before Oct 13 (goalsBrief parseGroundReply now keeps it whole). */
const NOTE_CAP = 500;

/** The ask and what the note says besides it: the sentences before the ask that it did not take in, without the
 *  note's "it can't be worked yet" frame. A card shows the question once and the context under it. */
export function askParts(note: string | null | undefined): { question: string; context: string | null } {
  const text = (note ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { question: "Is this a real problem?", context: null };
  const sentences = text.match(/[^.?!]+[.?!]*/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];
  const at = sentences.findIndex((x) => /\?$/.test(x) || /\b(person|someone|you|a human|the owner)\b[^.]*?\b(needs? to|must|should|has to)\b/i.test(x));
  // A note that ends on a bare request ("Please name the earlier email.") after a sentence saying what nobody knows
  // ("We can't tell whether ...") asks the unknown: the request names a thing the page may not hold, the unknown is
  // what an answer settles.
  const unknown = at < 0 && /^please\b/i.test(sentences[sentences.length - 1] ?? "") ? sentences.findIndex((x) => /\b(?:can(?:'|no)t tell|not (?:clear|known)|nothing says|unknown)\s+whether\b/i.test(x)) : -1;
  const i = at >= 0 ? at : unknown >= 0 ? unknown : sentences.length - 1;
  // The ask without its frame: "a person needs to ...", "it can't be worked yet because ...".
  const bare = sentences[i].replace(/^.*?\b(?:a person|someone|you|a human|the owner)\s+(?:needs? to|must|should|has to)\s+/i, "").replace(/^it (?:can(?:'|no)t|cannot) be worked(?: on)? yet,? because\s+/i, "");
  // "Supply that before ..." or "Say which, because ..." names its object in the sentence before: the ask carries it.
  const merged = /^\w+\s+(?:(?:that|this|it)\b|which\s*[,.])/i.test(bare) && i > 0;
  const said = merged ? `${sentences[i - 1].replace(/[.!]$/, "")}: ${bare.charAt(0).toLowerCase()}${bare.slice(1)}` : bare;
  const context = sentences.slice(0, merged ? i - 1 : i).filter((x) => !/\b(can(?:'|no)t|cannot) be worked\b/i.test(x)).join(" ").trim();
  // A note stored cut at its cap (lineGround keeps 500) can end inside its ask: the ask is still the ask, marked cut,
  // never swapped for the sentence before it.
  const cut = i === sentences.length - 1 && !/[.?!]["')\]]?$/.test(said) && (note ?? "").length >= NOTE_CAP;
  const q = said.charAt(0).toUpperCase() + said.slice(1);
  return { question: cut ? `${q.replace(/[\s,;:]+$/, "")}…` : q, context: context || null };
}

/** One way an ask can be answered, read from its "whether A (so X) or B (so Y)": what is true, and what follows. */
export type AskChoice = { says: string; so: string | null };

const AUX = new Set(["has", "have", "had", "is", "are", "was", "were", "did", "does", "do", "can", "could", "will", "would", "should"]);

/** Split on " or " outside parentheses. */
function orParts(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && text.startsWith(" or ", i)) { out.push(text.slice(from, i)); from = i + 4; i += 3; }
  }
  out.push(text.slice(from));
  return out.map((x) => x.replace(/^[\s,]+|[\s,]+$/g, "")).filter(Boolean);
}

/** The alternatives' end: a clause after them that says why the answer matters (", since the fix lives in a different
 *  place for each", ": say which, because that decides if the fix is code, prompt or telephony") is not one of them. */
function alternativesEnd(text: string): string {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (/^[:;]\s/.test(text.slice(i, i + 2)) || /^,\s+(?:since|because|as|given|so that|which)\b/i.test(text.slice(i)))) return text.slice(0, i);
  }
  return text;
}

/**
 * The ask as the question it is (LJ6.2). Grounding names what it does not know as a statement ("nothing says whether
 * Quinn has actually left (so Riley is correct) or is still active (so the switch is the bug)"); a person answers a
 * question, so this reads it as one ("Has Quinn actually left, or is Quinn still active?") and, when it weighs
 * alternatives, gives each as an answer with what it would mean. A cut ask (ending "…") asks its whole first
 * alternative, or reads as written when even that was cut.
 */
export function askAsQuestion(ask: string): { question: string; choices: AskChoice[] } {
  const t = ask.replace(/\s+/g, " ").trim();
  if (!t || /\?$/.test(t)) return { question: t, choices: [] };
  const m = /\bwhether\s+(.+?)[.!]?$/i.exec(t);
  if (!m) return { question: t, choices: [] };
  // "Say which behavior it is about, and whether the rule covers it": the whether is one part of a larger ask, and
  // asking it alone would drop the rest. Such an ask is read as written.
  if (/\b(?:and|but)\s*$|,\s*$/i.test(t.slice(0, m.index).trim()) || /\bwhether\b/i.test(m[1])) return { question: t, choices: [] };
  const alts = orParts(alternativesEnd(m[1]));
  // Cut at the note's cap, its end is lost. When the cut fell inside a later alternative ("whether A or from th…"),
  // A is whole: it is asked as a yes or no, A is its one-press answer, and the lost alternative is what the
  // "Something else" box is for. Cut inside the first alternative, nothing is whole and it is read as written.
  if (/…$/.test(m[1])) {
    if (alts.length < 2 || /…$/.test(alts[0])) return { question: t, choices: [] };
    const so = /\s*\(([^()]+)\)\s*$/.exec(alts[0]);
    const says = (so ? alts[0].slice(0, so.index) : alts[0]).trim();
    return { question: `Is it true that ${alts[0]}?`, choices: [{ says: says.charAt(0).toUpperCase() + says.slice(1), so: so ? so[1].trim() : null }] };
  }
  const choices = alts.map((a) => {
    const so = /\s*\(([^()]+)\)\s*$/.exec(a);
    return { says: (so ? a.slice(0, so.index) : a).trim(), so: so ? so[1].trim() : null };
  });
  // The first alternative names its subject before its verb ("Quinn has left"); a later one that starts at the verb
  // ("is still active") takes that subject.
  const words = choices[0].says.split(" ");
  const at = words.findIndex((w, i) => i > 0 && AUX.has(w.toLowerCase()));
  const subject = at > 0 ? words.slice(0, at).join(" ") : null;
  for (const c of choices.slice(1)) if (subject && AUX.has(c.says.split(" ")[0].toLowerCase())) c.says = `${subject} ${c.says}`;
  const invert = (says: string) => {
    const w = says.split(" ");
    const k = w.findIndex((x, i) => i > 0 && AUX.has(x.toLowerCase()));
    return k > 0 ? [w[k].toLowerCase(), ...w.slice(0, k), ...w.slice(k + 1)].join(" ") : null;
  };
  const asked = choices.map((c) => invert(c.says));
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  const question = asked.every(Boolean)
    ? `${cap(asked.join(", or "))}?`
    : choices.length > 1 ? `Which is it: ${choices.map((c) => c.says).join(", or ")}?` : `Is it true that ${choices[0].says}?`;
  return { question, choices: choices.length > 1 ? choices.map((c) => ({ ...c, says: cap(c.says) })) : [] };
}

export function buildLineInbox(input: LineInboxInput): InboxGroup[] {
  const tasks = input.tasks.filter(isCause);
  const byId = new Map(tasks.map((t) => [t._id, t]));
  const rows: InboxRow[] = [];
  const base = (t: LineCauseTask | undefined, kind: InboxKind, key: string): InboxRow => ({
    key: `${kind}:${key}`, kind, at: null, projectId: t?.project_id ?? null, title: t?.title ?? "A problem", name: causeName(t), ref: t?.short_id ?? null, detail: null, caseId: t?._id ?? null, runId: null, cardId: null, cardRef: null,
  });

  // Fix decisions to make, oldest first: a line card, or any open decision a run asked about one of these problems
  // (lib/line/fixDecision). Each names its problem and asks the decision's own question; a trial run's decision is
  // its trial card's, listed below in the same group.
  // What every fix to decide shows at a glance: who holds it, how many it reaches, how bad its worst finding is (the
  // decision row carries its problem's, convex decisionRowsForViewer).
  type FactRow = Parameters<typeof decisionAssignee>[0] & { problem_severity?: number | null };
  const facts = (t: LineCauseTask | undefined, d: FactRow, more?: { findings?: number | null; reach?: number | null }) => ({
    assignee: decisionAssignee(d),
    findings: mostOf(t?.cause?.signal_count, more?.findings) ?? undefined,
    reach: mostOf(contactsOf(t?.cause?.fingerprints), more?.reach),
    severity: d?.problem_severity ?? null,
  });
  const isFix = (x: (typeof input.decisions)[number]) => isLineCard(x) || (x.status === "pending" && !!x.workflow_run_id && !!x.task_id && byId.has(x.task_id));
  for (const d of input.decisions.filter((x) => isFix(x) && !x.trial).sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))) {
    const t = d.task_id ? byId.get(d.task_id) : undefined;
    // A card whose problem is not a line problem in view still names the task it is about, else its own question and ref.
    const other = !t && d.task_id ? input.otherTasks?.get(d.task_id) : undefined;
    const own = t ? null : other ? { title: other.title, ref: other.short_id, projectId: other.project_id } : { title: oneLine(d.question) ?? "A card", ref: d.short_id ?? null };
    const card = (d as { card?: { headline?: string; recommend?: { verdict?: string } | null } | null }).card;
    // A row says what the person decides: the decision's own question, never its problem's title or a card's headline.
    rows.push({
      ...base(t, "decide", d._id), ...own, at: d.created_at ?? null, ask: decisionAsk(d.question) ?? oneLine(card?.headline), runId: d.workflow_run_id ?? null, cardId: d._id, cardRef: d.short_id ?? null, recommend: card?.recommend?.verdict ?? null,
      decisionId: d._id, change: d.gate_node_id === CARD_GATE_NODE_ID || card ? "fix" : "other", ...facts(t, d as FactRow),
    });
  }

  // Trial cards, oldest first: each is a trial run paused at its gate, waiting on the answer (trialCardWaits). One its
  // station posted as a session decision is a fix to decide like any other: the row opens that decision, where the
  // answer is given beside the session that asked. A card that cannot take an answer (no session asked it, or its
  // step left the line: trialCardAnswerable) is a run to ask again, listed quietly with that one act and never
  // counted as waiting on you.
  const live = new Map(input.decisions.map((d) => [d._id, d.status]));
  const decisionRow = new Map(input.decisions.map((d) => [d._id, d]));
  for (const c of [...(input.trialCards ?? [])].filter((x) => trialCardWaits(x, x.decision ? live.get(x.decision._id) : null)).sort((a, b) => a.created_at - b.created_at)) {
    const t = byId.get(c.task_id);
    const card = cardAsRead(c as Parameters<typeof cardAsRead>[0]) as TrialInboxCard["card"];
    const answerable = trialCardAnswerable(c, c.decision ? live.get(c.decision._id) : null);
    // A card its station asked as a decision is listed while that decision stands: the decisions given here are every
    // open, current one the viewer can read (a decision its run has moved past is replaced, and is not among them).
    if (answerable && c.decision && input.decisionsComplete && !live.has(c.decision._id)) continue;
    rows.push({
      ...base(t, answerable ? "decide" : "proposal", c._id), projectId: c.project_id, title: t?.title ?? oneLine(c.task_title) ?? "A problem", name: causeName(t) ?? c.task_name ?? null, ref: t?.short_id ?? c.task_short_id ?? null, caseId: c.task_id,
      at: c.created_at, ask: answerable ? decisionAsk((c.decision ? decisionRow.get(c.decision._id)?.question : null) ?? c.question) ?? trialAsk(c) : trialAsk(c), runId: c.run_id, cardId: c._id, cardRef: c.short_id, decisionRef: c.decision?.short_id ?? c.decision?._id ?? null, trial: true,
      ...(answerable ? (() => { const h = trialHoldChip(c as unknown as TrialCardRow); return { hold: h?.words ?? null, holdLabel: h?.label ?? null }; })() : { hold: c.stale_gate ? "The step this run waits at was removed from the line, so an answer has nowhere to go" : "No session asked this card, so there is nobody to answer", holdLabel: reaskWhy(c) }), failing: card?.checks?.filter((k) => !k.ok).length ?? 0,
      // A judge fix carries its measured verdict ("better"), not a recommendation of its own.
      recommend: card?.recommend?.verdict ?? c.judge_fix?.ab?.verdict ?? null, publishes: !!c.judge_fix || !!c.expectations,
      decisionId: c.decision?._id ?? null, change: c.judge_fix ? "judge" : c.expectations ? "expectation" : c.kind === "card" ? "fix" : "other",
      ...facts(t, (c.decision ? decisionRow.get(c.decision._id) : null) as FactRow, {
        findings: mostOf(c.evidence?.findings, (card as { cause?: { signals?: number } } | null)?.cause?.signals),
        reach: mostOf(c.evidence?.conversations, (card as { reach?: { conversations?: number } } | null)?.reach?.conversations),
      }),
    });
  }

  // Fixes that went live past an unanswered card.
  for (const id of unapprovedShips(tasks, input.runs as Parameters<typeof unapprovedShips>[1], input.now)) {
    const t = byId.get(id);
    if (t) rows.push({ ...base(t, "unapproved", id), at: t.closed_at ?? t.updated_at ?? null });
  }

  // The waiting problems that hold on a person, read from the same flow the roll-up counts. A problem in review asks
  // the viewer nothing (its fix is with a reviewer), so it is not listed.
  const flow = buildLineFlow({ signals: input.signals as LineSignal[], tasks: tasks as LineCauseTask[], runs: input.runs as LineFlowRun[], decisions: input.decisions as LineDecision[], initiatives: [], projects: [], now: input.now });
  for (const id of waitingCauseIds(flow)) {
    const t = byId.get(id);
    if (!t) continue;
    if (t.status === "in_review") continue;
    // A problem one finding filed asks whether it is real; one with more asks what a person knows.
    // A problem parked until more findings come is watched, not asked: no answer unblocks it.
    else if (causeAsks(t) && WAITS_FOR_SIGNALS.test(t.readiness_note ?? "")) rows.push({ ...base(t, "watching", id), at: t.updated_at ?? null, findings: t.cause?.signal_count ?? 0 });
    // A problem opened on a finding that says nothing asks nobody anything: there is nothing to judge it real by, so it
    // is never put to a person. Problems files it under Needs a new ask, "No supporting finding", with Close on its row.
    else if (causeAsks(t) && restsOnNothing(t as { source?: string; title: string; description?: string })) continue;
    else if (causeAsks(t)) rows.push({ ...base(t, (t.cause?.signal_count ?? 0) <= 1 ? "confirm" : "question", id), at: t.updated_at ?? null, ask: askLine(t.readiness_note), note: t.readiness_note ?? null, findings: t.cause?.signal_count ?? 0 });
  }

  // Runs: a problem whose newest run failed, while the problem is still open; and live runs silent for a day.
  for (const [taskId, r] of newestRunByTask(input.runs)) {
    const t = byId.get(taskId);
    if (r.status !== "failed" || stoppedOnPurpose(r) || !t || terminal(t.status)) continue;
    const fail = failCause(r);
    // A yes or a wait given to this stop is on the problem: it waits on nobody now.
    if (stopAnswered(fail, t.readiness_note)) continue;
    rows.push({ ...base(t, "failed", r._id), at: r.updated_at ?? null, runId: r._id, detail: fail.label, fail });
  }
  // A problem its newest run parked because main already carries the fix: nothing runs and nothing will, and the one
  // act is a person's, closing it as fixed (LJ8.2: it waits on you, never under Not started).
  for (const [taskId, r] of newestRunByTask(input.runs)) {
    const t = byId.get(taskId);
    const sha = t && !terminal(t.status) && t.readiness !== "ready" ? fixedOnMain(t.readiness_note) : null;
    if (!sha || r.status === "running" || r.status === "paused" || runEnd(r as Parameters<typeof runEnd>[0])?.kind !== "parked") continue;
    rows.push({ ...base(t, "fixed", taskId), at: r.updated_at ?? t!.updated_at ?? null, runId: r._id, sha, note: t!.readiness_note ?? null, findings: t!.cause?.signal_count ?? 0 });
  }
  // A problem assigned to the viewer that nothing runs on: the sweep passes it by while a person holds it, so it is
  // theirs to work, hand back to the line, or close.
  if (input.viewer) {
    const newest = newestRunByTask(input.runs);
    for (const t of tasks) {
      if (String(t.assignee ?? "") !== input.viewer || terminal(t.status) || t.status === "in_review") continue;
      const r = newest.get(t._id);
      if (r && (r.status === "running" || r.status === "paused")) continue;
      rows.push({ ...base(t, "mine", t._id), at: t.updated_at ?? null, note: t.readiness_note ?? null, findings: t.cause?.signal_count ?? 0 });
    }
  }
  for (const b of flow.build.items.filter((x) => x.stalled)) {
    rows.push({ ...base(b.task, "stalled", b.run._id), at: b.since, runId: b.run._id, detail: b.step });
  }

  // Projects whose line holds its waiting problems.
  const titles = new Map(input.projects.map((p) => [p._id, p.title]));
  for (const r of input.rollups) {
    if (r.key === NO_PROJECT || !r.hold || r.causes === 0 || input.trialProjects?.has(r.key)) continue;
    const a = input.admissions.get(r.key);
    const hold = a ? admissionHold(a) : null;
    rows.push({ key: `stuck:${r.key}`, kind: "stuck", at: null, projectId: r.key, title: titles.get(r.key) ?? r.title, ref: null, detail: hold?.short ?? r.hold, caseId: null, runId: null, cardId: null, cardRef: null, waiting: r.causes, switchOff: r.startingOff });
  }

  // A problem is listed once, under its most urgent group, so the count is the things that wait on you. A trial card
  // is an answer the run waits on: each one is listed, and holds its problem out of the groups after it.
  const seen = new Set<string>();
  const once = (x: InboxRow) => !x.caseId || (x.trial ? (seen.add(x.caseId), true) : !seen.has(x.caseId) && !!seen.add(x.caseId));
  return ORDER.map((kind) => ({
    kind, label: INBOX_LABELS[kind],
    rows: rows.filter((x) => x.kind === kind && once(x)),
  })).filter((g) => g.rows.length > 0);
}

/** Failed runs that stopped the same way at the same station, as one line: most runs first. */
export type FailureGroup = { key: string; step: string | null; label: string; rows: InboxRow[]; newest: number | null };

export function groupFailures(rows: ReadonlyArray<InboxRow>): FailureGroup[] {
  const by = new Map<string, InboxRow[]>();
  for (const r of rows) {
    const k = r.fail?.key ?? `raw:${r.detail ?? ""}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by].map(([key, rs]) => {
    // Runs that agree say it whole ("Out of time, 3h"); runs that differ in the detail say what they share.
    const label = causeHeading(rs.map((r) => r.fail?.label ?? r.detail ?? "Failed"));
    const newest = rs.reduce<number | null>((n, r) => (r.at != null && (n == null || r.at > n) ? r.at : n), null);
    return { key, step: rs[0].fail?.step ?? null, label, rows: [...rs].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)), newest };
  }).sort((a, b) => b.rows.length - a.rows.length || (b.newest ?? 0) - (a.newest ?? 0));
}

/** Each problem in the Inbox and the group it is listed under, by task id. */
export function inboxKindByCase(groups: ReadonlyArray<InboxGroup>): Map<string, InboxKind | "stopped"> {
  const out = new Map<string, InboxKind | "stopped">();
  // Only what the "for you" count counts (isProblemRow), so the Problems filter and every badge agree. A run that
  // finished a step and waits on a yes sits in the failed group's rows but is no failure: it says what it asks.
  for (const g of groups) for (const r of g.rows) if (r.caseId && isProblemRow(r) && !out.has(r.caseId)) out.set(r.caseId, needKind(r) === "stopped" ? "stopped" : g.kind);
  return out;
}

/** A row that waits on the viewer: one the viewer can answer now, where it is read, with no run started (lineNeeds,
 *  the one reading of "for you"). A fix asked and never answered, a run to ask again, a failed run, a watched problem
 *  and a project whose line is off are listed where they belong, never counted. */
const isProblemRow = (r: InboxRow) => { const kind = needKind(r); return !!kind && needCounted(kind); };

/** "For you": the problems waiting on the viewer. One count for the header, the Inbox's nav badge, the picker,
 *  the project filter and the Problems view's For you filter; a project that cannot start is listed, never counted. */
export const inboxCount = (groups: ReadonlyArray<InboxGroup>) => groups.reduce((n, g) => n + g.rows.filter(isProblemRow).length, 0);

type ProcessRun = Pick<GraphRun, "_id" | "task_id" | "workflow_slug" | "workflow_name" | "created_at">;
type ProcessTask = { _id: string; project_id?: string | null };

/** The process (lineGraphs processIndex) each Inbox row, and each problem, belongs to: one reading for the picker's
 *  counts and the project filter's, so they agree. */
export function inboxProcessOf(runs: ReadonlyArray<ProcessRun>, tasks: ReadonlyArray<ProcessTask>) {
  const projectOf = new Map(tasks.map((t) => [t._id, t.project_id ?? null]));
  const process = processIndex(runs, (id) => projectOf.get(id));
  const runById = new Map(runs.map((r) => [r._id, r]));
  return {
    row: (row: Pick<InboxRow, "caseId" | "runId" | "projectId">) => {
      const run = !row.caseId && row.runId ? runById.get(row.runId) : undefined;
      return run ? graphKeyOf(run) : row.caseId ? process.task(row.caseId, row.projectId) : process.project(row.projectId);
    },
    task: (t: ProcessTask) => process.task(t._id, t.project_id ?? null),
  };
}

/** How many problems wait on the viewer in each process: each counts under exactly one, so the counts sum to the total. */
export function inboxByGraph(groups: ReadonlyArray<InboxGroup>, of: ReturnType<typeof inboxProcessOf>): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of groups) for (const row of g.rows) {
    if (!isProblemRow(row)) continue;
    const key = of.row(row);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * Per project, in the process drawn (`drawn` null: in every process): the problems waiting on the viewer and the problems not closed (problemTable
 * isActiveProblem). Read over every project's rows and model whatever the filter, so a project's numbers never move
 * when it is picked and the projects sum to the whole. A problem waiting on the viewer is open by definition, so
 * For you never exceeds Open.
 */
export function lineProjectCounts(
  groups: ReadonlyArray<InboxGroup>,
  of: ReturnType<typeof inboxProcessOf>,
  drawn: string | null,
  issues: ReadonlyArray<LineIssue>,
  projectOf: (taskId: string) => string | null | undefined,
  lessons?: ReadonlySet<string>,
): Map<string, { forYou: number; open: number }> {
  const forYou = new Map<string, Set<string>>();
  const open = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, p: string, id: string) => (m.get(p) ?? m.set(p, new Set()).get(p)!).add(id);
  for (const g of groups) for (const r of g.rows) {
    if (!isProblemRow(r) || !r.projectId || (drawn !== null && of.row(r) !== drawn)) continue;
    add(forYou, r.projectId, r.key);
    if (r.caseId) add(open, r.projectId, r.caseId);
  }
  for (const i of issues) {
    const p = projectOf(i.id);
    if (p && isCountedActive(i, lessons)) add(open, p, i.id);
  }
  const out = new Map<string, { forYou: number; open: number }>();
  for (const p of new Set([...forYou.keys(), ...open.keys()])) out.set(p, { forYou: forYou.get(p)?.size ?? 0, open: open.get(p)?.size ?? 0 });
  return out;
}

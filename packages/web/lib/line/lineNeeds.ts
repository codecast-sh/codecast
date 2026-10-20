// What waits on the viewer in the line (line-journeys.md LJ6.1): one selector
// over the Inbox's rows (lineInbox buildLineInbox, every process), read by the
// nav's one count, the For you page, a problem's act band, a run's person step
// and a step's waiting rows. A line puts one thing in front of a person per
// problem: the decision the session that built the fix presents at the end of
// its run. So a need is counted (it is For you, and the nav's count) only when
// it is that decision:
//   decision  a fix a session presents            -> answered on the decision
// Everything else about a problem is the line's to carry, and is kept,
// uncounted, as the problem's state on Problems, where whoever opens the
// problem can still read and act on it:
//   unlanded  an approved fix nothing merged       -> Approved, not merged: the line lands it (Rebase, then Ship)
//   fixed     a run found main already fixes it   -> Needs a new ask: Close as fixed on its row
//   assigned  a problem assigned to the viewer    -> Not started, held by them
//   duplicate a problem the line reads as an older one's twin (overlap), with nothing of the older one asked
//                                                 -> Needs a new ask: Merge into the older one on its row
//   question  a problem holding on a fact         -> Not started, waiting on its project's lead role
//   confirm   a new problem: is this real?        -> Not started, waiting on its project's lead role
//   stopped   a step finished with no next step   -> Needs a new ask: a new run goes on
//   review    a build no session presented        -> Needs a new ask: its run presents it
//   lapsed    a fix built, asked, never answered  -> Needs a new ask: a new run asks again
//   reask     a paused run nobody can answer      -> Needs a new ask: its agent presents again
// A question or a confirm on a problem that is an older one's twin is not asked twice: it folds into the older
// problem's need (foldDuplicateNeeds), one row whose findings are both problems'.
// A run whose step failed, a silent run, a problem waiting for more findings
// and a project whose line is off are never needs: they are Problems statuses. What a product's agents asked its team to
// do (Union's escalations) is the team's, not the viewer's: the Escalation finder's Team asks list holds it (teamAsks).
// Pure.
import type { UnlandedFix } from "./approvedFix";
import { PHASE_ORDER, guessPhase } from "@codecast/shared/contracts/linePhases";
import { stepLabel, type FailCause, type StepAdvice } from "./runReport";
import { STAGE_WORDS } from "./stageTrack";
import { askLine, type InboxGroup, type InboxKind, type InboxRow } from "./lineInbox";
import type { DecisionChange } from "./decisionFacts";

export type NeedKind = "decision" | "question" | "confirm" | "lapsed" | "stopped" | "review" | "unlanded" | "fixed" | "assigned" | "reask" | "duplicate";

/** A problem folded into another's need: the line reads it as the same problem (overlap), filed newer. */
export type NeedDup = { ref: string | null; caseId: string; projectId: string | null; findings: number | null };

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
  /** The problem's written name, else null: rows and heads name it by problemListName({ title, name }). */
  name: string | null;
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
  /** A trial card whose answer changes what is live (a judge fix's Publish writes the judges): never practice. */
  publishes?: boolean;
  /** Grounding's whole note, for a question or a confirm. */
  note: string | null;
  /** For a stopped run: the step it ended at and what it said. */
  fail: FailCause | null;
  /** For a reask: why no answer can land, in a sentence. */
  why: string | null;
  /** For a fixed one: the commit on main that carries the fix. */
  sha?: string | null;
  /** For an unlanded fix: who approved it (a user id; the reader names them), the one to land it. */
  approvedBy?: string | null;
  /** For an unlanded fix the landing refused: the base its branch is behind ("main"); it lands by a rebase. */
  behind?: string | null;
  findings: number | null;
  /** Every other name an older link may give it: the decision's row id, the trial card's row id, a folded twin's ref. */
  aliases: string[];
  /** The newer problems that are this one under another id, folded in here (foldDuplicateNeeds); `findings` counts theirs too. */
  dups?: NeedDup[];
  /** For a duplicate: the older problem it is the same as, which it merges into. */
  dupOf?: { ref: string | null; caseId: string } | null;
  /** For a decision: its row id (assigning names it), what answering it changes, who holds it, the people its
   *  problem reached and the worst finding's severity (lib/line/decisionFacts). */
  decisionId?: string | null;
  change?: DecisionChange;
  assignee?: string | null;
  reach?: number | null;
  severity?: number | null;
  /** For a decision: what its run recommends (ship, revise, drop, ...), when its card says. */
  recommend?: string | null;
};

/** A run whose step finished its work and had no next step (runReport finishedAtDeadEnd, the cause's `deadend:` key):
 *  nothing failed, and the line cannot move until a person reads what the step said and says yes. Starting it again
 *  would only redo work that passed, so it is never a failure. A step that failed with nowhere to go
 *  (`deadend-failed:`) is one. */
export const stoppedNeedingYes = (fail: FailCause | null | undefined): boolean => !!fail?.key?.startsWith("deadend:");

export type StoppedAsk = {
  /** The step that finished, as a person names it: "Prove". */
  step: string;
  /** Its own words, short: "Showed the call grader still faulting Anna…". */
  said: string | null;
  /** The stage a yes takes the work on to: "Build"; null past the last one. */
  next: string | null;
  /** The ask in one line, the same everywhere it is named (a problem's band, a run's head, a step's row): "Prove finished: go on to Build?". */
  line: string;
  /** What a yes records for the next run, which reads it as the problem's note. */
  note: string;
  /** What the step itself advised (runReport StepAdvice); null when it advised nothing, and then no answer leads. */
  advice: StepAdvice | null;
};

const sentencesOf = (text: string): string[] => text.replace(/```[\s\S]*?```/g, " ").split(/(?<=[.!?])\s+|\n+/).map((x) => x.replace(/^[-*>\s]+|^next:\s*/i, "").trim()).filter(Boolean);

/** What a step advised next in its own closing words, for a step that wrote no routing `next` (prove.md asks for one; a
 *  run from before it did not): a review someone must give before the fix is built ("they need an engineer's safety
 *  review before they're built"), or waiting for more cases ("This is still one case ... before anyone changes the
 *  prompt"). Read from the last sentence back, so its closing advice wins. Null when it advised neither. */
export function proseAdvice(text: string | null | undefined): StepAdvice | null {
  const said = sentencesOf(text ?? "");
  for (let i = said.length - 1; i >= Math.max(0, said.length - 6); i--) {
    const s = said[i];
    if (/\b(?:needs?|requires?|must (?:get|have)|should (?:get|have))\b[^.]*\breview\b[^.]*\bbefore\b/i.test(s)) {
      const by = /\breview(?:ed)? by ([A-Z][\w-]+)/.exec(s)?.[1] ?? /\(([A-Z][\w-]+) by default\)/.exec(s)?.[1] ?? null;
      return { act: "review", by, why: s };
    }
    if (oneCaseClaim(s) || /\bwait(?:s|ing)? for more (?:cases|findings|calls|conversations)\b/i.test(s)) return { act: "wait", by: null, why: s };
  }
  return null;
}

/** Whether a step's words rest its advice on there being one case ("This is still one case", "only a single call"). */
export const oneCaseClaim = (text: string | null | undefined): boolean =>
  /\b(?:still|only|just|but)\s+(?:one|a single|1)\s+(?:case|call|conversation|example|instance|finding)\b/i.test(text ?? "");

/** The yes a stopped run waits on (stoppedNeedingYes): a step finished with a report and the line had no next step for it,
 *  so a person says whether to go on to the next stage. Null for any other stop. */
export function stoppedAsk(fail: FailCause | null | undefined): StoppedAsk | null {
  if (!stoppedNeedingYes(fail) || !fail) return null;
  const cut = fail.label.indexOf(": ");
  const step = cut > 0 ? fail.label.slice(0, cut) : fail.step ? stepLabel({ id: fail.step }) : "The step";
  const said = cut > 0 ? fail.label.slice(cut + 2) : null;
  const at = fail.step ? PHASE_ORDER.indexOf(guessPhase(fail.step, step)) : -1;
  const following = at >= 0 ? PHASE_ORDER[at + 1] : undefined;
  const next = following ? STAGE_WORDS[following] : null;
  const line = `${step} finished: ${next ? `go on to ${next}?` : "go on?"}`;
  const note = `Yes: go on${next ? ` to ${next}` : ""} with what ${step} found${said ? ` (${said.replace(/[.…]+$/, "")})` : ""}.`;
  return { step, said, next, line, note, advice: fail.advice ?? null };
}

/** The advice as a tag word: "go on", "wait", "review". */
export const adviceWord = (a: StepAdvice): string => (a.act === "go" ? "go on" : a.act);

/** The note a yes leaves on the problem (AskBlock answerProblem "confirmed" writes "Confirmed: <note>"). */
export const yesNote = (ask: StoppedAsk): string => `Confirmed: ${ask.note}`;

/** The note that parks a stopped problem until more findings come, when its step advised waiting: grounding asks
 *  again once the findings double (convex lineGround regroundWhenRegrouped), and every surface reads it as watched
 *  (lineInbox waitsForFindings). */
export const waitNote = (ask: StoppedAsk): string => ask.advice?.act === "wait"
  ? `${ask.step} advised it waits for more findings${ask.advice.why ? `: ${ask.advice.why.replace(/[.…]+$/, "")}` : ""}.`
  : `After ${ask.step}, a person chose to wait for more findings.`;

/** Whether the problem's note answers this very stop: a yes the next run carries on, or a wait that parked it. */
export function stopAnswered(fail: FailCause | null | undefined, note: string | null | undefined): boolean {
  const ask = stoppedAsk(fail);
  const said = note?.trim();
  return !!ask && !!said && (said === yesNote(ask) || said === waitNote(ask));
}

/** The need an Inbox row is; null for a row that asks the viewer nothing. */
export function needKind(row: Pick<InboxRow, "kind" | "fail">): NeedKind | null {
  const by: Partial<Record<InboxKind, NeedKind>> = { decide: "decision", question: "question", confirm: "confirm", unapproved: "lapsed", proposal: "reask", fixed: "fixed", mine: "assigned" };
  // A builder that handed its work off for review waits on that review, never a failure (runReport failCause `review:`).
  if (row.kind === "failed") return stoppedNeedingYes(row.fail) ? "stopped" : row.fail?.key.startsWith("review:") ? "review" : null;
  return by[row.kind] ?? null;
}

const COUNTED: ReadonlySet<NeedKind> = new Set(["decision"]);
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
    // A card its run asks at its own gate (no session posted it) is named by the card itself.
    const ref = decisionRef ?? (kind === "reask" || kind === "decision" ? cardRef : null) ?? r.ref ?? r.caseId ?? r.key;
    // A note stored cut at its cap ends mid-word: the question is read to its last full sentence.
    const ask = kind === "stopped" ? stoppedAsk(r.fail)?.line ?? r.title : kind === "review" ? r.fail?.review?.ask ?? r.title : (kind === "question" || kind === "confirm") && r.note ? askLine(r.note) : r.ask || r.title;
    out.push({
      key: r.key, ref, kind, counted: needCounted(kind),
      ask, line: rowLine(kind, ask, r.title),
      title: r.title, name: r.name ?? null, problemRef: r.ref, caseId: r.caseId, projectId: r.projectId, process: of?.row(r) ?? null, since: r.at, runId: r.runId,
      decisionRef, cardRef, trial: !!r.trial, ...(r.publishes ? { publishes: true } : {}), note: r.note ?? null, fail: kind === "stopped" || kind === "review" ? r.fail ?? null : null, why: kind === "reask" ? r.hold ?? null : null, findings: r.findings ?? null, sha: kind === "fixed" ? r.sha ?? null : null,
      aliases: [r.cardId, r.cardRef, r.decisionRef].filter((x): x is string => !!x && x !== ref),
      ...(kind === "decision" ? { decisionId: r.decisionId ?? null, change: r.change ?? "other", assignee: r.assignee ?? null, reach: r.reach ?? null, severity: r.severity ?? null, recommend: r.recommend ?? null } : {}),
    });
  }
  return out;
}

/** The older problem a problem is the same as (lib/line/overlap's primary), or null when it is its own. */
export type TwinOf = (caseId: string) => { caseId: string; ref: string | null } | null;

/** What a twin's need asks about the problem itself (is it real, what is it): asked once, on the older problem. A
 *  decision, a stopped run or a fix on main is about the twin's own run and stays its own. */
const ASKS_ABOUT_PROBLEM: ReadonlySet<NeedKind> = new Set(["question", "confirm"]);

/** Needs with each twin folded into the older problem's: one row, its findings both problems', its ref an alias of the
 *  older one's, so it is counted once and opened by either ref. A twin whose older problem asks nothing waits as a
 *  `duplicate`: the one act left is merging it in. */
export function foldDuplicateNeeds(needs: ReadonlyArray<LineNeed>, twinOf: TwinOf): LineNeed[] {
  const byCase = new Map<string, LineNeed>();
  for (const n of needs) if (n.caseId && !byCase.has(n.caseId)) byCase.set(n.caseId, n);
  const folded = new Map<string, NeedDup[]>();
  const out: LineNeed[] = [];
  for (const n of needs) {
    const twin = n.caseId && ASKS_ABOUT_PROBLEM.has(n.kind) ? twinOf(n.caseId) : null;
    if (!twin || twin.caseId === n.caseId) { out.push(n); continue; }
    if (byCase.has(twin.caseId)) {
      folded.set(twin.caseId, [...(folded.get(twin.caseId) ?? []), { ref: n.problemRef, caseId: n.caseId!, projectId: n.projectId, findings: n.findings }]);
      continue;
    }
    out.push({ ...n, kind: "duplicate", counted: needCounted("duplicate"), ask: `Same as ${twin.ref ?? "an older problem"}`, line: n.title, dupOf: twin });
  }
  return out.map((n) => {
    const dups = n.caseId ? folded.get(n.caseId) : undefined;
    if (!dups) return n;
    const findings = n.findings == null && dups.every((d) => d.findings == null) ? null : dups.reduce((t, d) => t + (d.findings ?? 0), n.findings ?? 0);
    return { ...n, findings, dups, aliases: [...n.aliases, ...dups.map((d) => d.ref).filter((x): x is string => !!x)] };
  });
}

/** A question stands on its own in a list when it asks something whole; otherwise the row names the problem. */
export function rowLine(kind: NeedKind, ask: string, title: string): string {
  if (kind === "stopped" || kind === "review" || kind === "unlanded" || kind === "lapsed" || kind === "fixed" || kind === "assigned" || kind === "duplicate") return title;
  if (kind !== "question" && kind !== "confirm") return ask || title;
  const whole = ask.length >= 70 || (/\?$/.test(ask) && ask.length >= 40 && !/^(?:is this a real problem)/i.test(ask));
  return whole ? ask : title;
}

/** A trial run's decision: an answer records what the viewer would do and ships nothing. It is listed, apart and last,
 *  and never counted with what changes the product. A judge fix is not practice: its Publish writes the judges. */
export const isPractice = (n: Pick<LineNeed, "kind" | "trial" | "publishes">): boolean => n.trial && n.kind === "decision" && !n.publishes;

/** The needs of one line (`process`, its graph key), in one project when `project` is given: the Line page's "waiting on
 *  you" and the For you list that figure opens (`process` in the address). Null process keeps every need. */
export const needsOfLine = <N extends Pick<LineNeed, "process" | "projectId">>(needs: ReadonlyArray<N>, process: string | null | undefined, project?: string | null): N[] =>
  !process ? [...needs] : needs.filter((n) => n.process === process && (!project || n.projectId === project));

/** "For you": every open decision of the team's lines, a trial's included (the team's decision inbox lists them all).
 *  The one count: the nav entry's, the list's and Problems' "Waiting on you". */
export const needCount = (needs: ReadonlyArray<LineNeed>): number => needs.reduce((n, x) => n + (x.counted ? 1 : 0), 0);

/** The need a ref names: the URL's `need`, or an older link's decision (sd-N or its row id), trial card or problem. */
export function needForRef(needs: ReadonlyArray<LineNeed>, ref: string | null | undefined): LineNeed | null {
  if (!ref) return null;
  return needs.find((n) => n.ref === ref) ?? needs.find((n) => n.aliases.includes(ref)) ?? needs.find((n) => n.problemRef === ref || n.caseId === ref) ?? null;
}

/** What waits on the viewer about one problem: its act band and its Problems status read this. */
/** A problem's own band says an unlanded fix whole (approved, not merged, with its act), so that need is not its band's. */
export const needOfCase = (needs: ReadonlyArray<LineNeed>, caseId: string | null | undefined): LineNeed | null => (caseId ? needs.find((n) => n.caseId === caseId && n.kind !== "unlanded") ?? null : null);

/** An approved fix nothing merged (approvedFix unlandedFix) as a need, waiting since it was approved, so its age says
 *  how long the fix has sat. */
export function unlandedNeed(p: { id: string; ref: string | null; title: string; name: string | null; projectId: string | null; process: string | null }, fix: UnlandedFix): LineNeed {
  return {
    key: `unlanded:${p.id}`, ref: p.ref ?? p.id, kind: "unlanded", counted: needCounted("unlanded"), ask: p.title, line: p.title, title: p.title, name: p.name,
    problemRef: p.ref, caseId: p.id, projectId: p.projectId, process: p.process, since: fix.at, runId: fix.runId,
    decisionRef: null, cardRef: null, trial: false, note: null, fail: null, why: null, findings: null, approvedBy: fix.answeredBy, behind: fix.behind,
    aliases: fix.ref ? [fix.ref] : [],
  };
}



/** What the proof check of a go-on run will hold the change to (the line's Red step): a prompt cause is shown by the
 *  project's prove command, which replays a spec of real moments; any other by the test Prove writes (repro.sh). When
 *  the stopped step said it wrote no replay spec, Red sends a prompt cause back, and the review says so before the run
 *  is spent. `test`: the test Prove's words name, which only a code cause is checked by. */
export function goOnProof(category: string | null | undefined, said: string | null | undefined): { proof: string; warn: string | null } {
  const text = said ?? "";
  const test = /([\w.-]+\.(?:test|spec)\.[cm]?[jt]sx?)\b/.exec(text)?.[1] ?? null;
  if (category === "prompt") {
    const none = /\b(?:did ?n[o']t|could ?n[o']t|cannot|can't|never)\s+(?:write|support|make)\b[^.]*\b(?:spec|prove\.json|freeze)/i.test(text)
      || /\bno (?:real )?moment could (?:support|show)\b/i.test(text) || /\bfor lack of a spec\b/i.test(text);
    return { proof: "A replay of real moments (prompt cause)", warn: none ? `Prove wrote no replay${test ? `, only ${test}` : ""}: Red sends it back` : null };
  }
  return { proof: test ? `${test}, the test Prove writes` : "The test Prove writes", warn: null };
}

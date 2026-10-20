"use client";
// The Ask block (line-journeys.md LJ6.2): the question a problem holds on, in
// full, with the answer box and its two outcomes. An answer marks the problem
// ready with the answer as its context (the sweep starts it); "Not a problem"
// closes it.
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { useInboxStore } from "../../../../../store/inboxStore";
import { useCollectionRows } from "../../../../../hooks/useCollectionRows";
import { useSyncTaskSignals } from "../../../../../hooks/useSyncSignals";
import { quoteSource, type ReaderSignal } from "../../../widgets/FindingReader";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import { askAsQuestion, askParts } from "../../../../../lib/line/lineInbox";
import type { LineAdmission } from "../../../../../lib/lineFlow";
import { startsAtOnce } from "../../../../consequential/lineStartLedger";
import { useLineAdmission } from "../../../map/useLineAdmission";
import { askedAbout, askShape, evidenceLinkWords, findingBlocks, namesIn, wholeSentences } from "../../../../../lib/line/problemPage";
import { HISTORY_ITEM, HISTORY_SEARCH, readHistoryHits, readHistoryItem, type HistoryHit } from "../../../../../lib/line/historyLookup";
import { CALL_APP } from "../../../../../lib/line/findingCalls";
import { useAppRead } from "../../../widgets/useAppRead";
import { findingSupport, offTopicFindings, restsOnNothing } from "../../../../../lib/line/findingEvidence";
import { LineStartControl } from "../../../../consequential/lineStart";
import { SwitchReview } from "../../../../consequential/ConsequentialSwitch";
import { keepRealLedger } from "../../../../consequential/ledgers";
import { useRunCost } from "../../../../consequential/useRunCost";
import { aboutWords, useRunDuration } from "../../../../../lib/line/runDuration";
import "./askBlock.css";

export type ProblemAnswer = "confirmed" | "dropped" | "waits";

/** A person's answer to grounding's question: confirmed starts it (with the note as its context), dropped closes it,
 *  waits parks it until more findings come (the note says so, word for word; lineNeeds waitNote). */
export function answerProblem(taskRef: string, how: ProblemAnswer, note = "") {
  const st = useInboxStore.getState();
  const said = note.trim();
  if (said) void st.addTaskComment(taskRef, said);
  void st.updateTask(taskRef, how === "confirmed" ? { readiness: "ready", readiness_note: said ? `Confirmed: ${said}` : "Confirmed by a person." } : how === "waits" ? { readiness: "needs_context", readiness_note: said } : { status: "dropped" });
}

/** What answering does next, from the project's admission (LJ6.2): "starts now", "queued behind 3" (`ahead` 3); `under`
 *  "off" when the project's line is off, so nothing starts until it is on. */
export function answerNext(a: LineAdmission | null | undefined, startable: boolean): { words: string | null; under: "off" | null; now: boolean; ahead: number | null } {
  if (!a) return { words: null, under: null, now: false, ahead: null };
  if (!a.on) return { words: null, under: "off", now: false, ahead: null };
  if (!startable) return { words: null, under: null, now: false, ahead: null };
  const free = Math.max(0, a.slots - (a.busy ?? 0));
  if (free > 0 && (startsAtOnce({ ...a, queued: (a.queued ?? 0) + 1 }) ?? 1) > (a.queued ?? 0)) return { words: "starts now", under: null, now: true, ahead: null };
  return { words: a.queued != null ? `queued behind ${a.queued}` : "queued", under: null, now: false, ahead: a.queued ?? null };
}

type AskTask = { goal_ref?: string | null; assignee?: string | null; project_id?: string | null; source?: string; title: string; description?: string | null };
const taskOf = (s: unknown, caseId: string | null | undefined) => (caseId ? ((s as { tasks?: Record<string, AskTask | undefined> }).tasks?.[caseId] ?? null) : null);

/** What answering a problem does next, read from its own project's admission (any surface: For you's reader, the
 *  problem's band). The button says only what it does; this is shown beside it. */
function useAnswerStart(caseId: string | null | undefined) {
  const task = useInboxStore((s) => taskOf(s, caseId));
  const projectId = task?.project_id ?? null;
  const project = useInboxStore((s) => (projectId ? (s.projects as Record<string, { title?: string } | undefined>)?.[projectId]?.title ?? null : null));
  const { admission } = useLineAdmission(projectId);
  return { ...answerNext(admission, !!task?.goal_ref && !task?.assignee), projectId, project };
}

/** Under the answers, on its own line: what an answer sets off. It starts work now, or after the problems queued ahead
 *  of it on its line; or it waits because that line is off, and the switch to turn it on sits here as its own act,
 *  apart from the answers, through the one review every line switch goes through (LineStartControl). `lead` names
 *  the answer ("An answer", "A yes"). */
function AnswerStart({ start, lead }: { start: ReturnType<typeof useAnswerStart>; lead: string }) {
  if (start.under === "off" && start.projectId) {
    return (
      <p className="ask-next" data-line-ask-start="off">
        <span>{lead} waits: {start.project ? `${start.project}'s` : "its"} line is off</span>
        <LineStartControl projectId={start.projectId} project={start.project ?? undefined} className="lw-link ask-turn-on" label="Turn it on…" triggerProps={{ "data-line-ask-turn-on": "" }} />
      </p>
    );
  }
  if (start.now) return <p className="ask-next" data-line-ask-start="now">{lead} starts work now</p>;
  if (start.ahead != null) return <p className="ask-next" data-line-ask-start="queued" title="Problems queued before it on its line">{start.ahead ? <>{lead} starts work after <b className="lw-num">{start.ahead}</b> {start.ahead === 1 ? "other" : "others"}</> : <>{lead} starts work next</>}</p>;
  return null;
}

const IS_REAL = "Is this a real problem?";

/** `question` is the ask itself (lineInbox askLine); `why` is grounding's whole note, of which only what the question
 *  leaves out shows under it. `asks`: the work holds on what a person knows, so an answer is required and goes with
 *  the problem as its context. Otherwise a new problem asks only whether it is real: one press says yes, a note is
 *  optional, and what grounding still does not know is shown as the open question beside it.
 *  The ask is read as a question (askAsQuestion); one that weighs alternatives offers each as a one-press answer.
 *  What answering sets off sits beside the button (AnswerStart). A problem opened on a finding that says nothing asks
 *  no question at all (findingEvidence): it reads "No supporting finding" and offers Close first. */
export function ProblemAsk({ question, why, taskRef, caseId, focus, asks }: { question: string; why?: string | null; taskRef: string | null; /** The problem's row id: its findings, for what the ask is about. */ caseId?: string | null; focus: boolean; asks: boolean }) {
  const start = useAnswerStart(caseId);
  const unsupported = useInboxStore((s) => restsOnNothing(taskOf(s, caseId)));
  const read = askAsQuestion(question);
  // A note stored cut at its cap ends mid-word: it is read to its last full sentence.
  const context = why ? askParts(wholeSentences(why)).context : null;
  // A question that names parts gets a field for each (askShape); one that weighs alternatives, a button for each.
  const shape = asks && !read.choices.length ? askShape(read.question) : { required: false, parts: [] as string[] };
  const [text, setText] = useState("");
  const [fields, setFields] = useState<string[]>(() => shape.parts.map(() => ""));
  const [sent, setSent] = useState<ProblemAnswer | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const focusAnswer = () => (shape.parts.length ? first.current : box.current)?.focus({ preventScroll: true });
  useWatchEffect(() => { if (focus) focusAnswer(); }, [focus]);
  if (!taskRef) return null;
  const note = shape.parts.length ? shape.parts.map((k, i) => (fields[i]?.trim() ? `${k}: ${fields[i].trim()}` : null)).filter(Boolean).join("\n") : text;
  const complete = shape.parts.length ? fields.every((f) => f.trim()) : !!text.trim();
  const answer = (how: ProblemAnswer, said = note) => {
    if (asks && how === "confirmed" && !said.trim()) { focusAnswer(); return; }
    answerProblem(taskRef, how, said);
    setSent(how);
  };
  const submitKey = (e: KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); answer("confirmed"); } };
  const open = !asks && read.question && read.question !== IS_REAL ? read.question : null;
  // A confirm whose open question weighs causes answers both at once: each cause is a yes ("Yes: truncated data"),
  // beside a yes for a cause it does not name and "Not a problem", so every press says whether it is real.
  const causes = asks ? [] : read.choices;
  const choices = asks ? read.choices : [];
  const causeWords = (c: { says: string; so: string | null }) => (c.so ? `${c.says} (${c.so})` : c.says);
  const withNote = (lead: string) => [lead, text.trim()].filter(Boolean).join("\n");
  if (unsupported && caseId) return <Unsupported caseId={caseId} sent={sent} onAnswer={(how) => answer(how, how === "confirmed" ? "Real, though its findings are empty." : "")} start={start} />;
  return (
    <section className="ask" data-line-ask={sent ?? "open"} data-line-ask-kind={asks ? "question" : "confirm"}>
      {/* A confirm that weighs causes asks its own question ("Is it true that the card's name set came from truncated
          data?"): each yes below answers it, so the generic "is it real" would hide what is being asked. */}
      <p className="ask-q" data-line-ask-q>{asks ? read.question : causes.length && open ? open : IS_REAL}</p>
      {/* Causes the yeses name already say what is unknown: the question heads the block then. */}
      {open && !causes.length && <p className="ask-open" data-line-ask-open><span>Still unknown</span>{open}</p>}
      {/* A question saved cut short: what survived is asked (askAsQuestion); having it asked again, whole, stays beside it. */}
      {/\u2026$/.test(question) && !sent && <AskWhole taskRef={taskRef} />}
      {caseId && <AskAbout caseId={caseId} ask={`${question}\n${why ?? ""}`} asked={asks ? read.question : open ?? ""} />}
      {sent ? (
        <div className="ask-done"><span className="lw-oc" data-tone={sent === "confirmed" ? "ok" : "none"}>{sent === "confirmed" ? (asks ? "Answered" : "Confirmed") : "Closed: not a problem"}</span></div>
      ) : (
        <>
          {choices.length > 0 && (
            <div className="ask-choices" role="group" aria-label="Answers" data-line-ask-choices={choices.length}>
              {choices.map((c) => (
                <button key={c.says} type="button" className="ask-choice" onClick={() => answer("confirmed", causeWords(c))} data-line-ask-choice>
                  <b>{c.says}</b>{c.so && <span>{c.so.charAt(0).toUpperCase() + c.so.slice(1)}</span>}
                </button>
              ))}
            </div>
          )}
          {shape.parts.length > 0 ? (
            <div className="ask-fields" data-line-ask-fields={shape.parts.length}>
              {shape.parts.map((k, i) => (
                <label key={k} className="ask-field">
                  <span>{k}</span>
                  <input ref={i === 0 ? first : undefined} value={fields[i] ?? ""} onChange={(e) => setFields(fields.map((f, j) => (j === i ? e.target.value : f)))} onKeyDown={submitKey} required data-line-ask-field={i} />
                </label>
              ))}
            </div>
          ) : (
            <textarea
              ref={box}
              className="ask-box"
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={submitKey}
              placeholder={!asks ? "A note for the run (optional)" : choices.length ? "Something else" : "Your answer"}
              aria-label={!asks ? "A note for the run" : choices.length ? "Another answer" : "Your answer"}
              required={asks && !choices.length}
              data-line-ask-box
            />
          )}
          {/* The typed answer has its own button, there whether or not one-press answers sit above it. */}
          <div className="ask-acts" data-line-ask-causes={causes.length || undefined}>
            {causes.map((c) => (
              <button key={c.says} type="button" className="ask-choice" onClick={() => answer("confirmed", withNote(`Real: ${causeWords(c)}`))} data-line-ask-choice data-line-ask-cause>
                <b>Yes: {c.says.charAt(0).toLowerCase() + c.says.slice(1)}</b>{c.so && <span>{c.so.charAt(0).toUpperCase() + c.so.slice(1)}</span>}
              </button>
            ))}
            {asks
              ? <button type="button" className="lw-act" data-primary={choices.length ? undefined : ""} disabled={!complete} onClick={() => answer("confirmed")} data-line-ask-confirm>{choices.length ? "Answer with this" : "Answer"}</button>
              : causes.length
                ? <button type="button" className="lw-act" onClick={() => answer("confirmed", withNote(causes.length === 1 ? "Real, another cause." : "Real, cause not known."))} data-line-ask-confirm>{causes.length === 1 ? "Yes, another cause" : "Yes, not sure which"}</button>
                : <button type="button" className="lw-act" data-primary="" onClick={() => answer("confirmed")} data-line-ask-confirm>Yes, it is real</button>}
            <button type="button" className="lw-act" onClick={() => answer("dropped", text)} data-line-ask-drop>Not a problem</button>
          </div>
          <AnswerStart start={start} lead={asks ? "An answer" : "A yes"} />
        </>
      )}
      {context && <details className="ask-why"><summary>Why it asks</summary><p>{context}</p></details>}
    </section>
  );
}

const supportSig = (s: ReaderSignal) => `${s._id}|${(s.detail_md ?? "").length}|${s.attach ?? ""}`;

/** A problem opened on a finding that says nothing: no question, only whether it is a problem, Close first. It says
 *  what its findings are: all empty, or the worded ones about something else (offTopicFindings), quoted by their first
 *  sentence; those are listed apart below with their move out first. Keeping it starts paid work, so "It is real"
 *  goes through the review (keepRealLedger): which run starts, when, its time and cost, how to stop it. */
function Unsupported({ caseId, sent, onAnswer, start }: { caseId: string; sent: ProblemAnswer | null; onAnswer: (how: ProblemAnswer) => void; start: ReturnType<typeof useAnswerStart> }) {
  useSyncTaskSignals(caseId);
  const where = useMemo(() => (s: ReaderSignal) => s.task_id === caseId, [caseId]);
  const rows = useCollectionRows<ReaderSignal>("signals", { where, sig: supportSig });
  const title = useInboxStore((s) => taskOf(s, caseId)?.title ?? "");
  const { empty } = useMemo(() => findingSupport(rows), [rows]);
  const off = useMemo(() => [...offTopicFindings(title, rows)], [title, rows]);
  const worded = rows.length - empty.size;
  const cost = useRunCost(start.projectId);
  const ms = useRunDuration(start.projectId);
  const [reviewing, setReviewing] = useState(false);
  const ledger = useMemo(() => keepRealLedger({
    problem: title, project: start.project, empty: empty.size, of: rows.length, now: start.now, ahead: start.ahead, off: start.under === "off", cost, about: ms ? aboutWords(ms) : null,
  }), [title, start, empty.size, rows.length, cost, ms]);
  const q = !rows.length ? "No supporting finding" : worded === 0 ? "Every finding is empty"
    : off.length === worded ? (worded === 1 ? "The one finding here is about something else" : `Its ${worded} findings are about something else`)
    : "The finding that opened it is empty";
  return (
    <section className="ask" data-line-ask={sent ?? "open"} data-line-ask-kind="unsupported">
      <p className="ask-q" data-line-ask-q>{q}</p>
      {off.slice(0, 2).map((s) => <blockquote key={s._id} className="ask-off" data-line-ask-off={s.short_id ?? s._id}>{firstSentence(s)}</blockquote>)}
      {sent ? (
        <div className="ask-done"><span className="lw-oc" data-tone={sent === "confirmed" ? "ok" : "none"}>{sent === "confirmed" ? "Kept as real" : "Closed: no evidence"}</span></div>
      ) : (
        <div className="ask-acts">
          <button type="button" className="lw-act" data-primary="" onClick={() => onAnswer("dropped")} data-line-ask-drop>Close: no evidence</button>
          <button type="button" className="lw-act" aria-haspopup="dialog" onClick={() => setReviewing(true)} data-line-ask-confirm>It is real…</button>
        </div>
      )}
      {reviewing && <SwitchReview ledger={ledger} onClose={() => setReviewing(false)} onConfirm={() => { setReviewing(false); onAnswer("confirmed"); }} />}
    </section>
  );
}

/** A finding's own first sentence, the expectation and bookkeeping aside: what it is about, at a glance. */
const firstSentence = (s: ReaderSignal) => {
  const text = findingBlocks({ ...s, evidence_url: null }).find((b) => b.kind === "text")?.text ?? "";
  return text.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? text;
};

/** Clears the problem's grounding, so the ground step reads its findings again and writes its question whole. */
function AskWhole({ taskRef }: { taskRef: string }) {
  const [asked, setAsked] = useState(false);
  if (asked) return <p className="ask-cut" data-line-ask-whole="asked"><span className="lw-oc" data-tone="live">Asking again</span></p>;
  return (
    <p className="ask-cut" data-line-ask-whole="open">
      <span>Cut short when it was saved</span>
      <button type="button" className="lw-link" onClick={() => { void useInboxStore.getState().updateTask(taskRef, { readiness: "", readiness_note: "" }); setAsked(true); }} title="The ground step reads the findings again and writes its question whole: one call to the strong model">Ask it again, whole</button>
      <span className="ask-cut-cost" data-line-ask-whole-cost>one model call</span>
    </p>
  );
}

const aboutSig = (s: ReaderSignal) => `${s._id}|${(s.detail_md ?? "").length}|${s.evidence_url ?? ""}`;

/** What the ask is about (LJ6.2): the finding whose words name the people the question does, in its own words, with
 *  where to look it up. A question about the whole problem names no one finding, and shows none. */
function AskAbout({ caseId, ask, asked }: { caseId: string; ask: string; /** The question as shown: the people it names are looked up. */ asked: string }) {
  useSyncTaskSignals(caseId);
  const where = useMemo(() => (s: ReaderSignal) => s.task_id === caseId, [caseId]);
  const rows = useCollectionRows<ReaderSignal>("signals", { where, sig: aboutSig });
  const about = useMemo(() => askedAbout(ask, rows), [ask, rows]);
  // The people the question itself names, looked up in the app's history: whether they are still about is a fact there.
  const people = useMemo(() => [...namesIn(asked)].slice(0, 2), [asked]);
  if (!about.length && !people.length) return null;
  return (
    <div className="ask-about" data-line-ask-about={about.length}>
      <span className="ask-about-h">What this asks about</span>
      {about.map((s) => {
        const words = findingBlocks(s).filter((b) => b.kind === "text" || b.kind === "quote");
        return (
          <div key={s._id} className="ask-about-f" data-line-ask-about-finding={s.short_id ?? s._id}>
            {words.map((b, i) => b.kind === "quote" ? <figure key={i} className="fr-quote"><figcaption>{quoteSource(s.source)}</figcaption><blockquote>{b.text}</blockquote></figure> : <p key={i}>{b.text}</p>)}
            {s.evidence_url && <a className="lw-link" href={s.evidence_url} target="_blank" rel="noreferrer">{evidenceLinkWords(s.evidence_url)}<ArrowUpRight className="w-3 h-3" aria-hidden /></a>}
          </div>
        );
      })}
      {people.map((name) => <PersonLookup key={name} name={name} />)}
    </div>
  );
}

/** A person a question names, as the app's history last mentions them: the newest activities naming them, each with
 *  its date, where and the words around the name, and each opens in place to the whole activity. Nothing when the app
 *  has no such reader or nothing names them. */
function PersonLookup({ name }: { name: string }) {
  const read = useAppRead(CALL_APP, HISTORY_SEARCH.name, { [HISTORY_SEARCH.query]: name, [HISTORY_SEARCH.limit]: LOOKUP_HITS });
  const hits = useMemo(() => (read?.ok ? readHistoryHits(read.text, name) : []), [read, name]);
  if (!read) return <div className="ask-person" data-line-ask-person={name} data-state="loading"><span className="lw-spin" aria-hidden /> {name} in Union's history</div>;
  if (!hits.length) return <div hidden data-line-ask-person={name} data-state="none" title={read.ok ? "nothing names them" : read.error} />;
  return (
    <div className="ask-person" data-line-ask-person={name} data-state="ready">
      <span className="ask-person-h"><b>{name}</b> in Union's history · last named <b>{dayWords(hits[0].at)}</b></span>
      <ol>
        {hits.map((h, i) => <PersonHit key={h.id ?? i} hit={h} />)}
      </ol>
    </div>
  );
}

/** One activity naming the person: its date and the words around the name; pressed, the whole of it as the app holds
 *  it (HISTORY_ITEM), read only once it is opened. An activity the app gave no id for stays its words. */
function PersonHit({ hit }: { hit: HistoryHit }) {
  const [open, setOpen] = useState(false);
  const item = useAppRead(CALL_APP, HISTORY_ITEM.name, { [HISTORY_ITEM.item]: hit.id }, open && !!hit.id);
  const whole = item?.ok ? readHistoryItem(item.text) : null;
  if (!hit.id) return <li><span className="ask-person-at">{dayWords(hit.at)}</span><span>{hit.words}</span></li>;
  return (
    <li data-open={open || undefined} data-line-ask-person-hit={hit.id}>
      <button type="button" className="ask-person-hit" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight className="ask-person-chev" aria-hidden />
        <span className="ask-person-at">{dayWords(hit.at)}</span>
        {/* Open, the whole activity below says it all. */}
        <span>{open ? null : hit.words}</span>
      </button>
      {open && (
        <div className="ask-person-item" data-line-ask-person-item={item ? (item.ok ? "ready" : "failed") : "loading"}>
          {!item ? <span className="lw-spin" aria-hidden /> : whole ? <p>{whole}</p> : <span className="ask-person-fail">{item.ok ? "Empty in Union" : `Union did not open it: ${item.error}`}</span>}
          {hit.where && <span className="ask-person-where">{hit.where}</span>}
        </div>
      )}
    </li>
  );
}

const LOOKUP_HITS = 4;
const dayWords = (at: string) => new Date(at.replace(" ", "T")).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

"use client";
// The Ask block (line-journeys.md LJ6.2): the question a problem holds on, in
// full, with the answer box and its two outcomes. An answer marks the problem
// ready with the answer as its context (the sweep starts it); "Not a problem"
// closes it.
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpRight } from "lucide-react";
import { useInboxStore } from "../../../../../store/inboxStore";
import { useCollectionRows } from "../../../../../hooks/useCollectionRows";
import { useSyncTaskSignals } from "../../../../../hooks/useSyncSignals";
import { quoteSource, type ReaderSignal } from "../../../widgets/FindingReader";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import { askAsQuestion, askParts } from "../../../../../lib/line/lineInbox";
import type { LineAdmission } from "../../../../../lib/lineFlow";
import { startsAtOnce } from "../../../map/LineStartSwitch";
import { useLineAdmission } from "../../../map/useLineAdmission";
import { askedAbout, askShape, evidenceLinkWords, findingBlocks, wholeSentences } from "../../../../../lib/line/problemPage";
import { findingSupport, restsOnNothing } from "../../../../../lib/line/findingEvidence";
import { LineStartControl } from "../../../../consequential/lineStart";
import "./askBlock.css";

export type ProblemAnswer = "confirmed" | "dropped";

/** A person's answer to grounding's question: confirmed starts it (with the note as its context), dropped closes it. */
export function answerProblem(taskRef: string, how: ProblemAnswer, note = "") {
  const st = useInboxStore.getState();
  const said = note.trim();
  if (said) void st.addTaskComment(taskRef, said);
  void st.updateTask(taskRef, how === "confirmed" ? { readiness: "ready", readiness_note: said ? `Confirmed: ${said}` : "Confirmed by a person." } : { status: "dropped" });
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
  if (unsupported && caseId) return <Unsupported caseId={caseId} sent={sent} onAnswer={(how) => answer(how, how === "confirmed" ? "Real, though its findings are empty." : "")} start={start} />;
  return (
    <section className="ask" data-line-ask={sent ?? "open"} data-line-ask-kind={asks ? "question" : "confirm"}>
      <p className="ask-q" data-line-ask-q>{asks ? read.question : IS_REAL}</p>
      {open && <p className="ask-open" data-line-ask-open><span>Still unknown</span>{open}</p>}
      {/* A question saved cut short cannot be answered as written: the act is to have it asked again, whole. */}
      {/\u2026$/.test(asks ? read.question : open ?? "") && !sent && <AskWhole taskRef={taskRef} />}
      {caseId && <AskAbout caseId={caseId} ask={`${question}\n${why ?? ""}`} />}
      {sent ? (
        <div className="ask-done"><span className="lw-oc" data-tone={sent === "confirmed" ? "ok" : "none"}>{sent === "confirmed" ? (asks ? "Answered" : "Confirmed") : "Closed: not a problem"}</span></div>
      ) : (
        <>
          {read.choices.length > 0 && (
            <div className="ask-choices" role="group" aria-label="Answers" data-line-ask-choices={read.choices.length}>
              {read.choices.map((c) => (
                <button key={c.says} type="button" className="ask-choice" onClick={() => answer("confirmed", c.so ? `${c.says} (${c.so})` : c.says)} data-line-ask-choice>
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
              placeholder={!asks ? "A note for the run (optional)" : read.choices.length ? "Something else" : "Your answer"}
              aria-label={!asks ? "A note for the run" : read.choices.length ? "Another answer" : "Your answer"}
              required={asks && !read.choices.length}
              data-line-ask-box
            />
          )}
          {/* The typed answer has its own button, there whether or not one-press answers sit above it. */}
          <div className="ask-acts">
            {asks
              ? <button type="button" className="lw-act" data-primary={read.choices.length ? undefined : ""} disabled={!complete} onClick={() => answer("confirmed")} data-line-ask-confirm>{read.choices.length ? "Answer with this" : "Answer"}</button>
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

/** A problem opened on a finding that says nothing: no question, only whether it is a problem, Close first. The
 *  figure is its findings that say nothing of all it holds; the findings themselves are listed below it. */
function Unsupported({ caseId, sent, onAnswer, start }: { caseId: string; sent: ProblemAnswer | null; onAnswer: (how: ProblemAnswer) => void; start: ReturnType<typeof useAnswerStart> }) {
  useSyncTaskSignals(caseId);
  const where = useMemo(() => (s: ReaderSignal) => s.task_id === caseId, [caseId]);
  const rows = useCollectionRows<ReaderSignal>("signals", { where, sig: supportSig });
  const { empty } = useMemo(() => findingSupport(rows), [rows]);
  return (
    <section className="ask" data-line-ask={sent ?? "open"} data-line-ask-kind="unsupported">
      <p className="ask-q" data-line-ask-q>No supporting finding</p>
      {rows.length > 0 && <p className="ask-empty" data-line-ask-empty={empty.size}><b className="lw-num">{empty.size} of {rows.length}</b> findings empty</p>}
      {sent ? (
        <div className="ask-done"><span className="lw-oc" data-tone={sent === "confirmed" ? "ok" : "none"}>{sent === "confirmed" ? "Kept as real" : "Closed: no evidence"}</span></div>
      ) : (
        <div className="ask-acts">
          <button type="button" className="lw-act" data-primary="" onClick={() => onAnswer("dropped")} data-line-ask-drop>Close: no evidence</button>
          <button type="button" className="lw-act" onClick={() => onAnswer("confirmed")} data-line-ask-confirm>It is real</button>
        </div>
      )}
      {!sent && <AnswerStart start={start} lead="Keeping it" />}
    </section>
  );
}

/** Clears the problem's grounding, so the ground step reads its findings again and writes its question whole. */
function AskWhole({ taskRef }: { taskRef: string }) {
  const [asked, setAsked] = useState(false);
  if (asked) return <p className="ask-cut" data-line-ask-whole="asked"><span className="lw-oc" data-tone="live">Asking again</span></p>;
  return (
    <p className="ask-cut" data-line-ask-whole="open">
      <span>Cut short when it was saved</span>
      <button type="button" className="lw-link" onClick={() => { void useInboxStore.getState().updateTask(taskRef, { readiness: "", readiness_note: "" }); setAsked(true); }}>Ask it again, whole</button>
    </p>
  );
}

const aboutSig = (s: ReaderSignal) => `${s._id}|${(s.detail_md ?? "").length}|${s.evidence_url ?? ""}`;

/** What the ask is about (LJ6.2): the finding whose words name the people the question does, in its own words, with
 *  where to look it up. A question about the whole problem names no one finding, and shows none. */
function AskAbout({ caseId, ask }: { caseId: string; ask: string }) {
  useSyncTaskSignals(caseId);
  const where = useMemo(() => (s: ReaderSignal) => s.task_id === caseId, [caseId]);
  const rows = useCollectionRows<ReaderSignal>("signals", { where, sig: aboutSig });
  const about = useMemo(() => askedAbout(ask, rows), [ask, rows]);
  if (!about.length) return null;
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
    </div>
  );
}
